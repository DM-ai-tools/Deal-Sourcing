/**
 * One run, start to finish.
 *
 * Two phases with a hard boundary between them: DISCOVER reads and stores, then
 * CONTACT sends. Keeping them apart is what makes a run safe to stop, safe to
 * resume, and safe to inspect before anything irreversible happens — a dry run
 * is simply a run whose second phase declines to press the button.
 *
 * All progress lives in the database rather than in memory. If the container
 * restarts mid-sweep the dashboard tells the same story afterwards as before,
 * and the next run picks up the listings that were never contacted instead of
 * starting again.
 */
import { prisma, getSettings, countSentToday } from './db.js';
import { makeTransport, makeBrowserTransport, type TransportConfig } from './transport.js';
import { buildSearchUrls, newestFirst, paginate, type SearchFilters } from './search-url.js';
import {
  extractSearchResults,
  extractListingDetail,
  mergeListing,
  withinFinancialRange,
  type ExtractedListing,
} from './extract.js';
import { login, sendEnquiry, sendDelayMs, renderMessage } from './outreach.js';
import { syncToSheet } from './sheets.js';

/** Result pages per starting URL. Twenty-five listings a page. */
const MAX_PAGES_PER_URL = 20;

/**
 * How many armed attempts one listing gets before it is left alone.
 *
 * High enough that a transient block or a slow render does not cost a deal,
 * low enough that a listing whose form is genuinely broken cannot be retried
 * every run forever — and low enough that if a crash ever does cause a repeat,
 * a broker sees a handful of messages rather than an unbounded stream.
 */
const MAX_SEND_ATTEMPTS = 3;

/**
 * How many listing pages a NON-sending run may spend on financial enrichment.
 *
 * Unbounded, this was six hundred requests per run against the one endpoint
 * BizBuySell rate-limits hardest. Even with nothing else competing, that is
 * more than the site tolerates and more than the data is worth.
 */
const ENRICH_PAGE_BUDGET = 60;
/** Politeness between reads. The site is not ours to hammer. */
const READ_DELAY_MS = 1500;

const running = new Map<string, AbortController>();

export function isRunning(runId: string): boolean {
  return running.has(runId);
}

export function stopRun(runId: string): boolean {
  const controller = running.get(runId);
  if (!controller) return false;
  controller.abort();
  return true;
}

async function log(
  runId: string,
  message: string,
  level: 'info' | 'warn' | 'error' = 'info',
  detail?: unknown,
) {
  await prisma.runEvent
    .create({ data: { runId, level, message: message.slice(0, 500), detail: detail as object } })
    .catch(() => {});
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Execute a run.
 *
 * Never throws to the caller: a run that fails records why and finishes as
 * 'failed'. An unhandled rejection here would take down the web server that
 * the operator needs in order to find out what happened.
 */
export async function executeRun(runId: string): Promise<void> {
  const controller = new AbortController();
  running.set(runId, controller);

  try {
    const run = await prisma.run.findUnique({ where: { id: runId }, include: { search: true } });
    if (!run?.search) throw new Error('Run or its search no longer exists');

    const settings = await getSettings();
    const transportConfig: TransportConfig = {
      transport: settings.transport as TransportConfig['transport'],
      proxyServer: settings.proxyServer,
      proxyUsername: settings.proxyUsername,
      proxyPassword: settings.proxyPassword,
    };

    const filters: SearchFilters = {
      states: (run.search.states as string[]) ?? [],
      industries: (run.search.industries as string[]) ?? [],
      cashFlowMin: run.search.cashFlowMin,
      cashFlowMax: run.search.cashFlowMax,
      revenueMin: run.search.revenueMin,
      revenueMax: run.search.revenueMax,
      askingPriceMin: run.search.askingPriceMin,
      askingPriceMax: run.search.askingPriceMax,
      excludeAuctions: run.search.excludeAuctions,
    };

    // ---- phase 1: discover ------------------------------------------------
    await prisma.run.update({
      where: { id: runId },
      data: { status: 'discovering', transport: settings.transport },
    });

    // Both switches, same rule the contact phase uses: a run only sends if it
    // was armed AND the master switch is on.
    const willSend = settings.sendingEnabled && !run.dryRun;
    const discovered = await discover(runId, filters, transportConfig, controller.signal, willSend);

    if (controller.signal.aborted) {
      await finish(runId, 'stopped', 'Stopped during discovery.');
      return;
    }

    // ---- persist ----------------------------------------------------------
    //
    // One unwritable listing must not take the run with it. A single value that
    // overflowed a column threw here, unwrapped, and the whole run died — three
    // hours of crawling discarded, nothing contacted, and the cause buried in a
    // Prisma stack trace on the run record. A bad row is a bad row: log it,
    // skip it, keep the other forty-five.
    let created = 0;
    let skipped = 0;
    for (const listing of discovered) {
      try {
        created += await persistListing(listing, run.searchId);
      } catch (err) {
        skipped++;
        await log(
          runId,
          `Could not save "${listing.title}" — ${(err as Error).message.split('\n').pop()?.slice(0, 160)}`,
          'warn',
        );
      }
    }

    if (skipped) await log(runId, `${skipped} listing(s) could not be saved and were skipped.`, 'warn');

    await prisma.run.update({
      where: { id: runId },
      data: { listingsFound: discovered.length, listingsNew: created },
    });
    await log(runId, `Discovery finished: ${discovered.length} listings, ${created} new.`);

    // ---- phase 2: contact -------------------------------------------------
    await prisma.run.update({ where: { id: runId }, data: { status: 'contacting' } });
    await contact(runId, run.dryRun, transportConfig, controller.signal);

    // After contacting, so the sheet reflects what was actually sent.
    await syncSheet(runId).catch(() => {});

    await finish(runId, controller.signal.aborted ? 'stopped' : 'done');
  } catch (err) {
    await log(runId, `Run failed: ${(err as Error).message}`, 'error');
    await finish(runId, 'failed', (err as Error).message.slice(0, 500));
  } finally {
    running.delete(runId);
  }
}

/** Write one listing. Returns 1 if it was new, 0 if it already existed. */
async function persistListing(listing: ExtractedListing, searchId: string): Promise<number> {
  const existing = await prisma.listing.findUnique({ where: { listingId: listing.listingId } });

  if (existing) {
    // Refresh the figures — an asking price can drop — but never the status.
    await prisma.listing.update({
      where: { id: existing.id },
      data: {
        askingPrice: listing.askingPrice ?? existing.askingPrice,
        grossRevenue: listing.grossRevenue ?? existing.grossRevenue,
        cashFlow: listing.cashFlow ?? existing.cashFlow,
        ebitda: listing.ebitda ?? existing.ebitda,
        brokerName: listing.brokerName ?? existing.brokerName,
        datePosted: listing.datePosted ?? existing.datePosted,
      },
    });
    return 0;
  }

  await prisma.listing.create({
    data: {
      listingId: listing.listingId,
      searchId,
      title: listing.title,
      url: listing.url,
      location: listing.location,
      askingPrice: listing.askingPrice,
      grossRevenue: listing.grossRevenue,
      cashFlow: listing.cashFlow,
      ebitda: listing.ebitda,
      established: listing.established,
      brokerName: listing.brokerName,
      brokerPhone: listing.brokerPhone,
      datePosted: listing.datePosted,
      isAuction: listing.isAuction,
      raw: listing as unknown as object,
    },
  });
  return 1;
}

/**
 * Push the tracker to the Google Sheet.
 *
 * Best-effort by design: a run that found forty listings has done its job, and
 * a Google API hiccup must not turn that into a failed run. The error is logged
 * against the run and stored on Settings so the dashboard can show it.
 */
async function syncSheet(runId: string): Promise<void> {
  const settings = await getSettings();
  if (!settings.sheetsEnabled || !settings.googleCredentials || !settings.sheetId) return;

  const listings = await prisma.listing.findMany({
    orderBy: [{ contactedAt: 'desc' }, { firstSeenAt: 'desc' }],
    include: { outreach: { select: { status: true, sentAt: true } } },
  });

  const result = await syncToSheet(
    settings.googleCredentials,
    settings.sheetId,
    listings.map((l) => {
      const sent = l.outreach.find((o) => o.status === 'sent');
      return {
        title: l.title,
        url: l.url,
        location: l.location,
        datePosted: l.datePosted,
        askingPrice: l.askingPrice,
        grossRevenue: l.grossRevenue,
        cashFlow: l.cashFlow,
        ebitda: l.ebitda,
        brokerName: l.brokerName,
        brokerPhone: l.brokerPhone,
        messageSent: Boolean(sent),
        sentAt: sent?.sentAt ?? l.contactedAt,
        responded: Boolean(l.respondedAt),
        respondedAt: l.respondedAt,
        responseNote: l.responseNote,
        status: l.status,
        firstSeenAt: l.firstSeenAt,
      };
    }),
  );

  await prisma.settings
    .update({
      where: { id: 1 },
      data: {
        sheetsLastSyncedAt: result.ok ? new Date() : undefined,
        sheetsLastError: result.ok ? null : (result.error ?? 'unknown error'),
      },
    })
    .catch(() => {});

  await log(
    runId,
    result.ok ? `Google Sheet updated — ${result.rows} rows.` : `Google Sheet sync failed: ${result.error}`,
    result.ok ? 'info' : 'warn',
  );
}

async function finish(runId: string, status: string, error?: string) {
  await prisma.run
    .update({ where: { id: runId }, data: { status, error, finishedAt: new Date() } })
    .catch(() => {});
}

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

async function discover(
  runId: string,
  filters: SearchFilters,
  config: TransportConfig,
  signal: AbortSignal,
  /** True when this run will send. Decides how listing-page budget is spent. */
  willSend: boolean,
): Promise<ExtractedListing[]> {
  const transport = makeTransport(config);
  const byId = new Map<string, ExtractedListing>();
  let pagesRead = 0;
  let blockedPages = 0;

  try {
    const startingUrls = buildSearchUrls(filters);
    await log(runId, `Searching ${startingUrls.length} category/location combinations.`);

    for (const base of startingUrls) {
      if (signal.aborted) break;

      for (let page = 1; page <= MAX_PAGES_PER_URL; page++) {
        if (signal.aborted) break;

        const url = paginate(base, page);
        const result = await transport.fetch(url);
        pagesRead++;

        if (!result.ok || !result.html) {
          if (result.blocked) blockedPages++;
          // Page 1 failing is a real problem; a later page failing usually just
          // means the result set ended.
          if (page === 1) {
            await log(
              runId,
              `Could not read ${url} — ${result.reason ?? 'unknown'}`,
              result.blocked ? 'error' : 'warn',
            );
          }
          // Record the attempt even though it failed. This used to update only
          // on the success path, so a run whose pages were all being refused
          // sat with a frozen counter and looked identical to one making steady
          // progress — which is exactly how a stalled run was read as healthy
          // for eighty minutes.
          await prisma.run.update({ where: { id: runId }, data: { pagesRead } }).catch(() => {});
          break;
        }

        const listings = extractSearchResults(result.html);
        if (listings.length === 0) break; // past the last page

        let added = 0;
        for (const listing of listings) {
          if (filters.excludeAuctions !== false && listing.isAuction) continue;
          if (!withinFinancialRange(listing, filters)) continue;
          if (!byId.has(listing.listingId)) {
            byId.set(listing.listingId, listing);
            added++;
          }
        }

        await prisma.run.update({ where: { id: runId }, data: { pagesRead } }).catch(() => {});
        if (added === 0) break; // nothing new on this page — the set has repeated
        await sleep(READ_DELAY_MS);
      }
    }

    if (blockedPages > 0 && byId.size === 0) {
      await log(
        runId,
        `Every search page was refused by the site (${blockedPages} blocked). This is Akamai ` +
          `bot protection, not a fault in the app. Change the transport in Settings and try again.`,
        'error',
      );
    }

    // Enrich from detail pages — but never at the cost of sending.
    //
    // Listing-page loads are the scarce resource here. BizBuySell serves search
    // pages freely and rate-limits listing pages hard, and this loop used to
    // fetch one for EVERY listing missing an EBITDA or a broker name: six
    // hundred requests, back to back, to fill optional columns. By the time the
    // contact phase started, the budget was gone — discovery reported 605
    // listings found and then all twenty sends failed with
    // ERR_HTTP_RESPONSE_CODE_FAILURE, including the login. A single test send
    // twenty minutes earlier had worked fine.
    //
    // The `detailFailures >= 5` guard below did not save it, because it counts
    // CONSECUTIVE failures and resets on every success — so a run can grind
    // through hundreds of successful fetches and still exhaust the quota.
    //
    // So: an armed run skips enrichment entirely. The financials are
    // best-effort and the card data already carries asking price and cash flow,
    // which is what the buy-box filters on. Contacting a broker is the job;
    // filling in an EBITDA column is not worth losing it for. A dry run still
    // enriches, capped, because nothing is competing for the budget.
    const detailBudget = willSend ? 0 : ENRICH_PAGE_BUDGET;

    const needsDetail = [...byId.values()]
      .filter((l) => l.grossRevenue == null || l.ebitda == null || l.brokerName == null)
      .slice(0, detailBudget);

    if (willSend) {
      await log(
        runId,
        'Skipping detail enrichment — saving the listing-page budget for sending.',
      );
    }

    if (needsDetail.length && !signal.aborted) {
      await log(runId, `Reading ${needsDetail.length} listing pages for full financials.`);
      let detailFailures = 0;

      for (const listing of needsDetail) {
        if (signal.aborted) break;
        if (detailFailures >= 5) {
          await log(runId, 'Listing pages are being refused — keeping the figures from the result cards.', 'warn');
          break;
        }

        const result = await transport.fetch(listing.url);
        if (!result.ok || !result.html) {
          detailFailures++;
          continue;
        }
        detailFailures = 0;
        byId.set(listing.listingId, mergeListing(listing, extractListingDetail(result.html, listing.url)));
        await sleep(READ_DELAY_MS);
      }
    }

    return [...byId.values()];
  } finally {
    await transport.close();
  }
}

// ---------------------------------------------------------------------------
// Contact
// ---------------------------------------------------------------------------

async function contact(
  runId: string,
  dryRun: boolean,
  config: TransportConfig,
  signal: AbortSignal,
): Promise<void> {
  const settings = await getSettings();

  // Both switches must agree. The run asking to send is not enough on its own.
  //
  // And when a local agent is doing the sending, the server does not — not
  // "sends less", not "sends as a fallback". BizBuySell refuses this host's IP,
  // so every attempt from here fails anyway, but the real reason is stricter
  // than that: two senders working one queue is how a broker gets messaged
  // twice, and no amount of claiming logic is worth betting a relationship on
  // when the server contributes nothing.
  const armed = settings.sendingEnabled && !dryRun && !settings.agentEnabled;

  if (settings.sendingEnabled && !dryRun && settings.agentEnabled) {
    await log(
      runId,
      'Sending is handled by the local agent — this run discovered and recorded only. ' +
        'Listings stay queued for the agent to pick up.',
    );
    // Stop here. This said the right thing and then did the opposite.
    //
    // Without the return it fell straight into the contact loop with
    // armed=false, which opens a browser and loads EVERY queued listing page
    // just to fill a form it will not submit. Against a site that refuses this
    // host that is 549 blocked page loads, seven minutes of work and a wall of
    // warnings, repeated on every scheduled run — for a result the agent
    // produces anyway. The queue is already written by discovery; there is
    // nothing left for the server to do.
    return;
  }

  if (!settings.fullName || !settings.email) {
    await log(runId, 'No contact name or email in Settings — nothing can be sent.', 'error');
    return;
  }

  // Which listings are still worth contacting.
  //
  // This used to read `outreach: { none: {} }` — no outreach row at all. That
  // is wrong, and it was silently fatal. A row is written BEFORE the send is
  // attempted, so anything that touched a listing claimed it forever: a dry
  // run, a failed attempt, a crash. After the forty-four sends that failed on
  // the old form selectors, forty-four of forty-six listings had a 'failed' row
  // and were therefore invisible to every future run. Arming the system would
  // have found two listings, sent to them, and then gone quiet for good — with
  // no error anywhere, because from the query's point of view there was simply
  // nothing left to do.
  //
  // Only two things should retire a listing: a message that actually went out,
  // or a retry budget spent. A failure is a reason to try again, not a
  // tombstone.
  const pending = await prisma.listing.findMany({
    where: {
      status: 'new',
      isAuction: false,
      outreach: {
        none: { OR: [{ status: 'sent' }, { attempts: { gte: MAX_SEND_ATTEMPTS } }] },
      },
    },
    // Ordered again below. The database cannot do it: listingId is a string
    // column, so SQL would sort "999" above "2541692".
    orderBy: { firstSeenAt: 'asc' },
  });

  // Newest listings first.
  //
  // A business posted this week is still choosing who to talk to; one that has
  // sat for six months has already heard from everybody, and its broker is the
  // least likely to answer. With a cap of twenty a day and hundreds waiting,
  // the order decides which conversations actually happen — so freshest first
  // is not a nicety, it is most of the value.
  //
  // Recency comes from the listing id, because BizBuySell publishes no date
  // anywhere on the pages we read. See postedRecency() for the measurement
  // behind that.
  pending.sort(newestFirst);

  if (pending.length === 0) {
    await log(runId, 'No new listings to contact.');
    return;
  }

  const sentToday = await countSentToday();
  const remainingToday = Math.max(0, settings.dailyCap - sentToday);
  const batch = armed ? pending.slice(0, remainingToday) : pending;

  if (armed && batch.length < pending.length) {
    await log(
      runId,
      `Daily cap: ${sentToday}/${settings.dailyCap} already sent today, so ${pending.length - batch.length} ` +
        `listings are held over to the next run.`,
      'warn',
    );
  }

  await log(
    runId,
    armed
      ? `Sending to ${batch.length} listings.`
      : `DRY RUN — preparing ${batch.length} messages. Nothing will be sent.`,
  );

  const transport = makeBrowserTransport(config);
  let sent = 0;
  let failed = 0;
  // Consecutive blocks. Reset by any send that actually reaches the form.
  let blockedInARow = 0;

  try {
    // Signing in is an optimisation, not a requirement.
    //
    // A real enquiry was accepted while signed out — the site replied "Your
    // message has been sent to Gregory Kovsky" — which makes sense, because the
    // form asks for a name, phone and email precisely so anonymous buyers can
    // use it. Meanwhile the login page is more heavily defended than the
    // listing pages and frequently refuses to render its form at all.
    //
    // Treating login as mandatory therefore meant the one step that reliably
    // fails could veto every step that reliably works: a whole armed run would
    // abort having sent nothing. Try it, because a signed-in session may still
    // help with rate limits and attribution — but never let it stop the send.
    if (armed && settings.bizbuysellEmail && settings.bizbuysellPassword) {
      const auth = await login(transport, {
        email: settings.bizbuysellEmail,
        password: settings.bizbuysellPassword,
      });
      await log(
        runId,
        auth.ok
          ? 'Signed in.'
          : `Could not sign in (${auth.error}) — sending anyway, which the site accepts.`,
        auth.ok ? 'info' : 'warn',
      );
    }

    for (const listing of batch) {
      if (signal.aborted) break;

      // One listing must never end the run.
      //
      // The persist loop had exactly this shape, and a single overflowing value
      // killed an entire armed run three hours in, having contacted nobody.
      // Everything below touches the network or the database, so any of it can
      // throw — and when it does, the other forty-five listings are still worth
      // sending to.
      try {
        // Re-read the master switch on every listing.
      //
      // `armed` used to be computed once, before the loop. That was survivable
      // when a human had to start a run deliberately, but arming now STARTS a
      // run — so the switch reads as "start sending" and, to anyone who has
      // just watched it do that, equally as "stop sending". It has to mean
      // both. A toggle that begins messaging strangers and then cannot call
      // them back is the wrong shape for the one control that matters, and the
      // moment someone wants it off is exactly the moment it must work.
      if (armed) {
        const now = await getSettings();
        if (!now.sendingEnabled) {
          await log(runId, 'Sending was switched off — stopping after ' + sent + ' sent.', 'warn');
          break;
        }
      }

      const message = renderMessage(settings.messageTemplate, listing);

      // Claim the listing before sending.
      //
      // `listingId` is unique, so there is at most one row per listing and
      // claiming means either creating it or taking over one that exists but
      // was never sent. The old code did the first and gave up on the second,
      // which is how a single failed attempt became permanent.
      //
      // Attempts are only spent when actually armed. A dry run rehearses the
      // whole path and must not eat into the retry budget for the real thing.
      let claimed: { id: string } | null = null;
      try {
        claimed = await prisma.outreach.create({
          data: {
            listingId: listing.id,
            runId,
            status: 'prepared',
            messageBody: message,
            fullName: settings.fullName,
            email: settings.email,
            phone: settings.phone,
            attempts: armed ? 1 : 0,
          },
        });
      } catch (err) {
        // Only a unique-constraint collision means "someone already has this".
        // Any other database error was being read as that and skipped in
        // silence, so a connection drop or a schema mismatch would look
        // exactly like an orderly run with nothing left to do.
        const code = (err as { code?: string }).code;
        if (code && code !== 'P2002') {
          await log(runId, `Could not claim ${listing.title}: ${code}`, 'error');
          continue;
        }

        // A row already exists. Take it over — but only if it was never sent
        // and still has budget. The status guard lives in the WHERE clause, so
        // this is one conditional UPDATE and two writers cannot both win it.
        //
        // 'claimed' is included deliberately: a row left in that state means a
        // previous run died mid-send, and it is genuinely unknown whether the
        // message went out. Retrying risks a duplicate; not retrying
        // guarantees the listing is never contacted again. The attempts cap
        // bounds the first risk, and silence has already proved to be the
        // costlier failure here.
        const taken = await prisma.outreach.updateMany({
          where: {
            listingId: listing.id,
            status: { in: ['prepared', 'failed', 'claimed'] },
            attempts: { lt: MAX_SEND_ATTEMPTS },
          },
          data: {
            status: 'claimed',
            runId,
            messageBody: message,
            ...(armed ? { attempts: { increment: 1 } } : {}),
          },
        });
        if (taken.count === 0) continue; // sent already, or out of retries

        claimed = await prisma.outreach.findUnique({
          where: { listingId: listing.id },
          select: { id: true },
        });
        if (!claimed) continue;
      }

      const outcome = await sendEnquiry(
        transport,
        listing.url,
        {
          fullName: settings.fullName,
          email: settings.email,
          phone: settings.phone,
          message,
        },
        armed,
      );

      // `attempts` is not written here — it was already spent at claim time, and
      // setting it to a literal 1 (as this used to) reset the counter on every
      // pass, so the retry cap could never actually be reached.
      if (outcome.ok && armed) {
        sent++;
        await prisma.outreach.update({
          where: { id: claimed.id },
          data: { status: 'sent', sentAt: new Date(), confirmation: outcome.confirmation },
        });
        await prisma.listing.update({
          where: { id: listing.id },
          data: { status: 'email_sent', contactedAt: new Date() },
        });
      } else if (outcome.ok) {
        await prisma.outreach.update({
          where: { id: claimed.id },
          data: { status: 'prepared', confirmation: outcome.confirmation, screenshot: outcome.screenshot },
        });
      } else {
        failed++;

        // Being blocked is not the listing's fault, so it must not cost the
        // listing an attempt.
        //
        // Attempts are spent at claim time, before the outcome is known, and
        // three spent attempts retire a listing for good. On a day when
        // BizBuySell refuses everything — as it did today, all twelve search
        // pages and all twenty sends — the scheduler would burn twenty listings
        // per run against a wall it never reached, and inside three days sixty
        // businesses would be permanently marked as tried and never contacted.
        // The retry budget exists for listings whose form is genuinely broken,
        // not for the days the site says no to everyone.
        const blocked = /blocked by the site|ERR_HTTP_RESPONSE_CODE_FAILURE|ERR_CONNECTION|net::|NS_ERROR|bot wall|never rendered|timed out waiting for the browser/i.test(
          outcome.error ?? '',
        );

        await prisma.outreach.update({
          where: { id: claimed.id },
          data: {
            status: 'failed',
            error: outcome.error,
            screenshot: outcome.screenshot,
            ...(blocked && armed ? { attempts: { decrement: 1 } } : {}),
          },
        });
        await log(
          runId,
          `${listing.title}: ${outcome.error}${blocked ? ' (blocked — attempt refunded)' : ''}`,
          'warn',
        );

        // Stop early when the site is plainly refusing everyone.
        //
        // Today's run spent three hours failing all twenty in turn, waiting four
        // to ten minutes between each. That is time wasted and, worse, twenty
        // more requests aimed at a site already saying no — which is how a soft
        // block becomes a hard one. Three refusals in a row is enough to
        // conclude it is not this listing, it is us.
        if (blocked && ++blockedInARow >= 3) {
          await log(
            runId,
            `Stopping: ${blockedInARow} listings refused in a row, so the site is blocking this ` +
              `address rather than failing on individual listings. Nothing was consumed — these ` +
              `listings keep their retry budget and are first in line next run.`,
            'error',
          );
          break;
        }
      }

      if (outcome.ok) blockedInARow = 0;

      await prisma.run
        .update({ where: { id: runId }, data: { messagesSent: sent, messagesFailed: failed } })
        .catch(() => {});

        if (armed && !signal.aborted) {
          await sleep(sendDelayMs(settings.minDelaySeconds, settings.maxDelaySeconds));
        }
      } catch (err) {
        failed++;
        await log(
          runId,
          `${listing.title}: ${(err as Error).message.split('\n')[0]?.slice(0, 160)}`,
          'error',
        );
      }
    }
  } finally {
    await transport.close();
  }

  await log(runId, armed ? `Sent ${sent}, failed ${failed}.` : `Prepared ${batch.length} messages (dry run).`);
}

/**
 * Restore sanity after a restart.
 *
 * A run marked 'discovering' with no process behind it is a lie the dashboard
 * would otherwise keep telling. Called once at boot.
 */
export async function reconcileOrphanedRuns(): Promise<number> {
  const orphans = await prisma.run.findMany({
    where: { status: { in: ['queued', 'discovering', 'contacting'] } },
    select: { id: true },
  });

  for (const run of orphans) {
    if (running.has(run.id)) continue;
    await prisma.run.update({
      where: { id: run.id },
      data: {
        status: 'stopped',
        error: 'Interrupted by a restart. Nothing was lost — start a new run to continue.',
        finishedAt: new Date(),
      },
    });
  }
  return orphans.length;
}

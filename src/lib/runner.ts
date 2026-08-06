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
import { buildSearchUrls, paginate, type SearchFilters } from './search-url.js';
import {
  extractSearchResults,
  extractListingDetail,
  mergeListing,
  withinFinancialRange,
  type ExtractedListing,
} from './extract.js';
import { login, sendEnquiry, sendDelayMs, renderMessage } from './outreach.js';

/** Result pages per starting URL. Twenty-five listings a page. */
const MAX_PAGES_PER_URL = 20;
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

    const discovered = await discover(runId, filters, transportConfig, controller.signal);

    if (controller.signal.aborted) {
      await finish(runId, 'stopped', 'Stopped during discovery.');
      return;
    }

    // ---- persist ----------------------------------------------------------
    let created = 0;
    for (const listing of discovered) {
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
          },
        });
        continue;
      }
      await prisma.listing.create({
        data: {
          listingId: listing.listingId,
          searchId: run.searchId,
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
          isAuction: listing.isAuction,
          raw: listing as unknown as object,
        },
      });
      created++;
    }

    await prisma.run.update({
      where: { id: runId },
      data: { listingsFound: discovered.length, listingsNew: created },
    });
    await log(runId, `Discovery finished: ${discovered.length} listings, ${created} new.`);

    // ---- phase 2: contact -------------------------------------------------
    await prisma.run.update({ where: { id: runId }, data: { status: 'contacting' } });
    await contact(runId, run.dryRun, transportConfig, controller.signal);

    await finish(runId, controller.signal.aborted ? 'stopped' : 'done');
  } catch (err) {
    await log(runId, `Run failed: ${(err as Error).message}`, 'error');
    await finish(runId, 'failed', (err as Error).message.slice(0, 500));
  } finally {
    running.delete(runId);
  }
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

    // Enrich from detail pages where the transport can reach them. Best-effort
    // by design: the tracker is already useful from card data alone.
    const needsDetail = [...byId.values()].filter(
      (l) => l.grossRevenue == null || l.ebitda == null || l.brokerName == null,
    );

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
  const armed = settings.sendingEnabled && !dryRun;

  if (!settings.fullName || !settings.email) {
    await log(runId, 'No contact name or email in Settings — nothing can be sent.', 'error');
    return;
  }

  const pending = await prisma.listing.findMany({
    where: {
      status: 'new',
      isAuction: false,
      outreach: { none: {} }, // the database's own guarantee, restated as a query
    },
    orderBy: { firstSeenAt: 'asc' },
  });

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

  try {
    if (armed) {
      if (!settings.bizbuysellEmail || !settings.bizbuysellPassword) {
        await log(runId, 'Sending is armed but no BizBuySell login is configured.', 'error');
        return;
      }
      const auth = await login(transport, {
        email: settings.bizbuysellEmail,
        password: settings.bizbuysellPassword,
      });
      if (!auth.ok) {
        await log(runId, `Could not sign in: ${auth.error}`, 'error');
        return;
      }
      await log(runId, 'Signed in.');
    }

    for (const listing of batch) {
      if (signal.aborted) break;

      const message = renderMessage(settings.messageTemplate, listing);

      // Claim the listing first. If this insert loses a race, the other run
      // owns it and this one moves on — which is the entire point of the
      // unique constraint.
      let claimed;
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
          },
        });
      } catch {
        continue; // already claimed
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

      if (outcome.ok && armed) {
        sent++;
        await prisma.outreach.update({
          where: { id: claimed.id },
          data: { status: 'sent', sentAt: new Date(), attempts: 1, confirmation: outcome.confirmation },
        });
        await prisma.listing.update({
          where: { id: listing.id },
          data: { status: 'email_sent', contactedAt: new Date() },
        });
      } else if (outcome.ok) {
        await prisma.outreach.update({
          where: { id: claimed.id },
          data: { status: 'prepared', attempts: 1, confirmation: outcome.confirmation, screenshot: outcome.screenshot },
        });
      } else {
        failed++;
        await prisma.outreach.update({
          where: { id: claimed.id },
          data: { status: 'failed', attempts: 1, error: outcome.error, screenshot: outcome.screenshot },
        });
        await log(runId, `${listing.title}: ${outcome.error}`, 'warn');
      }

      await prisma.run
        .update({ where: { id: runId }, data: { messagesSent: sent, messagesFailed: failed } })
        .catch(() => {});

      if (armed && !signal.aborted) {
        await sleep(sendDelayMs(settings.minDelaySeconds, settings.maxDelaySeconds));
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

/**
 * Web server: JSON API plus the dashboard.
 *
 * One process, one container, no build step for the front end. The dashboard is
 * a single static page served from disk — nothing to bundle means nothing to
 * break on deploy, which matters more here than any framework would.
 */
import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import { z } from 'zod';
import { env, envProblems } from './lib/env.js';
import {
  prisma,
  probeDatabase,
  getSettings,
  countSentToday,
  ensureDefaultSearch,
  resolveActiveSearch,
} from './lib/db.js';
import { executeRun, stopRun, isRunning, reconcileOrphanedRuns } from './lib/runner.js';
import { startScheduler, maybeRunDailyScan } from './lib/scheduler.js';
import {
  checkReachability,
  checkMode,
  makeBrowserTransport,
  type TransportConfig,
} from './lib/transport.js';
import { INDUSTRIES, STATES, DEFAULT_INDUSTRIES, buildSearchUrls } from './lib/search-url.js';
import { DEFAULT_MESSAGE, renderMessage, sendEnquiry } from './lib/outreach.js';
import { syncToSheet, testSheet, createSheet, type SheetRow } from './lib/sheets.js';
import { testInbox, checkInbox, guessImapHost } from './lib/inbox.js';

const here = path.dirname(fileURLToPath(import.meta.url));

/**
 * Where `public/` actually is.
 *
 * In development this file runs from src/, in production from dist/src/ — so a
 * fixed '../public' is right in one and silently wrong in the other. Wrong here
 * means a container that boots, passes its healthcheck and serves 404 for every
 * page, which looks like a deploy problem and is not. Walk up until the folder
 * is found instead of assuming a depth.
 */
function findPublicDir(): string {
  let dir = here;
  for (let up = 0; up < 5; up++) {
    const candidate = path.join(dir, 'public');
    if (existsSync(path.join(candidate, 'index.html'))) return candidate;
    dir = path.dirname(dir);
  }
  return path.join(process.cwd(), 'public');
}

const PUBLIC_DIR = findPublicDir();
const app = express();

app.use(express.json({ limit: '2mb' }));
app.use(express.static(PUBLIC_DIR));

const ok = <T>(res: express.Response, data: T) => res.json({ ok: true, ...data });
const fail = (res: express.Response, message: string, code = 400) =>
  res.status(code).json({ ok: false, error: message });

/**
 * A route parameter as a plain string.
 *
 * Express's types allow an array here because a path can repeat a name. Ours
 * never do, but the compiler cannot know that, and threading the union through
 * every handler would be noise.
 */
const param = (req: express.Request, name: string): string => {
  const value = (req.params as Record<string, string | string[] | undefined>)[name];
  return Array.isArray(value) ? (value[0] ?? '') : (value ?? '');
};

/** Route wrapper so a thrown error becomes a readable 500, never a dead socket. */
const handle =
  (fn: (req: express.Request, res: express.Response) => Promise<unknown>) =>
  (req: express.Request, res: express.Response) => {
    fn(req, res).catch((err: Error) => {
      console.error(`[api] ${req.method} ${req.path}:`, err.message);
      if (!res.headersSent) fail(res, err.message, 500);
    });
  };

// ---------------------------------------------------------------------------
// Health
// ---------------------------------------------------------------------------

app.get(
  '/api/health',
  handle(async (_req, res) => {
    const problems = envProblems();
    const db = await probeDatabase();
    if (!db.ok) problems.push(`database: ${db.detail}`);

    // Always 200 while the process can serve. A healthcheck that 5xx's because
    // one variable is unset tells nobody anything; this one names the fault.
    res.status(200).json({
      status: problems.length ? 'degraded' : 'ok',
      service: 'bizbuysell-crawler',
      database: db.ok ? 'ok' : 'unreachable',
      problems,
      node: process.version,
      uptimeSeconds: Math.round(process.uptime()),
    });
  }),
);

// ---------------------------------------------------------------------------
// Reference data
// ---------------------------------------------------------------------------

app.get('/api/meta', (_req, res) => {
  ok(res, { industries: INDUSTRIES, states: STATES, defaultIndustries: DEFAULT_INDUSTRIES });
});

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

const settingsSchema = z.object({
  fullName: z.string().max(120).optional(),
  email: z.string().max(200).optional(),
  phone: z.string().max(60).optional(),
  messageTemplate: z.string().max(8000).optional(),
  sendingEnabled: z.boolean().optional(),
  dailyCap: z.number().int().min(1).max(500).optional(),
  minDelaySeconds: z.number().int().min(5).max(3600).optional(),
  maxDelaySeconds: z.number().int().min(6).max(7200).optional(),
  transport: z.enum(['firecrawl', 'local', 'proxy', 'camoufox', 'auto']).optional(),
  bizbuysellEmail: z.string().max(200).nullable().optional(),
  bizbuysellPassword: z.string().max(200).nullable().optional(),
  proxyServer: z.string().max(300).nullable().optional(),
  proxyUsername: z.string().max(200).nullable().optional(),
  proxyPassword: z.string().max(200).nullable().optional(),
  sheetsEnabled: z.boolean().optional(),
  sheetId: z.string().max(200).nullable().optional(),
  googleCredentials: z.string().max(20000).nullable().optional(),
  dailyScanEnabled: z.boolean().optional(),
  scanHourUtc: z.number().int().min(0).max(23).optional(),
  activeSearchId: z.string().max(60).nullable().optional(),
  inboxEnabled: z.boolean().optional(),
  inboxHost: z.string().max(200).nullable().optional(),
  inboxPort: z.number().int().min(1).max(65535).optional(),
  inboxUser: z.string().max(200).nullable().optional(),
  inboxPassword: z.string().max(300).nullable().optional(),
  inboxProvider: z.enum(['imap', 'graph']).optional(),
  inboxFilterTo: z.string().max(200).nullable().optional(),
  graphTenantId: z.string().max(100).nullable().optional(),
  graphClientId: z.string().max(100).nullable().optional(),
  graphClientSecret: z.string().max(300).nullable().optional(),
});

app.get(
  '/api/settings',
  handle(async (_req, res) => {
    const settings = await getSettings();
    ok(res, {
      settings: {
        ...settings,
        // Never send secrets back to the browser; report only whether they exist.
        bizbuysellPassword: undefined,
        proxyPassword: undefined,
        googleCredentials: undefined,
        inboxPassword: undefined,
        graphClientSecret: undefined,
        hasInbox: Boolean(
          settings.inboxProvider === 'graph'
            ? settings.graphTenantId && settings.graphClientId && settings.graphClientSecret
            : settings.inboxUser && settings.inboxPassword,
        ),
        hasLogin: Boolean(settings.bizbuysellEmail && settings.bizbuysellPassword),
        hasProxy: Boolean(settings.proxyServer),
        hasGoogle: Boolean(settings.googleCredentials && settings.sheetId),
      },
      sentToday: await countSentToday(),
    });
  }),
);

app.put(
  '/api/settings',
  handle(async (req, res) => {
    const parsed = settingsSchema.safeParse(req.body);
    if (!parsed.success) return fail(res, parsed.error.issues[0]?.message ?? 'Invalid settings');

    const before = await getSettings();
    const data = { ...parsed.data };
    // Blank means "leave it alone", not "erase it" — the form never receives
    // the current secret, so an empty field is absence of input.
    if (!data.bizbuysellPassword) delete data.bizbuysellPassword;
    if (!data.proxyPassword) delete data.proxyPassword;
    if (!data.googleCredentials) delete data.googleCredentials;
    if (!data.inboxPassword) delete data.inboxPassword;
    if (!data.graphClientSecret) delete data.graphClientSecret;

    // Fill the IMAP host from the address when it is a provider with a fixed
    // one, so the common case needs a username and password and nothing else.
    if (data.inboxUser && !data.inboxHost) {
      data.inboxHost = guessImapHost(data.inboxUser) ?? undefined;
    }

    const updated = await prisma.settings.update({ where: { id: 1 }, data });

    // Switching sending ON starts a live run, because that is what the switch
    // is understood to mean. Arming a system that then waits to be told to go
    // is the kind of gap where someone believes messages are going out for a
    // week and they are not.
    //
    // Only on the false → true edge: saving an unrelated setting while sending
    // is already on must not kick off a second run. And only when nothing is
    // already running — the runs endpoint refuses concurrent runs for the same
    // reason, and this must not be the way around that.
    let started: { id: string } | null = null;
    let armingNote: string | null = null;
    const justArmed = !before.sendingEnabled && updated.sendingEnabled;

    if (justArmed) {
      const active = await prisma.run.findFirst({
        where: { status: { in: ['queued', 'discovering', 'contacting'] } },
      });
      // The search the operator chose, not one inferred from a timestamp.
      // Both guesses were wrong in turn — see resolveActiveSearch().
      const search = await resolveActiveSearch();

      if (active) {
        armingNote = 'Sending is on, but a run is already in progress — it will send as it goes.';
      } else if (!search) {
        armingNote = 'Sending is on, but there is no search configured, so there is nothing to run.';
      } else {
        started = await prisma.run.create({
          data: { searchId: search.id, dryRun: false, transport: updated.transport },
        });
        // Not awaited: the switch should feel instant, and the run reports its
        // own progress through the database.
        void executeRun(started.id);
      }
    }

    ok(res, {
      settings: {
        ...updated,
        bizbuysellPassword: undefined,
        proxyPassword: undefined,
        googleCredentials: undefined,
        inboxPassword: undefined,
        graphClientSecret: undefined,
      },
      startedRunId: started?.id ?? null,
      armingNote,
    });
  }),
);

app.post(
  '/api/settings/test-transport',
  handle(async (req, res) => {
    const settings = await getSettings();
    const config: TransportConfig = {
      transport: settings.transport as TransportConfig['transport'],
      proxyServer: settings.proxyServer,
      proxyUsername: settings.proxyUsername,
      proxyPassword: settings.proxyPassword,
    };

    // An explicit mode lets the operator test one at a time instead of waiting
    // for a chain to walk every browser — which is what turned this endpoint
    // into a 502 on the deployed container.
    const asked = z
      .object({ mode: z.enum(['firecrawl', 'local', 'proxy', 'camoufox', 'auto']).optional() })
      .safeParse(req.body ?? {});
    const mode = asked.success && asked.data.mode ? asked.data.mode : config.transport;

    ok(res, { result: await checkReachability({ ...config, transport: mode }) });
  }),
);

/**
 * Inbox monitoring — is the mailbox reachable, and what has arrived?
 *
 * Separate routes on purpose: "are these credentials right" and "read the new
 * mail" fail for entirely different reasons, and one endpoint reporting both
 * would make a wrong password look like a matching problem.
 */
app.post(
  '/api/inbox/test',
  handle(async (_req, res) => ok(res, { result: await testInbox() })),
);

app.post(
  '/api/inbox/check',
  handle(async (_req, res) => ok(res, { result: await checkInbox() })),
);

/**
 * Create the client's Google Sheet, fill it, share it, and return the link.
 *
 * One call, because the alternative is a person opening sheets.new, pasting a
 * formula and hand-colouring two rules — fine for whoever built this, wrong for
 * something handed to a client. A manual step between "the system found 615
 * businesses" and "here is the link" is where client-facing work gets forgotten
 * or done differently each time.
 *
 * The sheet is populated before the response returns, so the link is never
 * handed over pointing at an empty document.
 */
app.post(
  '/api/sheets/create',
  handle(async (req, res) => {
    const body = z
      .object({
        title: z.string().max(120).optional(),
        shareWith: z.array(z.string().max(200)).max(10).default([]),
        anyoneWithLink: z.boolean().default(true),
      })
      .safeParse(req.body ?? {});
    if (!body.success) return fail(res, 'Invalid request');

    const settings = await getSettings();
    if (!settings.googleCredentials) {
      return fail(
        res,
        'No Google service-account key saved. Paste the JSON key into Settings first — that is ' +
          'the one-time step; everything after it is automatic.',
      );
    }

    const created = await createSheet(settings.googleCredentials, {
      title: body.data.title || 'BizBuySell Deal Flow',
      shareWith: body.data.shareWith,
      anyoneWithLink: body.data.anyoneWithLink,
    });

    // Remember it and switch syncing on, so every future run keeps it current
    // without anyone coming back here.
    await prisma.settings.update({
      where: { id: 1 },
      data: { sheetId: created.sheetId, sheetsEnabled: true },
    });

    // Fill it before answering. A link handed to a client that opens on an
    // empty document is worse than no link.
    const listings = await prisma.listing.findMany({
      orderBy: [{ contactedAt: 'desc' }, { firstSeenAt: 'desc' }],
      include: { outreach: { select: { status: true, sentAt: true } } },
    });

    const rows: SheetRow[] = listings.map((l) => {
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
    });

    const sync = await syncToSheet(settings.googleCredentials, created.sheetId, rows);
    await prisma.settings.update({
      where: { id: 1 },
      data: { sheetsLastSyncedAt: new Date(), sheetsLastError: sync.ok ? null : sync.error ?? null },
    });

    ok(res, { created, rows: sync.rows, warning: created.warning ?? (sync.ok ? undefined : sync.error) });
  }),
);

/**
 * Forget every stored message and read the window again.
 *
 * Needed because ingestion can run before it has been scoped, and it did:
 * monitoring was switched on against a build that predated `inboxFilterTo`, so
 * a poll read the whole seven-day window of a mailbox belonging to a person and
 * wrote thirty unrelated messages — account notices, invoices, a supplier's
 * newsletter — into a deal database, bodies included.
 *
 * Nothing could remove them. Third-party mail stored by mistake has to be
 * deletable without a database console, so this is a first-class operation
 * rather than a query someone runs by hand.
 *
 * Listing.respondedAt is deliberately left alone: a reply logged by a person is
 * indistinguishable from one set by the monitor, and destroying someone's
 * manual work to tidy up after an automated mistake is the worse error.
 */
app.post(
  '/api/inbox/reset',
  handle(async (req, res) => {
    const body = z.object({ days: z.number().int().min(0).max(90).default(7) }).safeParse(req.body ?? {});
    const days = body.success ? body.data.days : 7;

    const deleted = await prisma.reply.deleteMany({});
    await prisma.settings.update({
      where: { id: 1 },
      data: {
        // Rewind so the same window is read again — this time through the filter.
        inboxWatermark: new Date(Date.now() - days * 24 * 60 * 60 * 1000),
        inboxLastUid: 0,
        inboxLastError: null,
      },
    });

    ok(res, {
      deleted: deleted.count,
      detail:
        `Deleted ${deleted.count} stored message(s) and rewound ${days} day(s). The next check ` +
        `re-reads that window with the current filter applied.`,
    });
  }),
);

/** Everything that arrived, matched or not. Unmatched is the row that matters. */
app.get(
  '/api/replies',
  handle(async (_req, res) => {
    const replies = await prisma.reply.findMany({
      orderBy: { receivedAt: 'desc' },
      take: 200,
      include: { listing: { select: { id: true, title: true, url: true } } },
    });
    ok(res, {
      replies,
      unmatched: replies.filter((r) => !r.listingId && !r.isAutoReply && !r.isBounce).length,
    });
  }),
);

/**
 * Attach a reply to a listing by hand.
 *
 * Matching is deliberately conservative — a broker with several listings is
 * genuinely ambiguous and the monitor refuses to guess — so there has to be a
 * way for a person to say which one it was.
 */
app.post(
  '/api/replies/:id/assign',
  handle(async (req, res) => {
    const body = z.object({ listingId: z.string().min(1) }).safeParse(req.body);
    if (!body.success) return fail(res, 'listingId is required');

    const reply = await prisma.reply.update({
      where: { id: param(req, 'id') },
      data: { listingId: body.data.listingId, matchedBy: 'manual' },
    });
    await prisma.listing.update({
      where: { id: body.data.listingId },
      data: { respondedAt: reply.receivedAt, responseNote: (reply.snippet ?? '').slice(0, 480) },
    });
    ok(res, { reply });
  }),
);

/**
 * Run today's scan now, rather than waiting for the hour.
 *
 * `force` skips the hour check and the once-a-day guard, which is what "run it
 * now" has to mean — but not the already-in-progress check, because two
 * concurrent runs would fight over the same browser profile.
 */
app.post(
  '/api/run-daily-scan',
  handle(async (req, res) => {
    const force = z.object({ force: z.boolean().default(false) }).safeParse(req.body ?? {});
    ok(res, { outcome: await maybeRunDailyScan(force.success && force.data.force) });
  }),
);

/**
 * Prove the SEND path without sending anything.
 *
 * `test-transport` only proves the site can be READ. Reading and writing have
 * failed independently here more than once: Chrome reads nothing from Railway
 * while Camoufox reads fine, and the form fill was silently filling nothing
 * long after reading worked perfectly. A green transport test has already
 * coexisted with forty-four failed sends.
 *
 * So this drives the real `sendEnquiry` with `armed = false` over the transport
 * that is actually configured: it navigates, finds the fields, fills them,
 * reads them back, locates the submit control — and stops. Everything the real
 * send does except press the button. If this reports ok, arming will work; if
 * it does not, arming would have burned a listing to find out.
 */
app.post(
  '/api/settings/test-send',
  handle(async (req, res) => {
    const settings = await getSettings();
    const asked = z
      .object({ url: z.string().url().optional() })
      .safeParse(req.body ?? {});

    // A specific listing if given, otherwise the next one a run would contact —
    // so this tests the same page the real thing would hit next.
    const listing = asked.success && asked.data.url
      ? { url: asked.data.url, title: 'Test listing' }
      : // Same predicate the runner uses, so this tests the page the real run
        // would hit next — not a listing it would never reach.
        await prisma.listing.findFirst({
          where: {
            status: 'new',
            isAuction: false,
            outreach: { none: { OR: [{ status: 'sent' }, { attempts: { gte: 3 } }] } },
          },
          orderBy: { firstSeenAt: 'asc' },
          select: { url: true, title: true },
        });

    if (!listing) return fail(res, 'No uncontacted listing to test against. Run a discovery first.');
    if (!settings.fullName || !settings.email) {
      return fail(res, 'Set a contact name and email in Settings first.');
    }

    const transport = makeBrowserTransport({
      transport: settings.transport as TransportConfig['transport'],
      proxyServer: settings.proxyServer,
      proxyUsername: settings.proxyUsername,
      proxyPassword: settings.proxyPassword,
    });

    try {
      const outcome = await sendEnquiry(
        transport,
        listing.url,
        {
          fullName: settings.fullName,
          email: settings.email,
          phone: settings.phone,
          message: renderMessage(settings.messageTemplate, listing),
        },
        false, // never armed — this endpoint cannot send, by construction
      );
      ok(res, { listing: listing.title, url: listing.url, mode: settings.transport, outcome });
    } finally {
      await transport.close().catch(() => {});
    }
  }),
);

/**
 * Test every mode and report which ones actually return data.
 *
 * Sequential and individually time-boxed. Browsers are heavy and the Chrome
 * profile is exclusive, so running them at once is not an option — but each one
 * gets a hard budget, so the whole sweep finishes rather than hanging.
 */
app.post(
  '/api/settings/test-all-modes',
  handle(async (_req, res) => {
    const settings = await getSettings();
    const config: TransportConfig = {
      transport: settings.transport as TransportConfig['transport'],
      proxyServer: settings.proxyServer,
      proxyUsername: settings.proxyUsername,
      proxyPassword: settings.proxyPassword,
    };

    const modes: TransportConfig['transport'][] = ['local', 'camoufox', 'firecrawl'];
    if (settings.proxyServer) modes.push('proxy');

    const verdicts = [];
    for (const mode of modes) {
      verdicts.push(await checkMode(mode, config, 75_000));
    }

    const working = verdicts.filter((v) => v.verdict === 'works').map((v) => v.mode);
    ok(res, {
      verdicts,
      working,
      recommendation: working.length
        ? `Use "${working[0]}" — or leave it on Automatic, which will pick it.`
        : 'No mode returned data from here. The browser needs to run somewhere this site trusts, ' +
          'or behind residential proxies.',
    });
  }),
);

// ---------------------------------------------------------------------------
// Google Sheet mirror
// ---------------------------------------------------------------------------

/** Every listing, shaped for the sheet. One query, no N+1. */
async function sheetRows(): Promise<SheetRow[]> {
  const listings = await prisma.listing.findMany({
    orderBy: [{ contactedAt: 'desc' }, { firstSeenAt: 'desc' }],
    include: { outreach: { select: { status: true, sentAt: true } } },
  });

  return listings.map((l) => {
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
      // "Sent" means an outreach row reached 'sent'. A prepared-but-unsent dry
      // run must never show as contacted — that is the difference between a
      // rehearsal and a real message, and the sheet is where people will look.
      messageSent: Boolean(sent),
      sentAt: sent?.sentAt ?? l.contactedAt,
      responded: Boolean(l.respondedAt),
      respondedAt: l.respondedAt,
      responseNote: l.responseNote,
      status: l.status,
      firstSeenAt: l.firstSeenAt,
    };
  });
}

app.post(
  '/api/sheets/test',
  handle(async (_req, res) => {
    const settings = await getSettings();
    if (!settings.googleCredentials || !settings.sheetId) {
      return fail(res, 'Add the service-account JSON and the sheet ID first.');
    }
    ok(res, { result: await testSheet(settings.googleCredentials, settings.sheetId) });
  }),
);

app.post(
  '/api/sheets/sync',
  handle(async (_req, res) => {
    const settings = await getSettings();
    if (!settings.googleCredentials || !settings.sheetId) {
      return fail(res, 'Add the service-account JSON and the sheet ID first.');
    }

    const result = await syncToSheet(settings.googleCredentials, settings.sheetId, await sheetRows());

    await prisma.settings.update({
      where: { id: 1 },
      data: {
        sheetsLastSyncedAt: result.ok ? new Date() : settings.sheetsLastSyncedAt,
        sheetsLastError: result.ok ? null : (result.error ?? 'unknown error'),
      },
    });

    ok(res, { result });
  }),
);

// ---------------------------------------------------------------------------
// Searches
// ---------------------------------------------------------------------------

const searchSchema = z.object({
  name: z.string().min(1).max(120),
  states: z.array(z.string().length(2)).default([]),
  industries: z.array(z.string()).default([]),
  cashFlowMin: z.number().int().nullable().optional(),
  cashFlowMax: z.number().int().nullable().optional(),
  revenueMin: z.number().int().nullable().optional(),
  revenueMax: z.number().int().nullable().optional(),
  askingPriceMin: z.number().int().nullable().optional(),
  askingPriceMax: z.number().int().nullable().optional(),
  excludeAuctions: z.boolean().default(true),
});

app.get(
  '/api/searches',
  handle(async (_req, res) => {
    ok(res, {
      searches: await prisma.search.findMany({
        orderBy: { createdAt: 'desc' },
        include: { _count: { select: { runs: true, listings: true } } },
      }),
    });
  }),
);

app.post(
  '/api/searches',
  handle(async (req, res) => {
    const parsed = searchSchema.safeParse(req.body);
    if (!parsed.success) return fail(res, parsed.error.issues[0]?.message ?? 'Invalid search');
    const search = await prisma.search.create({ data: parsed.data });
    ok(res, { search, urls: buildSearchUrls(parsed.data) });
  }),
);

app.put(
  '/api/searches/:id',
  handle(async (req, res) => {
    const parsed = searchSchema.partial().safeParse(req.body);
    if (!parsed.success) return fail(res, 'Invalid search');
    ok(res, { search: await prisma.search.update({ where: { id: param(req, 'id') }, data: parsed.data }) });
  }),
);

app.delete(
  '/api/searches/:id',
  handle(async (req, res) => {
    await prisma.search.delete({ where: { id: param(req, 'id') } });
    ok(res, {});
  }),
);

/** What the filters expand to, before committing to a run. */
app.post(
  '/api/searches/preview',
  handle(async (req, res) => {
    const parsed = searchSchema.omit({ name: true }).safeParse(req.body);
    if (!parsed.success) return fail(res, 'Invalid filters');
    const urls = buildSearchUrls(parsed.data);
    ok(res, { urls, count: urls.length });
  }),
);

// ---------------------------------------------------------------------------
// Runs
// ---------------------------------------------------------------------------

app.get(
  '/api/runs',
  handle(async (_req, res) => {
    const runs = await prisma.run.findMany({
      orderBy: { startedAt: 'desc' },
      take: 40,
      include: { search: { select: { name: true } } },
    });
    ok(res, { runs: runs.map((r) => ({ ...r, live: isRunning(r.id) })) });
  }),
);

app.post(
  '/api/runs',
  handle(async (req, res) => {
    const body = z
      .object({ searchId: z.string(), dryRun: z.boolean().default(true) })
      .safeParse(req.body);
    if (!body.success) return fail(res, 'searchId is required');

    const active = await prisma.run.findFirst({
      where: { status: { in: ['queued', 'discovering', 'contacting'] } },
    });
    if (active) {
      return fail(res, 'A run is already in progress. Stop it before starting another.', 409);
    }

    const settings = await getSettings();
    // Belt and braces: a run can only be live if the master switch is also on.
    const dryRun = body.data.dryRun || !settings.sendingEnabled;

    const run = await prisma.run.create({
      data: { searchId: body.data.searchId, dryRun, transport: settings.transport },
    });

    // Deliberately not awaited — the HTTP response returns immediately and the
    // run reports its progress through the database.
    void executeRun(run.id);

    ok(res, { run, dryRun });
  }),
);

app.post(
  '/api/runs/:id/stop',
  handle(async (req, res) => {
    ok(res, { stopped: stopRun(param(req, 'id')) });
  }),
);

app.get(
  '/api/runs/:id',
  handle(async (req, res) => {
    const run = await prisma.run.findUnique({
      where: { id: param(req, 'id') },
      include: {
        search: { select: { name: true } },
        events: { orderBy: { createdAt: 'desc' }, take: 100 },
      },
    });
    if (!run) return fail(res, 'Run not found', 404);
    ok(res, { run: { ...run, live: isRunning(run.id) } });
  }),
);

// ---------------------------------------------------------------------------
// Tracker
// ---------------------------------------------------------------------------

const STATUSES = [
  'new',
  'email_sent',
  // Set by the inbox monitor when a broker actually answers. It stops there on
  // purpose: reading "we'd need an NDA first" as nda_signed is a guess, and
  // every status past this one belongs to whoever is working the deal.
  'replied',
  'nda_signed',
  'cim_sent',
  'in_progress',
  'loi_sent',
  'deal_flow',
  'rejected',
] as const;

app.get(
  '/api/listings',
  handle(async (req, res) => {
    const status = String(req.query.status ?? '');
    const search = String(req.query.q ?? '').trim();

    const listings = await prisma.listing.findMany({
      where: {
        ...(status && status !== 'all' ? { status } : {}),
        ...(search ? { title: { contains: search, mode: 'insensitive' as const } } : {}),
      },
      orderBy: [{ contactedAt: 'desc' }, { firstSeenAt: 'desc' }],
      take: 1000,
      include: { outreach: { select: { status: true, sentAt: true, error: true } } },
    });

    const counts = await prisma.listing.groupBy({ by: ['status'], _count: true });
    ok(res, {
      listings,
      counts: Object.fromEntries(counts.map((c) => [c.status, c._count])),
      statuses: STATUSES,
    });
  }),
);

app.patch(
  '/api/listings/:id',
  handle(async (req, res) => {
    const body = z
      .object({
        status: z.enum(STATUSES).optional(),
        notes: z.string().max(4000).optional(),
        responseNote: z.string().max(8000).optional(),
        responded: z.boolean().optional(),
      })
      .safeParse(req.body);
    if (!body.success) return fail(res, 'Invalid update');

    const { responded, ...fields } = body.data;
    const data: Record<string, unknown> = { ...fields };

    // Marking a reply is a timestamp, not just a flag — the sheet and the
    // tracker both show WHEN, and a boolean would lose that.
    if (responded === true) data.respondedAt = new Date();
    if (responded === false) data.respondedAt = null;
    // Recording what they said is itself evidence they replied.
    if (fields.responseNote && responded === undefined) data.respondedAt = new Date();

    ok(res, { listing: await prisma.listing.update({ where: { id: param(req, 'id') }, data }) });
  }),
);

/**
 * The tracker as CSV, in the column order the client gave.
 *
 * One builder, two routes: the dashboard's download button wants an attachment,
 * and Google Sheets' IMPORTDATA wants to read the body. Same bytes either way —
 * if these ever drifted, the sheet and the exported file would disagree about
 * what was sent, which is the one thing a tracker cannot afford.
 */
const TRACKER_HEADERS = [
  'Listing Name', 'Link', 'Date Listed', 'Asking Price', 'Gross Revenue',
  'Cash Flow (SDE)', 'EBITDA', 'Broker', 'Broker Phone',
  'Message Sent', 'Sent At', 'Responded', 'Responded At', 'Their Response', 'Status',
] as const;

/**
 * The tracker as plain values — one source for the CSV and the web view.
 *
 * Both exist because a browser downloads text/csv rather than showing it, so a
 * link meant for reading and a link meant for Google Sheets cannot be the same
 * URL. They must not be able to disagree about what was sent, so they share
 * this rather than each building their own rows.
 */
async function trackerRows(): Promise<{ values: string[][]; sent: number; replied: number }> {
  const listings = await prisma.listing.findMany({
    orderBy: [{ contactedAt: 'desc' }, { firstSeenAt: 'desc' }],
    include: { outreach: { select: { status: true, sentAt: true } } },
  });

  // Marked UTC, because it is. Stripping the 'Z' and saying nothing left a
  // reader in the US five to eight hours out with no way to tell — which
  // matters when deciding whether a broker has had time to reply.
  const stamp = (value: Date | null | undefined) =>
    value ? `${new Date(value).toISOString().slice(0, 16).replace('T', ' ')} UTC` : '';

  let sent = 0;
  let replied = 0;

  const values = listings.map((l) => {
    const outreach = l.outreach.find((o) => o.status === 'sent');
    if (outreach) sent++;
    if (l.respondedAt) replied++;
    return [
      l.title,
      l.url,
      l.datePosted ?? '',
      l.askingPrice == null ? '' : String(l.askingPrice),
      l.grossRevenue == null ? '' : String(l.grossRevenue),
      l.cashFlow == null ? '' : String(l.cashFlow),
      l.ebitda == null ? '' : String(l.ebitda),
      l.brokerName ?? '',
      l.brokerPhone ?? '',
      outreach ? 'YES' : 'NO',
      stamp(outreach?.sentAt),
      l.respondedAt ? 'YES' : 'NO',
      stamp(l.respondedAt),
      l.responseNote ?? '',
      l.status,
    ];
  });

  return { values, sent, replied };
}

async function buildTrackerCsv(): Promise<string> {
  const { values } = await trackerRows();

  const cell = (value: string) => {
    let text = value;

    // Neutralise formulas before quoting.
    //
    // This is imported straight into Google Sheets and two columns are free
    // text written by other people — the listing title and whatever a broker
    // replied. A value starting =, +, - or @ is evaluated as a FORMULA on
    // import, so a reply beginning "=" stops being text and starts being code
    // running inside the buyer's deal tracker. A leading apostrophe is the
    // spreadsheet's own way of saying "this is literal".
    if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;

    // \r as well as \n: RFC 4180 requires quoting carriage returns too, and a
    // bare CR splits one row into two in both Excel and Sheets.
    return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };

  return [TRACKER_HEADERS as unknown as string[], ...values]
    .map((row) => row.map(cell).join(','))
    .join('\n');
}

/**
 * The tracker as a page you can actually look at.
 *
 * A browser downloads text/csv rather than rendering it, so the URL that feeds
 * Google Sheets is useless for reading and the URL for reading is useless to
 * Sheets. They are different jobs and now different links, sharing one row
 * builder so they cannot disagree about what was sent.
 *
 * Server-rendered, self-contained, no JavaScript: it has to survive being
 * opened on a phone, forwarded to someone, or projected in a meeting.
 */
app.get(
  '/sheet',
  handle(async (_req, res) => {
    const { values, sent, replied } = await trackerRows();

    const esc = (text: string) =>
      text.replace(/[&<>"']/g, (c) =>
        ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string,
      );
    const money = (text: string) =>
      text ? `$${Number(text).toLocaleString('en-US')}` : '<span class="none">—</span>';

    const rows = values
      .map((v) => {
        const [title, url, listed, ask, rev, cf, ebitda, broker, phone, isSent, sentAt, isReplied, repliedAt, note, status] = v;
        // Colour and words together — the whole point of the two indicators is
        // that they are readable at a glance and to someone who cannot see them.
        const flag = isReplied === 'YES'
          ? `<span class="f replied">Responded</span>`
          : isSent === 'YES'
            ? `<span class="f sent">Sent</span>`
            : `<span class="f none">Not contacted</span>`;
        return `<tr>
          <td><a href="${esc(url!)}" target="_blank" rel="noreferrer">${esc(title!)}</a>
            ${note ? `<div class="note">${esc(note)}</div>` : ''}</td>
          <td class="dim">${esc(listed!) || '<span class="none">—</span>'}</td>
          <td class="n">${money(ask!)}</td>
          <td class="n">${money(rev!)}</td>
          <td class="n">${money(cf!)}</td>
          <td class="n">${money(ebitda!)}</td>
          <td>${esc(broker!) || '<span class="none">—</span>'}<div class="dim">${esc(phone!)}</div></td>
          <td>${flag}<div class="dim">${esc(sentAt! || repliedAt!)}</div></td>
          <td class="dim">${esc(status!)}</td>
        </tr>`;
      })
      .join('');

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.send(`<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Deal Flow Tracker</title>
<style>
  :root{--bg:#0e1116;--panel:#151a21;--line:#252d38;--ink:#e7ecf3;--dim:#8b98ab;--faint:#5b6678;
    --good:#3fb950;--warn:#d29922;--accent:#4c8dff}
  *{box-sizing:border-box}
  body{margin:0;background:var(--bg);color:var(--ink);
    font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Inter,Roboto,sans-serif}
  header{padding:22px 26px;border-bottom:1px solid var(--line);background:var(--panel);
    position:sticky;top:0;z-index:5}
  h1{margin:0 0 4px;font-size:19px;letter-spacing:-.01em}
  .sub{color:var(--dim);font-size:13px}
  .stats{display:flex;gap:26px;margin-top:14px;flex-wrap:wrap}
  .stat b{display:block;font-size:22px;font-weight:650}
  .stat span{font-size:11px;color:var(--faint);text-transform:uppercase;letter-spacing:.06em}
  .wrap{overflow-x:auto;padding:0 0 60px}
  table{width:100%;border-collapse:collapse;font-size:13px;min-width:1000px}
  th{position:sticky;top:0;text-align:left;padding:10px 14px;background:var(--panel);
    color:var(--faint);font-size:11px;text-transform:uppercase;letter-spacing:.06em;
    border-bottom:1px solid var(--line);white-space:nowrap}
  td{padding:11px 14px;border-bottom:1px solid var(--line);vertical-align:top}
  tr:hover td{background:#161c25}
  a{color:var(--accent);text-decoration:none} a:hover{text-decoration:underline}
  .n{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}
  .dim{color:var(--dim);font-size:11.5px}
  .none{color:var(--faint)}
  .note{color:#8ee79c;font-size:11.5px;margin-top:4px;max-width:420px}
  .f{display:inline-block;font-size:11px;font-weight:600;padding:3px 9px;border-radius:20px;
    border:1px solid;white-space:nowrap}
  .f.sent{background:#3a2f14;color:#f0cd7e;border-color:#6b5620}
  .f.replied{background:#12291a;color:#8ee79c;border-color:#2a5a30}
  .f.none{background:transparent;color:var(--faint);border-color:#2f3744}
</style></head><body>
<header>
  <h1>Deal Flow Tracker</h1>
  <div class="sub">Businesses matching the buy-box — SDE $750k–$1M, 12 industries, all US states.
    Live view, refreshed on load.</div>
  <div class="stats">
    <div class="stat"><b>${values.length}</b><span>Listings</span></div>
    <div class="stat"><b>${sent}</b><span>Contacted</span></div>
    <div class="stat"><b>${replied}</b><span>Responded</span></div>
  </div>
</header>
<div class="wrap"><table>
<thead><tr>
  <th>Business</th><th>Listed</th><th>Asking</th><th>Revenue</th><th>Cash flow (SDE)</th>
  <th>EBITDA</th><th>Broker</th><th>Outreach</th><th>Status</th>
</tr></thead>
<tbody>${rows || '<tr><td colspan="9" style="padding:60px;text-align:center;color:#5b6678">No listings yet.</td></tr>'}</tbody>
</table></div>
</body></html>`);
  }),
);

/** Download button — an attachment, so the browser saves it. */
app.get(
  '/api/listings.csv',
  handle(async (_req, res) => {
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="bizbuysell-tracker.csv"');
    res.send(await buildTrackerCsv());
  }),
);

/**
 * Google Sheets — served inline so `IMPORTDATA()` can read the body.
 *
 * This is what makes the sheet live with no Google credentials at all: no
 * service account, no OAuth consent, no key to rotate. One formula in A1 and
 * Sheets re-fetches it roughly hourly.
 */
app.get(
  '/api/sheet.csv',
  handle(async (_req, res) => {
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.send(await buildTrackerCsv());
  }),
);

/** Exactly what a broker would receive, before anything is armed. */
app.get(
  '/api/preview-message',
  handle(async (_req, res) => {
    const settings = await getSettings();
    const sample = await prisma.listing.findFirst({ orderBy: { firstSeenAt: 'desc' } });
    ok(res, {
      message: renderMessage(settings.messageTemplate || DEFAULT_MESSAGE, {
        title: sample?.title ?? 'Example Business For Sale',
      }),
      contact: { fullName: settings.fullName, email: settings.email, phone: settings.phone },
      armed: settings.sendingEnabled,
    });
  }),
);

/**
 * An unknown API route is an error, not the dashboard.
 *
 * Without this, `/api/anything` returns the SPA shell with a 200 — so a typo in
 * a fetch looks like success, and Google Sheets pointed at a mistyped CSV URL
 * would quietly import an HTML page instead of the tracker and show a sheet
 * full of nonsense rather than an error.
 */
app.use('/api', (_req, res) => res.status(404).json({ ok: false, error: 'No such endpoint.' }));

app.get('*', (_req, res) => res.sendFile(path.join(PUBLIC_DIR, 'index.html')));

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

const port = env.port;
// 0.0.0.0 explicitly: Docker sets HOSTNAME to the container id, and binding to
// that makes the service unreachable behind a platform proxy while looking
// perfectly healthy in the logs.
app.listen(port, '0.0.0.0', async () => {
  console.log('─'.repeat(64));
  console.log('  BizBuySell deal-sourcing system');
  console.log('─'.repeat(64));
  console.log(`  listening   http://0.0.0.0:${port}`);
  console.log(`  node        ${process.version}`);
  console.log(`  transport   ${env.transport}`);
  console.log(`  dashboard   ${PUBLIC_DIR}`);
  const problems = envProblems();
  console.log(`  config      ${problems.length ? problems.join('; ') : 'complete'}`);

  // Seed the buy-box so the first screen shows a runnable search, not a form.
  await ensureDefaultSearch().catch(() => {});

  const orphans = await reconcileOrphanedRuns().catch(() => 0);
  if (orphans) console.log(`  recovered   ${orphans} run(s) interrupted by a restart`);

  // Start it unconditionally. Whether a scan actually happens is decided inside,
  // against the database, so restarts cannot produce duplicate runs.
  startScheduler();
  const settings = await getSettings().catch(() => null);
  console.log(
    `  schedule    ${
      settings?.dailyScanEnabled
        ? `daily at ${String(settings.scanHourUtc).padStart(2, '0')}:00 UTC` +
          `${settings.sendingEnabled ? ' — ARMED, messages will send' : ' (dry, sending is off)'}`
        : 'off'
    }`,
  );
  console.log('─'.repeat(64));
});

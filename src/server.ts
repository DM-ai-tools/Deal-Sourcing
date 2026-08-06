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
import { prisma, probeDatabase, getSettings, countSentToday } from './lib/db.js';
import { executeRun, stopRun, isRunning, reconcileOrphanedRuns } from './lib/runner.js';
import { checkReachability, type TransportConfig } from './lib/transport.js';
import { INDUSTRIES, STATES, DEFAULT_INDUSTRIES, buildSearchUrls } from './lib/search-url.js';
import { DEFAULT_MESSAGE, renderMessage } from './lib/outreach.js';

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
  transport: z.enum(['firecrawl', 'local', 'proxy']).optional(),
  bizbuysellEmail: z.string().max(200).nullable().optional(),
  bizbuysellPassword: z.string().max(200).nullable().optional(),
  proxyServer: z.string().max(300).nullable().optional(),
  proxyUsername: z.string().max(200).nullable().optional(),
  proxyPassword: z.string().max(200).nullable().optional(),
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
        hasLogin: Boolean(settings.bizbuysellEmail && settings.bizbuysellPassword),
        hasProxy: Boolean(settings.proxyServer),
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

    await getSettings();
    const data = { ...parsed.data };
    // Blank means "leave it alone", not "erase it" — the form never receives
    // the current secret, so an empty field is absence of input.
    if (!data.bizbuysellPassword) delete data.bizbuysellPassword;
    if (!data.proxyPassword) delete data.proxyPassword;

    const updated = await prisma.settings.update({ where: { id: 1 }, data });
    ok(res, { settings: { ...updated, bizbuysellPassword: undefined, proxyPassword: undefined } });
  }),
);

app.post(
  '/api/settings/test-transport',
  handle(async (_req, res) => {
    const settings = await getSettings();
    const config: TransportConfig = {
      transport: settings.transport as TransportConfig['transport'],
      proxyServer: settings.proxyServer,
      proxyUsername: settings.proxyUsername,
      proxyPassword: settings.proxyPassword,
    };
    ok(res, { result: await checkReachability(config) });
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
      .object({ status: z.enum(STATUSES).optional(), notes: z.string().max(4000).optional() })
      .safeParse(req.body);
    if (!body.success) return fail(res, 'Invalid update');
    ok(res, { listing: await prisma.listing.update({ where: { id: param(req, 'id') }, data: body.data }) });
  }),
);

/** The tracker as the client asked for it, in the column order they gave. */
app.get(
  '/api/listings.csv',
  handle(async (_req, res) => {
    const listings = await prisma.listing.findMany({ orderBy: { firstSeenAt: 'desc' } });
    const cell = (value: unknown) => {
      const text = value == null ? '' : String(value);
      return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
    };
    const rows = [
      ['Listing Name', 'Link', 'Asking Price', 'Gross Revenue', 'Cash Flow (SDE)', 'EBITDA', 'Status'],
      ...listings.map((l) => [
        l.title,
        l.url,
        l.askingPrice ?? '',
        l.grossRevenue ?? '',
        l.cashFlow ?? '',
        l.ebitda ?? '',
        l.status,
      ]),
    ];
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="bizbuysell-tracker.csv"');
    res.send(rows.map((r) => r.map(cell).join(',')).join('\n'));
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

  const orphans = await reconcileOrphanedRuns().catch(() => 0);
  if (orphans) console.log(`  recovered   ${orphans} run(s) interrupted by a restart`);
  console.log('─'.repeat(64));
});

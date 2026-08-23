/**
 * One scan per day, without anyone having to remember.
 *
 * Everything else in this system waits to be told: a run starts when someone
 * clicks Start, or when the send toggle is armed. That is fine for testing and
 * wrong for the actual job, which is to notice a business the day it is listed.
 * A listing with $750k–$1M of cash flow does not sit unclaimed for a week.
 *
 * The design constraint that shapes this file: **the container restarts.**
 * Railway redeploys, crashes and scales, and each restart re-runs boot code. So
 * "have we already scanned today?" cannot live in memory — it is answered by
 * asking the database what runs exist since midnight. Ten restarts in an hour
 * produce one run, not ten, and that property is what makes an unattended
 * sender safe to leave switched on.
 */
import { prisma, getSettings, resolveActiveSearch, countSentToday } from './db.js';
import { executeRun } from './runner.js';
import { checkInbox } from './inbox.js';

/** How often to look. Well below an hour, so the scan hour is never missed. */
const CHECK_INTERVAL_MS = 15 * 60 * 1000;

/** How often to read the inbox. A waiting broker is the thing being optimised. */
const INBOX_INTERVAL_MS = 5 * 60 * 1000;

/**
 * How long to wait before trying again on a day that has sent nothing.
 *
 * Long enough that we are not hammering a host which just refused us — that is
 * how a soft block hardens — and short enough to catch a window that opens
 * mid-afternoon. Akamai's verdict here changes over hours.
 */
const RETRY_AFTER_MS = 75 * 60 * 1000;

/**
 * Attempts per day before giving up until tomorrow.
 *
 * Six spread across the day is roughly one every two waking hours. Past that
 * the day is genuinely blocked and further requests only damage the address
 * we are trying to rehabilitate.
 */
const MAX_ATTEMPTS_PER_DAY = 6;

/** Midnight UTC today. The day boundary is fixed rather than local so it does
 *  not shift under the container, which has no timezone configured. */
function startOfUtcDay(): Date {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

/**
 * Start today's run, if today's run has not already happened.
 *
 * Exported so it can be triggered by hand and tested, and so the reason for
 * skipping is always a string someone can read rather than silence.
 */
export async function maybeRunDailyScan(force = false): Promise<string> {
  const settings = await getSettings();

  if (!force && !settings.dailyScanEnabled) return 'Daily scan is switched off.';

  if (!force && new Date().getUTCHours() < settings.scanHourUtc) {
    return `Waiting for ${String(settings.scanHourUtc).padStart(2, '0')}:00 UTC.`;
  }

  // Never two at once. A scan that overlaps the previous one would contend for
  // the same browser profile and double the load on a site that is already
  // rate-limiting us.
  const active = await prisma.run.findFirst({
    where: { status: { in: ['queued', 'discovering', 'contacting'] } },
    select: { id: true },
  });
  if (active) return 'A run is already in progress.';

  // The real idempotency guard, and the reason this is a database question and
  // not a variable: restarts re-run boot code, and a redeploy at 14:05 must not
  // start a second scan on top of the one that began at 14:00.
  const since = startOfUtcDay();
  if (!force) {
    const runsToday = await prisma.run.findMany({
      where: { startedAt: { gte: since } },
      orderBy: { startedAt: 'desc' },
      select: { id: true, startedAt: true, messagesSent: true },
    });

    if (runsToday.length) {
      // One attempt a day was throwing the day away.
      //
      // Akamai blocks this address intermittently, not permanently — 42
      // messages have gone out across several days, and on the bad days every
      // single request is refused from the first one. A single 14:00 attempt
      // means one refused afternoon costs an entire day of outreach, and the
      // listings simply queue up.
      //
      // So a day that has produced nothing gets tried again. The site's mood
      // changes over hours; ours should too.
      const sentToday = await countSentToday();
      const settings2 = await getSettings();

      if (!settings2.sendingEnabled) return 'Already scanned today.';
      if (sentToday >= settings2.dailyCap) return `Daily cap reached (${sentToday}).`;
      if (runsToday.length >= MAX_ATTEMPTS_PER_DAY) {
        return `Already tried ${runsToday.length} times today; leaving it until tomorrow.`;
      }

      // Space the retries out. Hammering a host that just refused us is how a
      // soft block becomes a hard one, and the whole point is to come back when
      // the site's answer might genuinely have changed.
      const lastAt = runsToday[0]?.startedAt;
      const waited = lastAt ? Date.now() - new Date(lastAt).getTime() : Infinity;
      if (waited < RETRY_AFTER_MS) {
        const mins = Math.ceil((RETRY_AFTER_MS - waited) / 60000);
        return `Nothing sent yet today; retrying in ${mins} min.`;
      }
    }
  }

  const search = await resolveActiveSearch();
  if (!search) return 'No search is configured.';

  // Dry unless sending is armed. The scan is worth running either way — it
  // keeps the tracker current — but the master switch alone decides whether a
  // message leaves the building.
  const dryRun = !settings.sendingEnabled;

  const run = await prisma.run.create({
    data: { searchId: search.id, dryRun, transport: settings.transport },
  });
  await prisma.settings.update({ where: { id: 1 }, data: { lastScheduledAt: new Date() } });

  void executeRun(run.id);

  return dryRun
    ? `Daily scan started (dry run — sending is off). Run ${run.id}.`
    : `Daily scan started and armed. Run ${run.id}.`;
}

/**
 * Begin checking. Safe to call once at boot.
 *
 * `unref()` so a pending timer never holds the process open during shutdown —
 * a container that will not exit gets killed, and a kill mid-send is exactly
 * the state that leaves a claimed listing in limbo.
 */
export function startScheduler(): void {
  const tick = () => {
    maybeRunDailyScan()
      .then((outcome) => {
        // Only say something when something happened. A line every fifteen
        // minutes saying "waiting" buries the logs that matter.
        if (outcome.startsWith('Daily scan started')) console.log(`[scheduler] ${outcome}`);
      })
      .catch((err) => console.error('[scheduler]', (err as Error).message));
  };

  setTimeout(tick, 60_000).unref(); // let boot settle before the first check
  setInterval(tick, CHECK_INTERVAL_MS).unref();

  // Replies are checked far more often than listings are scanned.
  //
  // A scan once a day is right — listings appear at that pace. A reply is
  // someone waiting for an answer, and the cost of being slow is a broker who
  // concludes nobody is home. Five minutes is cheap: an IMAP poll with nothing
  // new is one short connection.
  const pollInbox = () => {
    checkInbox()
      .then((result) => {
        if (result.found) console.log(`[inbox] ${result.detail}`);
        else if (!result.ok && result.detail !== 'Inbox monitoring is switched off.') {
          console.error(`[inbox] ${result.detail}`);
        }
      })
      .catch((err) => console.error('[inbox]', (err as Error).message));
  };

  setTimeout(pollInbox, 90_000).unref();
  setInterval(pollInbox, INBOX_INTERVAL_MS).unref();
}

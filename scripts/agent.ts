/**
 * The local sending agent.
 *
 * BizBuySell refuses the Railway server's IP — search pages and listing pages
 * both — while this machine reaches the site normally: 50 listings in 24
 * seconds, measured the same hour the server got a bot wall. So the work splits.
 * The server discovers, queues, tracks and reports; this process does the one
 * part that needs an IP the site will talk to.
 *
 * It is built to be left alone for weeks, which drives every decision here:
 *
 *   - **It never assumes it is the only one.** Listings are claimed server-side
 *     through the same unique constraint the server-side runner uses, so two
 *     copies of this agent, or a laptop that wakes from sleep mid-send, cannot
 *     message a broker twice.
 *   - **It survives the server being down.** Every call retries with backoff,
 *     and an unreachable server means wait, not exit. A sender that dies on a
 *     deploy is a sender nobody can trust to run overnight.
 *   - **It survives being blocked.** Three refusals in a row and it backs off
 *     for an hour rather than hammering, because continuing is how a soft block
 *     becomes a hard one.
 *   - **It hands work back when it stops.** Ctrl-C releases outstanding claims
 *     instead of parking them until the grace period expires.
 *   - **It obeys the dashboard.** Arming, the daily cap and the pacing are read
 *     from the server every cycle, so turning sending off in the browser stops
 *     this within a minute without touching the machine it runs on.
 *
 *   npm run agent
 */
import 'dotenv/config';
import { appendFileSync } from 'node:fs';
import { makeBrowserTransport } from '../src/lib/transport.js';
import { sendEnquiry } from '../src/lib/outreach.js';

const BASE = (process.env.AGENT_BASE_URL ?? 'https://deal-sourcing-production-a033.up.railway.app').replace(/\/$/, '');
const TOKEN = process.env.AGENT_TOKEN ?? '';
const MODE = (process.env.AGENT_MODE ?? 'local') as 'local';
const LOG_FILE = process.env.AGENT_LOG ?? 'agent.log';

/** How long to wait when there is nothing to do. */
const IDLE_MS = 5 * 60 * 1000;
/** How long to wait after the site starts refusing us. */
const BLOCKED_MS = 60 * 60 * 1000;
/** How long to wait when the server itself cannot be reached. */
const SERVER_DOWN_MS = 2 * 60 * 1000;
/** Consecutive blocks before backing off. */
const BLOCK_LIMIT = 3;

interface Job {
  listingId: string;
  title: string;
  url: string;
  message: string;
  fullName: string;
  email: string;
  phone: string;
}

/**
 * The live line at the bottom of the terminal.
 *
 * Deliberately NOT logged. This redraws several times a second during a
 * countdown, and a log file full of half-finished progress bars is unreadable
 * afterwards — the log is the permanent record, this is the window someone
 * glances at. Kept on one line so it never scrolls the history away.
 */
let statusOpen = false;

function status(text: string) {
  if (!process.stdout.isTTY) return; // piped to a file: no cursor to move
  const line = text.slice(0, 100).padEnd(100);
  process.stdout.write(`\r${line}`);
  statusOpen = true;
}

/** Clear the live line so a permanent message lands on a clean row. */
function clearStatus() {
  if (statusOpen && process.stdout.isTTY) {
    process.stdout.write(`\r${' '.repeat(100)}\r`);
    statusOpen = false;
  }
}

/**
 * Today's progress, at a glance.
 *
 * The cap is the thing worth seeing: the agent spends most of its life waiting
 * minutes between sends, and without this it looks identical to an agent that
 * has hung. A bar answers "is it working" without reading a single log line.
 */
function bar(done: number, total: number, width = 22): string {
  const safeTotal = Math.max(1, total);
  const filled = Math.min(width, Math.round((done / safeTotal) * width));
  return `[${'#'.repeat(filled)}${'.'.repeat(width - filled)}] ${done}/${total}`;
}

function say(message: string) {
  clearStatus();
  const line = `${new Date().toISOString().slice(0, 19).replace('T', ' ')}  ${message}`;
  console.log(line);
  // A background process nobody is watching needs a record that outlives the
  // console it was started from.
  try {
    appendFileSync(LOG_FILE, `${line}\n`);
  } catch {
    /* logging must never be the reason sending stops */
  }
}

/**
 * Sleep, showing what is being waited for.
 *
 * Every wait in this agent is minutes long — pacing between sends, idling for
 * a queue, backing off a block. Waiting in silence is indistinguishable from
 * being frozen, which is why the countdown exists.
 */
async function waitWith(ms: number, label: string, done = 0, total = 0): Promise<void> {
  const until = Date.now() + ms;
  while (Date.now() < until && !stopping) {
    const left = Math.max(0, Math.round((until - Date.now()) / 1000));
    const mins = Math.floor(left / 60);
    const secs = String(left % 60).padStart(2, '0');
    const progress = total > 0 ? `${bar(done, total)}  ` : '';
    status(`  ${progress}${label} ${mins}:${secs}`);
    await sleep(Math.min(1000, until - Date.now()));
  }
  clearStatus();
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Call the server, retrying transient failures.
 *
 * A deploy takes the API away for a minute or two, and the agent must ride that
 * out rather than treat it as fatal. Returns null when every attempt failed, so
 * callers decide what to do rather than crashing.
 */
async function api<T>(path: string, body?: unknown, attempts = 4): Promise<T | null> {
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const response = await fetch(`${BASE}${path}`, {
        method: body === undefined ? 'GET' : 'POST',
        headers: { 'Content-Type': 'application/json', 'x-agent-token': TOKEN },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(45_000),
      });

      if (response.status === 401) {
        say('AGENT TOKEN REJECTED — set AGENT_TOKEN to the value in Settings. Stopping.');
        process.exit(1);
      }

      const payload = (await response.json().catch(() => ({}))) as { ok?: boolean; error?: string };
      if (!response.ok || payload.ok === false) {
        throw new Error(payload.error ?? `HTTP ${response.status}`);
      }
      return payload as T;
    } catch (err) {
      const last = attempt === attempts;
      say(`  server call ${path} failed (${attempt}/${attempts}): ${(err as Error).message.slice(0, 90)}`);
      if (last) return null;
      await sleep(2000 * attempt);
    }
  }
  return null;
}

/** Claims taken but not yet reported. Released if the process is stopped. */
const outstanding = new Set<string>();

async function releaseOutstanding() {
  if (!outstanding.size) return;
  const ids = [...outstanding];
  say(`releasing ${ids.length} unsent claim(s) back to the queue…`);
  await api('/api/agent/release', { listingIds: ids }, 2);
  outstanding.clear();
}

let stopping = false;
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    if (stopping) process.exit(1);
    stopping = true;
    say(`\n${signal} — finishing up.`);
    releaseOutstanding().finally(() => process.exit(0));
  });
}

async function main() {
  if (!TOKEN) {
    say('No AGENT_TOKEN set. Put it in .env (see Settings → Local sending agent). Stopping.');
    process.exit(1);
  }

  say('─'.repeat(66));
  say('BizBuySell sending agent');
  say(`  server : ${BASE}`);
  say(`  browser: ${MODE}`);
  say(`  log    : ${LOG_FILE}`);
  say('─'.repeat(66));

  let blockedInARow = 0;

  while (!stopping) {
    const config = await api<{
      armed: boolean;
      agentEnabled: boolean;
      remainingToday: number;
      sentToday: number;
      dailyCap: number;
      minDelaySeconds: number;
      maxDelaySeconds: number;
    }>('/api/agent/config');

    if (!config) {
      say(`server unreachable — waiting ${SERVER_DOWN_MS / 60000} min.`);
      await sleep(SERVER_DOWN_MS);
      continue;
    }

    if (!config.agentEnabled) {
      say('agent sending is switched off in Settings — idling.');
      await sleep(IDLE_MS);
      continue;
    }
    if (!config.armed) {
      say('sending is not armed in Settings — idling.');
      await sleep(IDLE_MS);
      continue;
    }
    if (config.remainingToday <= 0) {
      say(`daily cap reached (${config.sentToday}/${config.dailyCap}) — done for today.`);
      await waitWith(IDLE_MS, 'idle, re-checking in', config.sentToday, config.dailyCap);
      continue;
    }

    // Small batches. A large claim held across a crash parks more listings for
    // the grace period than a small one, and there is no speed advantage —
    // sends are paced minutes apart regardless.
    const claim = await api<{ jobs: Job[] }>('/api/agent/claim', {
      limit: Math.min(3, config.remainingToday),
    });

    if (!claim) {
      await sleep(SERVER_DOWN_MS);
      continue;
    }
    if (!claim.jobs.length) {
      say('nothing queued — waiting for the next crawl.');
      await waitWith(IDLE_MS, 'checking again in', config.sentToday, config.dailyCap);
      continue;
    }

    say(`claimed ${claim.jobs.length} — ${config.sentToday}/${config.dailyCap} sent today`);
    for (const job of claim.jobs) outstanding.add(job.listingId);

    // One browser per batch. Launching per listing is slow and, with a
    // persistent profile, needlessly re-warms the same session.
    const transport = makeBrowserTransport({ transport: MODE });

    try {
      for (const job of claim.jobs) {
        if (stopping) break;

        say(`→ ${job.title.slice(0, 62)}`);

        const outcome = await sendEnquiry(
          transport,
          job.url,
          { fullName: job.fullName, email: job.email, phone: job.phone, message: job.message },
          true, // armed: this agent exists to send
        ).catch((err) => ({ ok: false, error: (err as Error).message }));

        const report = await api<{ recorded: string }>('/api/agent/report', {
          listingId: job.listingId,
          ok: outcome.ok,
          confirmation: 'confirmation' in outcome ? outcome.confirmation : undefined,
          error: 'error' in outcome ? outcome.error : undefined,
        });

        // Only stop tracking it once the server has the result. If reporting
        // failed, the claim stays outstanding and is released on shutdown —
        // better a listing retried than one silently marked sent.
        if (report) outstanding.delete(job.listingId);

        if (outcome.ok) {
          blockedInARow = 0;
          say(`   SENT — ${report?.recorded ?? 'recorded'}`);
        } else {
          const error = 'error' in outcome ? (outcome.error ?? '') : '';
          const blocked = /blocked|ERR_HTTP_RESPONSE_CODE_FAILURE|net::|bot wall|never rendered/i.test(error);
          blockedInARow = blocked ? blockedInARow + 1 : 0;
          say(`   failed — ${error.slice(0, 100)}`);

          if (blockedInARow >= BLOCK_LIMIT) {
            say(`${BLOCK_LIMIT} refusals in a row — the site is blocking this machine too.`);
            say(`backing off ${BLOCKED_MS / 60000} min rather than making it worse.`);
            break;
          }
        }

        if (!stopping) {
          const wait =
            (config.minDelaySeconds +
              Math.random() * Math.max(1, config.maxDelaySeconds - config.minDelaySeconds)) *
            1000;
          await waitWith(wait, 'next send in', config.sentToday, config.dailyCap);
        }
      }
    } finally {
      await transport.close().catch(() => {});
    }

    if (blockedInARow >= BLOCK_LIMIT) {
      await releaseOutstanding();
      await sleep(BLOCKED_MS);
      blockedInARow = 0;
    }
  }
}

main().catch(async (err) => {
  say(`agent crashed: ${err?.message ?? err}`);
  await releaseOutstanding();
  process.exit(1);
});

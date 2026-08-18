/**
 * The queue, handed out to a sender running somewhere else.
 *
 * BizBuySell refuses this server's IP — search pages and listing pages alike —
 * while the operator's own connection reaches the site normally. Rather than
 * pretend otherwise, the work splits: the server keeps discovery, the queue,
 * the tracker and the sheet; a local agent does the part that needs an IP the
 * site will talk to.
 *
 * Everything here is written around one rule: **a broker must never be messaged
 * twice.** A remote sender makes that harder than it looks — the network can
 * drop after the form is submitted but before the result comes back, the agent
 * can be killed mid-send, and someone can run two copies by accident. So:
 *
 *   - claiming and reporting are separate calls, and the claim is what reserves
 *     the listing. It goes through the same `Outreach.listingId` unique
 *     constraint the server-side runner uses, so a second claimant loses.
 *   - a claim that is never reported back stays 'claimed' and is only re-issued
 *     after a grace period, so a slow send is not handed to someone else while
 *     it is still in flight.
 *   - reporting is idempotent. The same result posted twice is one send.
 */
import { prisma, getSettings, countSentToday } from './db.js';
import { newestFirst } from './search-url.js';
import { renderMessage } from './outreach.js';

/**
 * How long a claim is honoured before another agent may take it.
 *
 * Longer than any single send can reasonably take — a listing page load, a
 * form fill and a submit — so a working agent is never overtaken. Short enough
 * that a laptop closed mid-run does not park listings for a day.
 */
const CLAIM_GRACE_MS = 15 * 60 * 1000;

export interface AgentJob {
  listingId: string;
  title: string;
  url: string;
  message: string;
  fullName: string;
  email: string;
  phone: string;
}

export interface AgentConfig {
  armed: boolean;
  agentEnabled: boolean;
  remainingToday: number;
  minDelaySeconds: number;
  maxDelaySeconds: number;
  sentToday: number;
  dailyCap: number;
}

/** What the agent needs to decide whether to work and how fast. */
export async function agentConfig(): Promise<AgentConfig> {
  const settings = await getSettings();
  const sentToday = await countSentToday();

  await prisma.settings
    .update({ where: { id: 1 }, data: { agentLastSeenAt: new Date() } })
    .catch(() => {});

  return {
    armed: settings.sendingEnabled,
    agentEnabled: settings.agentEnabled,
    sentToday,
    dailyCap: settings.dailyCap,
    remainingToday: Math.max(0, settings.dailyCap - sentToday),
    minDelaySeconds: settings.minDelaySeconds,
    maxDelaySeconds: settings.maxDelaySeconds,
  };
}

/**
 * Reserve up to `limit` listings and return everything needed to send them.
 *
 * The message is rendered here rather than in the agent so the wording lives in
 * one place — the operator edits a template in Settings and every sender uses
 * it, without shipping a new agent.
 */
export async function agentClaim(limit: number): Promise<AgentJob[]> {
  const settings = await getSettings();
  if (!settings.sendingEnabled) return [];
  if (!settings.fullName || !settings.email) return [];

  const remaining = Math.max(0, settings.dailyCap - (await countSentToday()));
  const want = Math.min(limit, remaining);
  if (want <= 0) return [];

  // Same eligibility rule as the server-side runner: only a sent message or a
  // spent retry budget retires a listing.
  const candidates = await prisma.listing.findMany({
    where: {
      status: 'new',
      isAuction: false,
      outreach: { none: { OR: [{ status: 'sent' }, { attempts: { gte: 3 } }] } },
    },
  });

  // Newest posted first — the whole point of the ordering work.
  candidates.sort(newestFirst);

  const staleBefore = new Date(Date.now() - CLAIM_GRACE_MS);
  const jobs: AgentJob[] = [];

  for (const listing of candidates) {
    if (jobs.length >= want) break;

    const message = renderMessage(settings.messageTemplate, listing);
    let claimed = false;

    try {
      await prisma.outreach.create({
        data: {
          listingId: listing.id,
          status: 'claimed',
          messageBody: message,
          fullName: settings.fullName,
          email: settings.email,
          phone: settings.phone,
          attempts: 1,
        },
      });
      claimed = true;
    } catch {
      // A row exists. Take it over only if it is not already sent, still has
      // budget, and is not a claim another agent is actively working.
      const taken = await prisma.outreach.updateMany({
        where: {
          listingId: listing.id,
          attempts: { lt: 3 },
          OR: [
            { status: { in: ['prepared', 'failed'] } },
            // An abandoned claim — the agent that took it never came back.
            { status: 'claimed', preparedAt: { lt: staleBefore } },
          ],
        },
        data: { status: 'claimed', messageBody: message, attempts: { increment: 1 } },
      });
      claimed = taken.count > 0;
    }

    if (claimed) {
      jobs.push({
        listingId: listing.id,
        title: listing.title,
        url: listing.url,
        message,
        fullName: settings.fullName,
        email: settings.email,
        phone: settings.phone,
      });
    }
  }

  return jobs;
}

export interface AgentReport {
  listingId: string;
  ok: boolean;
  confirmation?: string;
  error?: string;
  screenshot?: string;
}

/**
 * Record what happened to one listing.
 *
 * Idempotent by construction: a listing already marked sent is left alone, so
 * a report replayed after a network retry cannot double-count or overwrite a
 * success with a later failure.
 */
export async function agentReport(report: AgentReport): Promise<{ recorded: string }> {
  const existing = await prisma.outreach.findUnique({ where: { listingId: report.listingId } });
  if (!existing) return { recorded: 'unknown listing' };
  if (existing.status === 'sent') return { recorded: 'already sent — ignored' };

  if (report.ok) {
    await prisma.outreach.update({
      where: { listingId: report.listingId },
      data: { status: 'sent', sentAt: new Date(), confirmation: report.confirmation?.slice(0, 400) },
    });
    await prisma.listing.update({
      where: { id: report.listingId },
      data: { status: 'email_sent', contactedAt: new Date() },
    });
    return { recorded: 'sent' };
  }

  // A block is the site refusing everyone, not this listing being broken, so it
  // must not cost the listing one of its three attempts.
  const blocked =
    /blocked by the site|ERR_HTTP_RESPONSE_CODE_FAILURE|ERR_CONNECTION|net::|bot wall|never rendered/i.test(
      report.error ?? '',
    );

  await prisma.outreach.update({
    where: { listingId: report.listingId },
    data: {
      status: 'failed',
      error: report.error?.slice(0, 400),
      screenshot: report.screenshot,
      ...(blocked ? { attempts: { decrement: 1 } } : {}),
    },
  });

  return { recorded: blocked ? 'failed (blocked — attempt refunded)' : 'failed' };
}

/**
 * Hand back claims the agent did not get to.
 *
 * Called on a clean shutdown. Without it, stopping the agent would leave its
 * outstanding claims parked for the full grace period for no reason.
 */
export async function agentRelease(listingIds: string[]): Promise<number> {
  if (!listingIds.length) return 0;
  const result = await prisma.outreach.updateMany({
    where: { listingId: { in: listingIds }, status: 'claimed' },
    data: { status: 'failed', error: 'Released — agent stopped before sending.', attempts: { decrement: 1 } },
  });
  return result.count;
}

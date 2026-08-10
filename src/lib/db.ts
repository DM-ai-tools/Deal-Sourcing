/**
 * Database access.
 *
 * The client is created lazily behind a proxy. Instantiating PrismaClient at
 * module scope means a missing DATABASE_URL takes the whole process down at
 * import time — including the health endpoint, which is the one thing that
 * should still answer and explain why everything else is broken.
 */
import { PrismaClient } from '@prisma/client';
import { DEFAULT_MESSAGE } from './outreach.js';

let client: PrismaClient | null = null;

function real(): PrismaClient {
  if (!client) {
    client = new PrismaClient({
      log: process.env.NODE_ENV === 'development' ? ['warn', 'error'] : ['error'],
    });
  }
  return client;
}

export const prisma: PrismaClient = new Proxy({} as PrismaClient, {
  get(_target, property) {
    const value = Reflect.get(real(), property);
    return typeof value === 'function' ? value.bind(real()) : value;
  },
});

export async function probeDatabase(): Promise<{ ok: boolean; detail: string | null }> {
  try {
    await prisma.$queryRaw`SELECT 1`;
    return { ok: true, detail: null };
  } catch (err) {
    return { ok: false, detail: (err as Error).message.slice(0, 200) };
  }
}

/**
 * The settings row, created on first read.
 *
 * Seeded with sendingEnabled false. A fresh deployment that could start
 * messaging brokers the moment it boots would be a design fault, not a feature.
 */
export async function getSettings() {
  const existing = await prisma.settings.findUnique({ where: { id: 1 } });
  if (existing) return existing;

  // Seeded with the buyer's real details so the first run needs no typing.
  // Credentials come from the environment, never from source — the rest is
  // what goes into a public contact form anyway.
  return prisma.settings.create({
    data: {
      id: 1,
      fullName: process.env.BUYER_NAME ?? 'Sai Sushant Reddy Allu',
      email: process.env.BUYER_EMAIL ?? 'deals@hyperboards.com',
      phone: process.env.BUYER_PHONE ?? '(857) 366-7779',
      messageTemplate: DEFAULT_MESSAGE,
      bizbuysellEmail: process.env.BBS_EMAIL ?? null,
      bizbuysellPassword: process.env.BBS_PASSWORD ?? null,
      sendingEnabled: false,
    },
  });
}

/**
 * The buy-box, ready to run on first boot.
 *
 * Twelve industries and an SDE band is a lot of clicking to reproduce from a
 * screenshot, and getting one box wrong changes which businesses are found
 * without any error to notice. Seeding it means the first thing the operator
 * sees is their actual search rather than an empty form.
 */
export async function ensureDefaultSearch() {
  const count = await prisma.search.count();
  if (count > 0) return;

  await prisma.search.create({
    data: {
      name: 'Family office buy-box',
      states: [],
      industries: [
        'automotive-and-boat',
        'building-and-construction',
        'communication-and-media',
        'education-and-children',
        'entertainment-and-recreation',
        'financial-services',
        'health-care-and-fitness',
        'manufacturing',
        'non-classifiable-establishments',
        'online-and-technology',
        'service-businesses',
        'wholesale-and-distributors',
      ],
      cashFlowMin: 750_000,
      cashFlowMax: 1_000_000,
      excludeAuctions: true,
    },
  });
}

/**
 * The search the scheduler and the arming switch actually run.
 *
 * One place, so those two callers cannot drift apart and start running
 * different buy-boxes — a difference nobody would notice until the wrong
 * businesses were being contacted. `activeSearchId` is the operator's choice;
 * the fallback exists only so a fresh install works before anyone makes one.
 */
export async function resolveActiveSearch() {
  const settings = await getSettings();

  if (settings.activeSearchId) {
    const chosen = await prisma.search.findUnique({ where: { id: settings.activeSearchId } });
    // A deleted search must not silently become "no search at all".
    if (chosen) return chosen;
  }

  return prisma.search.findFirst({ orderBy: { updatedAt: 'desc' } });
}

export async function countSentToday(): Promise<number> {
  const since = new Date();
  since.setHours(0, 0, 0, 0);
  return prisma.outreach.count({ where: { status: 'sent', sentAt: { gte: since } } });
}

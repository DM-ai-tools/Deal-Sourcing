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

  return prisma.settings.create({
    data: {
      id: 1,
      messageTemplate: DEFAULT_MESSAGE,
      sendingEnabled: false,
    },
  });
}

export async function countSentToday(): Promise<number> {
  const since = new Date();
  since.setHours(0, 0, 0, 0);
  return prisma.outreach.count({ where: { status: 'sent', sentAt: { gte: since } } });
}

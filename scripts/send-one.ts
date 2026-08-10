/**
 * Send exactly one real enquiry, and record it the way a run would.
 *
 * Everything up to this point has been a dry run: the form fills, reads back
 * correctly, and is deliberately left unsubmitted. That proves the mechanism
 * but not the outcome — BizBuySell can still reject the submission, or accept
 * it without showing a confirmation, and neither is visible until a message is
 * actually pressed through.
 *
 * So: one listing, one send, full persistence, then stop. The count is not a
 * setting and not an argument — it is hard-coded to one, because the point of
 * this script is to learn what happens before forty of them happen. The daily
 * cap and the run loop are the right tools for volume; this is the tool for
 * the first one.
 *
 * It claims the listing through the same unique constraint the runner uses, so
 * running it cannot double-send, and a listing it sends to will not be picked
 * up again by a later run.
 *
 *   npx tsx scripts/send-one.ts            # oldest pending listing
 *   npx tsx scripts/send-one.ts <url>      # a specific one
 */
import { prisma } from '../src/lib/db.js';
import { getSettings } from '../src/lib/db.js';
import { makeBrowserTransport } from '../src/lib/transport.js';
import { DEFAULT_MESSAGE, login, renderMessage, sendEnquiry } from '../src/lib/outreach.js';
import type { TransportKind } from '../src/lib/transport.js';

/**
 * Settings from the database, or from `.env` when the database is out of reach.
 *
 * The production Postgres is not exposed to this machine, and waiting for a
 * deploy to test a send is a slow loop over the one step still unproven. With
 * no database this can still send — it just cannot record, and it says so
 * loudly rather than leaving someone to assume the tracker updated.
 */
async function resolveSettings() {
  try {
    return { settings: await getSettings(), persist: true };
  } catch {
    const need = (key: string) => {
      const value = process.env[key];
      if (!value) throw new Error(`No database, and ${key} is not set in .env either.`);
      return value;
    };
    return {
      settings: {
        fullName: need('BUYER_NAME'),
        email: need('BUYER_EMAIL'),
        phone: need('BUYER_PHONE'),
        bizbuysellEmail: need('BBS_EMAIL'),
        bizbuysellPassword: need('BBS_PASSWORD'),
        messageTemplate: DEFAULT_MESSAGE,
      },
      persist: false,
    };
  }
}

async function main() {
  const urlArg = process.argv[2];
  const { settings, persist } = await resolveSettings();

  console.log('\nARMED SEND — one listing only\n' + '='.repeat(60));
  if (!persist) {
    console.log('  NOTE: database unreachable — this will SEND but NOT record.');
    console.log('        Nothing will appear in the tracker or the sheet.');
    if (!urlArg) throw new Error('Without a database, pass the listing URL as an argument.');
  }

  if (!settings.fullName || !settings.email) {
    throw new Error('No contact name or email in Settings.');
  }
  if (!settings.bizbuysellEmail || !settings.bizbuysellPassword) {
    throw new Error('No BizBuySell login in Settings — the form needs a signed-in session.');
  }

  // The listing: either the one asked for, or the oldest that no one has
  // contacted. `outreach: { none: {} }` is the same guard the runner uses.
  const listing = !persist
    ? { id: '', title: urlArg!.split('/').filter(Boolean).slice(-2)[0]!.replace(/-/g, ' '), url: urlArg!, cashFlow: null }
    : urlArg
      ? await prisma.listing.findFirst({ where: { url: urlArg } })
      : await prisma.listing.findFirst({
          where: { status: 'new', isAuction: false, outreach: { none: {} } },
          orderBy: { firstSeenAt: 'asc' },
        });

  if (!listing) {
    console.log('Nothing to send to — no uncontacted listing matches.');
    return;
  }

  const message = renderMessage(settings.messageTemplate, listing);

  console.log(`  listing : ${listing.title}`);
  console.log(`  url     : ${listing.url}`);
  console.log(`  cashflow: ${listing.cashFlow ?? '—'}`);
  console.log(`  from    : ${settings.fullName} <${settings.email}> ${settings.phone}`);
  console.log(`  message : ${message.slice(0, 90).replace(/\s+/g, ' ')}…`);
  console.log('='.repeat(60) + '\n');

  const transport = makeBrowserTransport({
    transport: (process.env.MODE ?? 'local') as TransportKind,
  });

  // Claim it before sending, not after. If this insert loses a race the other
  // writer owns the listing and we stop — the unique constraint on listingId is
  // the real double-send guarantee, and it only works if the claim comes first.
  let claimed: { id: string } | null = null;
  try {
    if (persist) {
      claimed = await prisma.outreach.create({
        data: {
          listingId: listing.id,
          status: 'prepared',
          messageBody: message,
          fullName: settings.fullName,
          email: settings.email,
          phone: settings.phone,
        },
      });
    }
  } catch {
    console.log('Already claimed by another run — nothing sent.');
    await transport.close().catch(() => {});
    return;
  }

  try {
    // Signing in may not be required at all. The contact form asks for a name,
    // phone and email precisely because the sender may be anonymous, and it
    // fills correctly while signed out. If an anonymous send is accepted then
    // login is a dependency this system does not need — and dependencies that
    // can fail are worth removing when they buy nothing.
    if (process.env.SKIP_LOGIN === '1') {
      console.log('skipping login (SKIP_LOGIN=1) — testing whether it is needed.\n');
    } else {
      console.log('signing in…');
      const auth = await login(transport, {
        email: settings.bizbuysellEmail,
        password: settings.bizbuysellPassword,
      });
      if (!auth.ok) throw new Error(`Could not sign in: ${auth.error}`);
      console.log('signed in.\n');
    }

    console.log('sending (armed — this is real)…');
    const outcome = await sendEnquiry(
      transport,
      listing.url,
      {
        fullName: settings.fullName,
        email: settings.email,
        phone: settings.phone,
        message,
      },
      true,
    );

    if (outcome.screenshot) {
      const { writeFileSync } = await import('node:fs');
      writeFileSync('send-one.png', Buffer.from(outcome.screenshot.split(',')[1]!, 'base64'));
      console.log('  screenshot: send-one.png');
    }

    if (outcome.ok && persist && claimed) {
      await prisma.outreach.update({
        where: { id: claimed.id },
        data: {
          status: 'sent',
          sentAt: new Date(),
          attempts: 1,
          confirmation: outcome.confirmation,
        },
      });
      await prisma.listing.update({
        where: { id: listing.id },
        data: { status: 'email_sent', contactedAt: new Date() },
      });
      console.log(`\n  SENT. Site said: ${outcome.confirmation ?? '(no text captured)'}`);
      console.log('  Recorded as sent — the tracker and the sheet now show it.\n');
    } else if (outcome.ok) {
      console.log(`\n  SENT. Site said: ${outcome.confirmation ?? '(no text captured)'}`);
      console.log('  NOT recorded — no database. The tracker is unchanged.\n');
    } else {
      // Release the claim. A failed send that leaves a row behind would lock
      // the listing out of every future run, which is the quiet way to lose a
      // deal — the listing would look contacted and never be contacted.
      if (claimed) await prisma.outreach.delete({ where: { id: claimed.id } }).catch(() => {});
      console.log(`\n  NOT SENT: ${outcome.error}`);
      console.log('  Claim released — the listing stays eligible for the next run.\n');
    }
  } catch (err) {
    if (claimed) await prisma.outreach.delete({ where: { id: claimed.id } }).catch(() => {});
    console.log(`\n  FAILED: ${(err as Error).message}`);
    console.log('  Claim released.\n');
  } finally {
    await transport.close().catch(() => {});
    await prisma.$disconnect().catch(() => {});
  }
}

main().catch((err) => {
  console.error('crashed:', err?.message ?? err);
  process.exit(1);
});

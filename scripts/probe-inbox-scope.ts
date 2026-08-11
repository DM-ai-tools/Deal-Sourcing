/**
 * Does the scoped reader behave against a real, busy mailbox?
 *
 * The mailbox in use is not dedicated to this system: 1,559 messages of
 * ordinary business correspondence, with broker replies arriving only because
 * deals@hyperboards.com forwards them. Two things had to change for that, and
 * both are worth proving rather than assuming.
 *
 *  1. Reading `1:*` downloaded the whole mailbox to find the recent few. It now
 *     asks the server with SEARCH. This measures how many that returns.
 *  2. Everything in the inbox was being ingested. It now keeps only mail
 *     addressed to the buyer. This shows what would be kept and what dropped.
 *
 * Read-only, and it writes nothing to the database.
 */
import 'dotenv/config';
import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';

const DAYS = Number(process.env.DAYS ?? 7);
const FILTER_TO = (process.env.FILTER_TO ?? 'deals@hyperboards.com').toLowerCase();

async function main() {
  const user = process.env.INBOX_USER!;
  const pass = process.env.INBOX_PASSWORD!;
  const since = new Date(Date.now() - DAYS * 24 * 60 * 60 * 1000);

  const client = new ImapFlow({
    host: 'imap.gmail.com',
    port: 993,
    secure: true,
    auth: { user, pass },
    logger: false,
  });

  await client.connect();

  try {
    const box = await client.mailboxOpen('INBOX', { readOnly: true });
    console.log(`\n  mailbox holds : ${box.exists} messages`);
    console.log(`  window        : last ${DAYS} days (since ${since.toISOString().slice(0, 10)})`);

    // The change that matters for cost: the server does the filtering.
    const recent = (await client.search({ since }, { uid: true })) || [];
    console.log(`  SEARCH returns: ${recent.length} — this is what gets downloaded`);
    console.log(`  (before, every poll pulled all ${box.exists})\n`);

    if (!recent.length) {
      console.log('  nothing in the window; nothing to classify.\n');
      return;
    }

    let kept = 0;
    let dropped = 0;
    const keptExamples: string[] = [];
    const droppedExamples: string[] = [];

    for await (const message of client.fetch(
      recent.slice(-40).join(','),
      { uid: true, source: true },
      { uid: true },
    )) {
      if (!message.source) continue;
      const parsed = await simpleParser(message.source);

      const headers = new Map<string, string>();
      for (const [name, value] of parsed.headers) headers.set(name.toLowerCase(), String(value));

      const haystack = [
        ...((parsed.to as { value?: { address?: string }[] })?.value ?? []).map((t) => t.address ?? ''),
        ...((parsed.cc as { value?: { address?: string }[] })?.value ?? []).map((t) => t.address ?? ''),
        headers.get('delivered-to') ?? '',
        headers.get('x-forwarded-to') ?? '',
        headers.get('to') ?? '',
      ]
        .join(' ')
        .toLowerCase();

      const line = `${(parsed.from?.value?.[0]?.address ?? '?').slice(0, 30).padEnd(31)} ${(parsed.subject ?? '').slice(0, 44)}`;

      if (haystack.includes(FILTER_TO)) {
        kept++;
        if (keptExamples.length < 6) keptExamples.push(line);
      } else {
        dropped++;
        if (droppedExamples.length < 6) droppedExamples.push(line);
      }
    }

    console.log(`  WOULD INGEST (addressed to ${FILTER_TO}): ${kept}`);
    for (const line of keptExamples) console.log(`     + ${line}`);
    if (!kept) console.log('     (none — no forwarded broker mail has arrived yet)');

    console.log(`\n  WOULD IGNORE (the mailbox owner's own mail): ${dropped}`);
    for (const line of droppedExamples) console.log(`     - ${line}`);

    console.log(
      `\n  VERDICT: ${dropped} message(s) that would previously have been stored in the deal\n` +
        `  database and shown under Replies are now left alone.\n`,
    );
  } finally {
    await client.logout().catch(() => {});
  }
}

main().catch((err) => {
  console.error('probe crashed:', err?.message ?? err);
  process.exit(1);
});

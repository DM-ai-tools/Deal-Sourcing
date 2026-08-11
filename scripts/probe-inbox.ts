/**
 * Can we actually sign in to the mailbox?
 *
 * hyperboards.com resolves to Microsoft 365 (MX -> mail.protection.outlook.com,
 * autodiscover -> outlook), and Microsoft disabled basic authentication for IMAP
 * across Exchange Online. So a completely correct password can still be refused,
 * and the server's own wording ("LOGIN failed") sends people off to reset a
 * password that was never the problem.
 *
 * This settles it before the feature is trusted: one connection, read-only, no
 * mailbox changes. It reads credentials from the environment so no password is
 * ever written into a file that git can see.
 *
 *   INBOX_USER=... INBOX_PASSWORD=... npx tsx scripts/probe-inbox.ts
 */
import { ImapFlow } from 'imapflow';
import { guessImapHost } from '../src/lib/inbox.js';

async function main() {
  const user = process.env.INBOX_USER ?? process.env.BUYER_EMAIL;
  const pass = process.env.INBOX_PASSWORD;
  const host = process.env.INBOX_HOST ?? guessImapHost(user) ?? 'outlook.office365.com';

  if (!user || !pass) throw new Error('Set INBOX_USER and INBOX_PASSWORD.');

  console.log(`\n  host : ${host}:993`);
  console.log(`  user : ${user}`);
  console.log(`  auth : password (basic)\n`);

  const client = new ImapFlow({
    host,
    port: 993,
    secure: true,
    auth: { user, pass },
    logger: false,
    greetingTimeout: 20_000,
    socketTimeout: 45_000,
  });

  try {
    await client.connect();
    console.log('  CONNECTED — basic auth is accepted on this mailbox.');

    const box = await client.mailboxOpen('INBOX', { readOnly: true });
    console.log(`  INBOX  : ${box.exists} message(s), opened READ-ONLY.`);

    // Show only the newest few, so it is obvious the read works without
    // dumping anyone's correspondence into a terminal.
    if (box.exists > 0) {
      const from = Math.max(1, box.exists - 4);
      for await (const message of client.fetch(`${from}:*`, { envelope: true })) {
        const sender = message.envelope?.from?.[0];
        console.log(
          `    #${message.seq} ${String(message.envelope?.date ?? '').slice(0, 16)} ` +
            `${(sender?.address ?? '?').slice(0, 34).padEnd(35)} ${(message.envelope?.subject ?? '').slice(0, 46)}`,
        );
      }
    }
    console.log('\n  VERDICT: inbox monitoring will work with this password.\n');
  } catch (err) {
    // ImapFlow puts the useful part on the error object, not in .message —
    // "Command failed" on its own names nothing and diagnoses nothing.
    const e = err as Error & {
      authenticationFailed?: boolean;
      responseText?: string;
      serverResponseCode?: string;
      response?: string;
      code?: string;
    };
    const message = [
      e.message,
      e.responseText && `responseText: ${e.responseText}`,
      e.serverResponseCode && `code: ${e.serverResponseCode}`,
      e.response && `response: ${e.response}`,
      e.code && `errno: ${e.code}`,
      e.authenticationFailed !== undefined && `authenticationFailed: ${e.authenticationFailed}`,
    ]
      .filter(Boolean)
      .join('\n          ');
    console.log(`  FAILED: ${message}\n`);
    if (/AUTHENTICATE|LOGIN|credentials/i.test(message)) {
      console.log('  This is the expected Microsoft 365 outcome. Basic auth for IMAP is off,');
      console.log('  so the password is not the problem. Options, in order of effort:');
      console.log('    1. Entra app registration + OAuth (IMAP.AccessAsUser.All) — the supported route');
      console.log('    2. Microsoft Graph Mail.Read with client credentials — no IMAP at all');
      console.log('    3. A mailbox rule forwarding broker replies to an address that does allow IMAP\n');
    }
    process.exitCode = 1;
  } finally {
    await client.logout().catch(() => {});
  }
}

main().catch((err) => {
  console.error('probe crashed:', err?.message ?? err);
  process.exit(1);
});

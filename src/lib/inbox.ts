/**
 * Inbox monitoring: a broker's reply reaches the tracker without anyone typing it.
 *
 * Until now the only route from "a broker answered" to "the tracker knows" was
 * a person reading the inbox and pressing Log reply. That is fine for one
 * conversation and hopeless for seventy, which is the number this system
 * creates. A reply that nobody notices is worse than a message never sent — the
 * work was done, the interest exists, and it is sitting unread.
 *
 * Three commitments shape this file.
 *
 * **Read-only against the mailbox.** This connects to a real business inbox.
 * Folders are opened read-only, nothing is deleted, nothing is marked seen, and
 * position is tracked by UID on our side. The worst a bug here can do is read a
 * message twice — and `Reply.messageId` is unique, so even that is a no-op.
 *
 * **A wrong match is worse than no match.** Flipping the wrong listing to
 * "Responded" sends someone to chase a conversation that never happened, and
 * quietly retires one that did. So matching runs strongest-signal-first and
 * records which rule fired; anything it cannot place is stored unmatched and
 * shown, never guessed at.
 *
 * **Auto-replies are not answers.** Out-of-office and delivery failures are
 * kept — a bounce is worth seeing — but they never mark a listing as having
 * replied.
 */
import { ImapFlow } from 'imapflow';
import {
  graphFetchSince,
  graphTest,
  type GraphCredentials,
  type RawMessage as GraphRawMessage,
} from './graph-mail.js';
import { simpleParser, type ParsedMail } from 'mailparser';
import { prisma, getSettings } from './db.js';
import {
  matchReply,
  toSnippet,
  looksAutomatic,
  looksLikeBounce,
  type Candidate,
} from './reply-match.js';

export { matchReply } from './reply-match.js';

/** One message, provider-independent. `uid` exists only for IMAP. */
type RawMessage = GraphRawMessage & { uid?: number };

export interface InboxCheck {
  ok: boolean;
  detail: string;
  found?: number;
  matched?: number;
}

/**
 * IMAP host for an address, when the operator has not set one.
 *
 * Guessing is limited to providers whose hostname is genuinely fixed. Anything
 * else returns null and asks, because a wrong host produces a connection error
 * that reads like a wrong password and sends someone hunting for the wrong
 * problem.
 */
export function guessImapHost(email: string | null | undefined): string | null {
  const domain = (email ?? '').split('@')[1]?.toLowerCase();
  if (!domain) return null;

  const known: Record<string, string> = {
    'gmail.com': 'imap.gmail.com',
    'googlemail.com': 'imap.gmail.com',
    'outlook.com': 'outlook.office365.com',
    'hotmail.com': 'outlook.office365.com',
    'live.com': 'outlook.office365.com',
    'office365.com': 'outlook.office365.com',
    'yahoo.com': 'imap.mail.yahoo.com',
    'icloud.com': 'imap.mail.me.com',
    'zoho.com': 'imap.zoho.com',
  };
  return known[domain] ?? null;
}

/** Open a connection using the stored settings. Caller must logout(). */
async function connect(settings: {
  inboxHost: string | null;
  inboxPort: number;
  inboxUser: string | null;
  inboxPassword: string | null;
}): Promise<ImapFlow> {
  const host = settings.inboxHost || guessImapHost(settings.inboxUser);
  if (!host) throw new Error('No IMAP host set, and it cannot be guessed from this address.');
  if (!settings.inboxUser || !settings.inboxPassword) throw new Error('No mailbox user or password set.');

  const client = new ImapFlow({
    host,
    port: settings.inboxPort || 993,
    secure: true,
    auth: { user: settings.inboxUser, pass: settings.inboxPassword },
    logger: false,
    // Fail fast. A hung connection inside a scheduled poll would hold the
    // interval open and look like the monitor working.
    greetingTimeout: 20_000,
    socketTimeout: 60_000,
  });

  await client.connect();
  return client;
}

/**
 * Can we reach the mailbox at all?
 *
 * Kept separate from ingestion so the dashboard can answer "are the credentials
 * right?" without processing anything — and so the failure message can be about
 * the credentials rather than about matching.
 */
export async function testInbox(): Promise<InboxCheck> {
  const settings = await getSettings();

  if (settings.inboxProvider === 'graph') {
    const credentials = graphCredentials(settings);
    if (!credentials) {
      return {
        ok: false,
        detail:
          'Graph needs a tenant id, client id, client secret and the mailbox address. Create an ' +
          'app registration in Entra, give it the APPLICATION permission Mail.Read, and grant ' +
          'admin consent.',
      };
    }
    try {
      return { ok: true, detail: await graphTest(credentials) };
    } catch (err) {
      return { ok: false, detail: (err as Error).message };
    }
  }

  let client: ImapFlow | null = null;

  try {
    client = await connect(settings);
    const box = await client.mailboxOpen('INBOX', { readOnly: true });
    const total = typeof box.exists === 'number' ? box.exists : 0;
    return {
      ok: true,
      detail: `Connected to ${settings.inboxUser} — INBOX has ${total} message(s). Read-only.`,
      found: total,
    };
  } catch (err) {
    return { ok: false, detail: explainAuthFailure(err as Error, settings.inboxUser) };
  } finally {
    await client?.logout().catch(() => {});
  }
}

/**
 * Turn an IMAP error into something someone can act on.
 *
 * Microsoft switched basic authentication off for IMAP across Exchange Online,
 * so for a Microsoft-hosted domain a correct password still fails — and the
 * server's own message ("LOGIN failed") sends people to reset a password that
 * was never wrong. Say what is actually required instead.
 */
function explainAuthFailure(err: Error, user: string | null): string {
  const message = err.message ?? String(err);
  const isMicrosoft = /outlook|office365/i.test(message) || /office365/i.test(user ?? '');

  if (/AUTHENTICATE|LOGIN failed|Invalid credentials|authentication failed/i.test(message)) {
    return (
      `${message} — the password was rejected. ` +
      (isMicrosoft || true
        ? 'If this mailbox is on Microsoft 365, that is expected: Microsoft disabled basic ' +
          'authentication for IMAP, so a correct password is still refused. It needs either an ' +
          'app password (tenant must allow them) or OAuth via an Entra app registration.'
        : 'Check the password, or whether the provider requires an app-specific password.')
    );
  }
  if (/ENOTFOUND|EAI_AGAIN|getaddrinfo/i.test(message)) {
    return `${message} — that IMAP hostname does not resolve. Check the host in Settings.`;
  }
  if (/ETIMEDOUT|timeout/i.test(message)) {
    return `${message} — the server did not answer. Check the host and port (993 for IMAP over TLS).`;
  }
  return message;
}

/** Credentials for the Graph route, or null when they are not all present. */
function graphCredentials(settings: {
  graphTenantId: string | null;
  graphClientId: string | null;
  graphClientSecret: string | null;
  inboxUser: string | null;
}): GraphCredentials | null {
  const { graphTenantId, graphClientId, graphClientSecret, inboxUser } = settings;
  if (!graphTenantId || !graphClientId || !graphClientSecret || !inboxUser) return null;
  return {
    tenantId: graphTenantId,
    clientId: graphClientId,
    clientSecret: graphClientSecret,
    userEmail: inboxUser,
  };
}

/** Read new messages from whichever provider is configured. */
async function readNewMessages(
  settings: Awaited<ReturnType<typeof getSettings>>,
): Promise<RawMessage[]> {
  // Anything older than the watermark has been handled. On a first run look
  // back a week rather than over the whole mailbox — the point is to catch
  // replies to messages this system sent, and it has not been sending longer
  // than that.
  const since = settings.inboxWatermark ?? new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

  if (settings.inboxProvider === 'graph') {
    const credentials = graphCredentials(settings);
    if (!credentials) {
      throw new Error(
        'Graph is selected but the tenant id, client id, client secret or mailbox address is missing.',
      );
    }
    return graphFetchSince(credentials, since);
  }

  return readNewMessagesOverImap(settings, since);
}

/** The IMAP route, for mailboxes that still allow a password. */
async function readNewMessagesOverImap(
  settings: Awaited<ReturnType<typeof getSettings>>,
  since: Date,
): Promise<RawMessage[]> {
  const client = await connect(settings);
  const messages: RawMessage[] = [];

  try {
    await client.mailboxOpen('INBOX', { readOnly: true });

    // Ask the server which messages are recent instead of downloading the
    // mailbox to find out.
    //
    // This used to fetch `1:*` with the full source of every message and then
    // discard anything older than the watermark. Against the real mailbox that
    // is 1,559 messages pulled over the wire, every five minutes, to find the
    // handful that matter — slow, and a good way to be rate-limited by a
    // provider for no reason. SEARCH does the filtering server-side and returns
    // only ids.
    const recent = await client.search({ since }, { uid: true });
    const wanted = (recent || []).filter((uid) => uid > settings.inboxLastUid);
    if (!wanted.length) return [];

    for await (const message of client.fetch(
      wanted.join(','),
      { uid: true, source: true },
      { uid: true },
    )) {
      if (!message.source) continue;

      const parsed: ParsedMail = await simpleParser(message.source);

      const headers = new Map<string, string>();
      for (const [name, value] of parsed.headers) headers.set(name.toLowerCase(), String(value));

      const addressesOf = (field: unknown): string[] => {
        const value = field as { value?: { address?: string }[] } | undefined;
        return (value?.value ?? [])
          .map((entry) => entry.address?.toLowerCase())
          .filter((address): address is string => Boolean(address));
      };

      messages.push({
        messageId: parsed.messageId ?? `uid-${message.uid}@${settings.inboxUser}`,
        fromEmail: parsed.from?.value?.[0]?.address ?? '',
        fromName: parsed.from?.value?.[0]?.name ?? null,
        subject: parsed.subject ?? '',
        body: parsed.text ?? '',
        receivedAt: parsed.date ?? new Date(),
        headers,
        // Delivered-To carries the forwarding hop, which the To header does
        // not — a forwarded reply still says To: deals@hyperboards.com.
        toEmails: [
          ...addressesOf(parsed.to),
          ...addressesOf(parsed.cc),
          ...(headers.get('delivered-to') ?? '').toLowerCase().split(/[,\s]+/).filter(Boolean),
        ],
        uid: message.uid,
      });
    }
  } finally {
    await client.logout().catch(() => {});
  }

  return messages;
}

/**
 * Is this message one of ours to read?
 *
 * The mailbox being monitored is not necessarily dedicated to this system. The
 * one in use carries 1,559 messages of ordinary business correspondence, and
 * broker replies arrive in it only because deals@hyperboards.com forwards them.
 * Ingesting everything would put unrelated mail — clients, invoices, newsletters
 * — into a deal database and onto a Replies screen where it does not belong.
 *
 * A forwarded reply is still addressed to the buyer's address, so that is the
 * discriminator: keep what was sent to us, ignore the mailbox owner's own mail.
 * With no filter configured, everything is read, which is the right default for
 * a mailbox that really is dedicated.
 */
function addressedToUs(message: RawMessage, filterTo: string | null): boolean {
  if (!filterTo) return true;
  const needle = filterTo.toLowerCase().trim();
  if (!needle) return true;

  if (message.toEmails.some((address) => address.includes(needle))) return true;

  // Some forwarders rewrite the envelope and leave the original only in the
  // headers, so fall back to the raw header text before discarding a reply.
  for (const name of ['delivered-to', 'x-forwarded-to', 'x-original-to', 'to', 'cc']) {
    if ((message.headers.get(name) ?? '').toLowerCase().includes(needle)) return true;
  }
  return false;
}

/**
 * Read anything new, match it, and update the tracker.
 *
 * The mailbox is never modified — no deletes, no marking as read. Position is
 * held on our side, so the operator's own unread count stays theirs and the
 * worst this can do is read a message twice. `Reply.messageId` is unique, which
 * makes even that a no-op.
 */
export async function checkInbox(): Promise<InboxCheck> {
  const settings = await getSettings();
  if (!settings.inboxEnabled) return { ok: false, detail: 'Inbox monitoring is switched off.' };

  try {
    // Only listings we actually wrote to can receive a reply. This also keeps
    // the candidate set small enough to match against in memory.
    const candidates: Candidate[] = await prisma.listing.findMany({
      where: { outreach: { some: { status: 'sent' } } },
      select: { id: true, listingId: true, title: true, url: true, brokerName: true },
    });

    const messages = await readNewMessages(settings);

    let matched = 0;
    let skipped = 0;
    let watermark = settings.inboxWatermark;
    let highestUid = settings.inboxLastUid;

    for (const message of messages) {
      // Advance the watermark for every message seen, including ones we do
      // not keep — otherwise unrelated mail is re-examined on every poll.
      if (!watermark || message.receivedAt > watermark) watermark = message.receivedAt;
      if (message.uid && message.uid > highestUid) highestUid = message.uid;

      if (!addressedToUs(message, settings.inboxFilterTo)) {
        skipped++;
        continue;
      }

      const isAutoReply = looksAutomatic(message.headers, message.subject);
      const isBounce = looksLikeBounce(message.fromEmail, message.subject, message.headers);
      const { listing, matchedBy } = matchReply(
        { subject: message.subject, body: message.body, fromName: message.fromName },
        candidates,
      );
      const snippet = toSnippet(message.body || message.subject);

      await prisma.reply.upsert({
        where: { messageId: message.messageId },
        update: { listingId: listing?.id ?? null, matchedBy, snippet },
        create: {
          messageId: message.messageId,
          uid: message.uid ?? null,
          listingId: listing?.id ?? null,
          fromEmail: message.fromEmail,
          fromName: message.fromName,
          subject: message.subject,
          snippet,
          body: message.body.slice(0, 8000),
          matchedBy,
          isAutoReply,
          isBounce,
          receivedAt: message.receivedAt,
        },
      });

      // Only a real human answer moves a listing. An out-of-office is not
      // interest, and a bounce is the opposite of it.
      if (listing && !isAutoReply && !isBounce) {
        matched++;
        const advance = await shouldAdvance(listing.id);
        await prisma.listing.update({
          where: { id: listing.id },
          data: {
            respondedAt: message.receivedAt,
            responseNote: snippet.slice(0, 480),
            // Only advance a listing still sitting where the system left it.
            // Anything further along was moved by a person, and their judgement
            // outranks an inbox poll.
            ...(advance ? { status: 'replied' } : {}),
          },
        });
      }

    }

    await prisma.settings.update({
      where: { id: 1 },
      data: {
        inboxWatermark: watermark,
        inboxLastUid: highestUid,
        inboxLastCheckedAt: new Date(),
        inboxLastError: null,
      },
    });

    return {
      ok: true,
      detail: messages.length
        ? `Read ${messages.length} new message(s)` +
          `${skipped ? `, ignored ${skipped} not addressed to us` : ''}` +
          `; ${matched} matched to a listing.`
        : 'No new messages.',
      found: messages.length,
      matched,
    };
  } catch (err) {
    const detail = explainAuthFailure(err as Error, settings.inboxUser);
    await prisma.settings
      .update({
        where: { id: 1 },
        data: { inboxLastError: detail.slice(0, 500), inboxLastCheckedAt: new Date() },
      })
      .catch(() => {});
    return { ok: false, detail };
  }
}

/** True while the listing is still where the system left it. */
async function shouldAdvance(listingId: string): Promise<boolean> {
  const listing = await prisma.listing.findUnique({
    where: { id: listingId },
    select: { status: true },
  });
  return listing?.status === 'email_sent';
}

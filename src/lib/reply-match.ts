/**
 * Deciding what a reply means — pure logic, no mailbox and no database.
 *
 * Separated from inbox.ts so it can be tested offline. These rules decide
 * whether a stranger's email marks a business as interested, and that decision
 * is worth more scrutiny than anything else in the inbox path: a wrong match
 * sends someone to chase a conversation that never happened and quietly retires
 * the one that did.
 */

/** A short, readable extract of a message body for the tracker and the sheet. */
export function toSnippet(text: string): string {
  // Quoted history is the previous message, not the reply, and including it
  // makes every snippet look identical in the tracker.
  const withoutQuotes = text
    .split(/^\s*(?:On .+ wrote:|-----Original Message-----|_{5,}|From:\s)/m)[0] ?? text;

  return withoutQuotes
    .replace(/\r/g, '')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('>'))
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 500);
}

/** Out-of-office, vacation responders, and anything a machine sent. */
export function looksAutomatic(headers: Map<string, unknown>, subject: string): boolean {
  const header = (name: string) => String(headers.get(name) ?? '').toLowerCase();

  if (header('auto-submitted') && header('auto-submitted') !== 'no') return true;
  if (headers.has('x-autoreply') || headers.has('x-autorespond')) return true;
  if (header('precedence').match(/auto_reply|bulk|junk/)) return true;

  return /^\s*(?:automatic reply|out of office|auto(?:matic)?[- ]?response|away from)/i.test(subject);
}

/** A delivery failure. The address is wrong, or the mailbox rejected us. */
export function looksLikeBounce(from: string, subject: string, headers: Map<string, unknown>): boolean {
  if (/mailer-daemon|postmaster|no-?reply@.*(bounce|delivery)/i.test(from)) return true;
  if (String(headers.get('content-type') ?? '').includes('report-type=delivery-status')) return true;
  return /^\s*(?:undeliverable|delivery status notification|mail delivery (?:failed|subsystem)|returned mail)/i.test(
    subject,
  );
}

/** Normalised for comparison: lower case, no punctuation, single spaces. */
const normalise = (text: string) =>
  text.toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();

export interface Candidate {
  id: string;
  listingId: string;
  title: string;
  url: string;
  brokerName: string | null;
}

/**
 * Which listing is this reply about?
 *
 * Strongest signal first, and the rule that fired is returned so a bad match
 * can be traced later rather than argued about.
 */
export function matchReply(
  message: { subject: string; body: string; fromName: string | null },
  listings: Candidate[],
): { listing: Candidate | null; matchedBy: string } {
  const haystack = `${message.subject}\n${message.body}`;
  const normalisedHaystack = normalise(haystack);

  // 1. BizBuySell's own listing number. Unambiguous when present — brokers
  //    quote it, and the site puts it in the enquiry it forwards.
  for (const listing of listings) {
    if (listing.listingId && new RegExp(`\\b${listing.listingId}\\b`).test(haystack)) {
      return { listing, matchedBy: 'listing-id' };
    }
  }

  // 2. The listing URL, pasted or quoted back.
  for (const listing of listings) {
    if (listing.url && haystack.includes(listing.url)) return { listing, matchedBy: 'url' };
  }

  // 3. The title. Requires a substantial run of it, not a couple of common
  //    words — "Established Business For Sale" would otherwise match dozens.
  let best: { listing: Candidate; length: number } | null = null;
  for (const listing of listings) {
    const title = normalise(listing.title);
    if (title.length >= 18 && normalisedHaystack.includes(title)) {
      if (!best || title.length > best.length) best = { listing, length: title.length };
    }
  }
  if (best) return { listing: best.listing, matchedBy: 'title' };

  // 4. The broker's name, and only when exactly one listing has it. A broker
  //    with several listings genuinely IS ambiguous, and picking one of them
  //    would mark the wrong business as answered.
  const senderName = normalise(message.fromName ?? '');
  if (senderName.length >= 5) {
    const byBroker = listings.filter(
      (l) => l.brokerName && normalise(l.brokerName).includes(senderName),
    );
    if (byBroker.length === 1) return { listing: byBroker[0]!, matchedBy: 'broker' };
  }

  return { listing: null, matchedBy: 'none' };
}


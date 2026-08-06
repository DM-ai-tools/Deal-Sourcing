/**
 * HTML in, listings out.
 *
 * Deliberately dependency-free regex and string work rather than a DOM library.
 * The shapes being matched are small and specific — a dollar amount next to a
 * label, an anchor with a listing ID in it — and every parser here degrades to
 * null rather than throwing, because a single odd listing must never abort a
 * sweep of three hundred.
 *
 * Two sources, because BizBuySell publishes the same numbers twice: the result
 * cards carry price and cash flow, and the detail page carries those plus
 * revenue, EBITDA and the broker. Reading cards first means a run can build a
 * useful tracker even if detail pages are blocked, which — given Akamai — is a
 * real operating mode rather than a hypothetical one.
 */
import { listingIdFrom } from './search-url.js';

export interface ExtractedListing {
  listingId: string;
  url: string;
  title: string;
  location: string | null;
  askingPrice: number | null;
  grossRevenue: number | null;
  cashFlow: number | null;
  ebitda: number | null;
  established: string | null;
  brokerName: string | null;
  brokerPhone: string | null;
  isAuction: boolean;
}

/**
 * "$1,440,000" -> 1440000. "Not Disclosed" -> null.
 *
 * Null is a real answer here and must survive to the tracker: BizBuySell shows
 * "Not Disclosed" for EBITDA on most listings, and a zero in that column would
 * read as a business with no earnings rather than one that did not say.
 */
export function parseMoney(input: string | null | undefined): number | null {
  if (!input) return null;
  const text = input.trim();
  if (/not\s*disclosed|n\/?a|undisclosed|—|^-$/i.test(text)) return null;

  const match = text.replace(/,/g, '').match(/\$?\s*([\d.]+)\s*([kmb])?/i);
  if (!match?.[1]) return null;

  const value = Number(match[1]);
  if (!Number.isFinite(value)) return null;

  const suffix = match[2]?.toLowerCase();
  const multiplier = suffix === 'b' ? 1e9 : suffix === 'm' ? 1e6 : suffix === 'k' ? 1e3 : 1;
  return Math.round(value * multiplier);
}

const stripTags = (html: string) =>
  decodeEntities(html.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();

function decodeEntities(input: string): string {
  return input
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#0?39;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)));
}

/**
 * A labelled figure out of a listing page.
 *
 * The detail page renders "Cash Flow (SDE):" and its value in adjacent
 * elements whose exact markup varies by template, so this matches on the label
 * text and then takes the first money-shaped token after it rather than
 * depending on a class name that is not ours to rely on.
 */
function labelledValue(text: string, labels: string[]): string | null {
  for (const label of labels) {
    // Labels arrive as plain English — "Cash Flow (SDE)" — and are escaped
    // exactly once here. Pre-escaping them at the call site and escaping again
    // produced patterns that could never match, which is how EBITDA and cash
    // flow silently came back empty on every listing.
    const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const pattern = new RegExp(
      `${escaped}\\s*:?\\s*([$\\d.,]+\\s*[kmb]?|not\\s*disclosed|n/?a)`,
      'i',
    );
    const match = text.match(pattern);
    if (match?.[1]) return match[1];
  }
  return null;
}

/** Auctions are a different process and the client does not want them. */
export function looksLikeAuction(text: string): boolean {
  return /\bauction\b|bidding\s+(?:ends|closes)|place\s+a\s+bid/i.test(text);
}

/**
 * Every listing linked from a search results page.
 *
 * Anchors are the unit of truth: one per card, each carrying the listing ID.
 * The surrounding markup is then read for the figures the card displays, and
 * anything missing simply stays null until the detail page fills it in.
 */
export function extractSearchResults(html: string): ExtractedListing[] {
  const anchor = /<a\b[^>]*href=["']([^"']*\/business-opportunity\/[^"']+)["'][^>]*>([\s\S]{0,400}?)<\/a>/gi;

  // Collect the anchors first, because a card's boundary is the next card's
  // anchor. A fixed-width window instead of a real boundary reads the following
  // listing's figures and flags — one auction on a page marked its neighbour as
  // an auction too, and prices came out belonging to the card above.
  const anchors: { url: string; listingId: string; title: string; index: number }[] = [];
  let match: RegExpExecArray | null;

  while ((match = anchor.exec(html)) !== null) {
    const href = match[1]!;
    const url = href.startsWith('http') ? href : `https://www.bizbuysell.com${href}`;
    const listingId = listingIdFrom(url);
    if (!listingId) continue;

    const title = stripTags(match[2] ?? '');
    if (!title || title.length < 4) continue;

    anchors.push({ url: url.split('?')[0]!, listingId, title, index: match.index });
  }

  const found = new Map<string, ExtractedListing>();

  for (const [position, entry] of anchors.entries()) {
    if (found.has(entry.listingId)) continue;

    // From this anchor to the next one for a different listing — a card often
    // contains several anchors to itself (image, title, "view details").
    const nextDifferent = anchors.slice(position + 1).find((a) => a.listingId !== entry.listingId);
    const end = Math.min(nextDifferent?.index ?? html.length, entry.index + 4000);
    const cardText = stripTags(html.slice(entry.index, end));

    found.set(entry.listingId, {
      listingId: entry.listingId,
      url: entry.url,
      title: entry.title.slice(0, 300),
      location: locationFrom(cardText),
      askingPrice: parseMoney(labelledValue(cardText, ['Asking Price', 'Price'])),
      grossRevenue: parseMoney(labelledValue(cardText, ['Gross Revenue', 'Revenue'])),
      cashFlow: parseMoney(labelledValue(cardText, ['Cash Flow (SDE)', 'Cash Flow'])),
      ebitda: parseMoney(labelledValue(cardText, ['EBITDA'])),
      established: null,
      brokerName: null,
      brokerPhone: null,
      isAuction: looksLikeAuction(cardText),
    });
  }

  return [...found.values()];
}

/** "Pittsburg, CA (Contra Costa County)" and similar. */
function locationFrom(text: string): string | null {
  const match = text.match(/\b([A-Z][A-Za-z.\- ]{2,40},\s*[A-Z]{2})\b(\s*\([^)]{2,40}\))?/);
  return match ? `${match[1]}${match[2] ?? ''}`.trim() : null;
}

/**
 * The detail page — the authoritative figures.
 *
 * Returns a partial: whatever this page states, and nothing invented. Callers
 * merge it over the card data so a blank here never erases a value the search
 * results already provided.
 */
export function extractListingDetail(html: string, url: string): Partial<ExtractedListing> {
  const text = stripTags(html);

  const title =
    html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i)?.[1] ??
    html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ??
    '';

  const brokerName =
    html.match(/Business\s+Listed\s+By:?\s*<[^>]*>([^<]{2,60})/i)?.[1] ??
    text.match(/Business\s+Listed\s+By:?\s*([A-Z][A-Za-z.'\- ]{2,50})/)?.[1] ??
    null;

  const phone = text.match(/\b(\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4})\b/)?.[1] ?? null;

  return {
    listingId: listingIdFrom(url) ?? undefined,
    url: url.split('?')[0],
    title: stripTags(title).replace(/\s*\|\s*BizBuySell.*$/i, '').slice(0, 300) || undefined,
    location: locationFrom(text),
    askingPrice: parseMoney(labelledValue(text, ['Asking Price'])),
    grossRevenue: parseMoney(labelledValue(text, ['Gross Revenue'])),
    cashFlow: parseMoney(labelledValue(text, ['Cash Flow (SDE)', 'Cash Flow'])),
    ebitda: parseMoney(labelledValue(text, ['EBITDA'])),
    established: text.match(/Established:?\s*(\d{4}|Not\s*Disclosed)/i)?.[1] ?? null,
    brokerName: brokerName?.trim() ?? null,
    brokerPhone: phone,
    isAuction: looksLikeAuction(text),
  };
}

/**
 * Merge detail over card, keeping any figure either source supplied.
 *
 * Written as "prefer the newer value unless it is null" rather than a spread,
 * because a spread would let an absent EBITDA on the detail page wipe one the
 * card had already given us.
 */
export function mergeListing(
  base: ExtractedListing,
  detail: Partial<ExtractedListing>,
): ExtractedListing {
  const pick = <K extends keyof ExtractedListing>(key: K): ExtractedListing[K] => {
    const next = detail[key];
    return (next === null || next === undefined ? base[key] : next) as ExtractedListing[K];
  };

  return {
    listingId: base.listingId,
    url: base.url,
    title: pick('title'),
    location: pick('location'),
    askingPrice: pick('askingPrice'),
    grossRevenue: pick('grossRevenue'),
    cashFlow: pick('cashFlow'),
    ebitda: pick('ebitda'),
    established: pick('established'),
    brokerName: pick('brokerName'),
    brokerPhone: pick('brokerPhone'),
    // An auction flag from either source is believed. Contacting an auction by
    // mistake is worse than skipping a listing that merely mentions the word.
    isAuction: base.isAuction || detail.isAuction === true,
  };
}

/** Does this listing pass the financial filter, given what we know? */
export function withinFinancialRange(
  listing: ExtractedListing,
  filters: { cashFlowMin?: number | null; cashFlowMax?: number | null },
): boolean {
  // Unknown cash flow is kept rather than dropped: the site's own filter has
  // already been applied in the URL, and discarding a listing for a figure we
  // failed to parse would silently shrink the pipeline.
  if (listing.cashFlow == null) return true;
  if (filters.cashFlowMin != null && listing.cashFlow < filters.cashFlowMin) return false;
  if (filters.cashFlowMax != null && listing.cashFlow > filters.cashFlowMax) return false;
  return true;
}

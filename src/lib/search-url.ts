/**
 * Filters in, BizBuySell URLs out.
 *
 * BizBuySell expresses location and industry as SEO path segments and the
 * financial filters as query parameters. Building the URL directly, rather than
 * driving the filter UI with a browser, means the search phase is a handful of
 * plain GETs — far fewer moving parts, and it works through any transport
 * rather than only through a browser.
 *
 * The industry slugs below are the site's own, taken from its category URLs.
 * Keeping them in one exported table means the dashboard's tick boxes and the
 * URL builder can never disagree about what an industry is called.
 */

export interface IndustryOption {
  /** Path segment BizBuySell uses. */
  slug: string;
  /** Exactly the wording in the site's "All Industries" dialog. */
  label: string;
}

/** The twelve on the client's list are marked; all are offered in the UI. */
export const INDUSTRIES: IndustryOption[] = [
  { slug: 'agriculture', label: 'Agriculture' },
  { slug: 'automotive-and-boat', label: 'Automotive & Boat' },
  { slug: 'beauty-and-personal-care', label: 'Beauty & Personal Care' },
  { slug: 'building-and-construction', label: 'Building & Construction' },
  { slug: 'communication-and-media', label: 'Communication & Media' },
  { slug: 'education-and-children', label: 'Education & Children' },
  { slug: 'entertainment-and-recreation', label: 'Entertainment & Recreation' },
  { slug: 'financial-services', label: 'Financial Services' },
  { slug: 'health-care-and-fitness', label: 'Health Care & Fitness' },
  { slug: 'manufacturing', label: 'Manufacturing' },
  { slug: 'non-classifiable-establishments', label: 'Non-Classifiable Establishments' },
  { slug: 'online-and-technology', label: 'Online & Technology' },
  { slug: 'pet-services', label: 'Pet Services' },
  { slug: 'restaurants-and-food', label: 'Restaurants & Food' },
  { slug: 'retail', label: 'Retail' },
  { slug: 'service-businesses', label: 'Service Businesses' },
  { slug: 'transportation-and-storage', label: 'Transportation & Storage' },
  { slug: 'travel', label: 'Travel' },
  { slug: 'wholesale-and-distributors', label: 'Wholesale & Distributors' },
];

/** The client's buy-box, as ticked in their screenshots. */
export const DEFAULT_INDUSTRIES = [
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
];

export const STATES: { code: string; slug: string; label: string }[] = [
  ['AL', 'alabama'], ['AK', 'alaska'], ['AZ', 'arizona'], ['AR', 'arkansas'],
  ['CA', 'california'], ['CO', 'colorado'], ['CT', 'connecticut'], ['DE', 'delaware'],
  ['FL', 'florida'], ['GA', 'georgia'], ['HI', 'hawaii'], ['ID', 'idaho'],
  ['IL', 'illinois'], ['IN', 'indiana'], ['IA', 'iowa'], ['KS', 'kansas'],
  ['KY', 'kentucky'], ['LA', 'louisiana'], ['ME', 'maine'], ['MD', 'maryland'],
  ['MA', 'massachusetts'], ['MI', 'michigan'], ['MN', 'minnesota'], ['MS', 'mississippi'],
  ['MO', 'missouri'], ['MT', 'montana'], ['NE', 'nebraska'], ['NV', 'nevada'],
  ['NH', 'new-hampshire'], ['NJ', 'new-jersey'], ['NM', 'new-mexico'], ['NY', 'new-york'],
  ['NC', 'north-carolina'], ['ND', 'north-dakota'], ['OH', 'ohio'], ['OK', 'oklahoma'],
  ['OR', 'oregon'], ['PA', 'pennsylvania'], ['RI', 'rhode-island'], ['SC', 'south-carolina'],
  ['SD', 'south-dakota'], ['TN', 'tennessee'], ['TX', 'texas'], ['UT', 'utah'],
  ['VT', 'vermont'], ['VA', 'virginia'], ['WA', 'washington'], ['WV', 'west-virginia'],
  ['WI', 'wisconsin'], ['WY', 'wyoming'],
].map(([code, slug]) => ({
  code: code!,
  slug: slug!,
  label: slug!.split('-').map((w) => w[0]!.toUpperCase() + w.slice(1)).join(' '),
}));

export interface SearchFilters {
  states: string[];
  industries: string[];
  cashFlowMin?: number | null;
  cashFlowMax?: number | null;
  revenueMin?: number | null;
  revenueMax?: number | null;
  askingPriceMin?: number | null;
  askingPriceMax?: number | null;
  excludeAuctions?: boolean;
  /** BizBuySell listing-type codes. Defaults to everything except start-ups. */
  listingTypes?: number[];
}

const BASE = 'https://www.bizbuysell.com';

/**
 * How recently a listing was posted, as a sortable number.
 *
 * BizBuySell publishes no posted date — not on the search card, not on the
 * listing page, not in its JSON-LD, not in a meta tag. `datePosted` is null for
 * every listing ever collected, and no parser will change that.
 *
 * What it does publish is the listing id, and those are handed out in sequence
 * as listings are created. Measured across 644 collected listings: the ones
 * that first appeared in the last few daily sweeps — genuinely new to the
 * market — have a median id around 2,540,000, while the bulk collected earlier
 * sits near 2,488,000, and the oldest in the set is 1,702,322. The spread IS
 * the age.
 *
 * So a bigger id means a fresher listing. It is a proxy rather than a date, and
 * worth naming as one: it orders correctly but cannot tell you "posted 3 weeks
 * ago". For deciding who to contact first, ordering is the whole requirement.
 */
export function postedRecency(listingId: string): number {
  const digits = Number(String(listingId).replace(/\D/g, ''));
  // An unparseable id sorts last rather than first — an unknown listing should
  // never jump the queue ahead of one known to be fresh.
  return Number.isFinite(digits) ? digits : 0;
}

/** Newest-posted first. Use with `.sort()`. */
export function newestFirst(a: { listingId: string }, b: { listingId: string }): number {
  return postedRecency(b.listingId) - postedRecency(a.listingId);
}

/**
 * The set of URLs one search expands to.
 *
 * BizBuySell's paths carry one location and one industry each, so a search
 * across twelve industries and three states is thirty-six starting points
 * rather than one. Expanding here — instead of asking the site for a combined
 * view it does not offer — keeps every request a normal, cacheable page that
 * the site is happy to serve.
 */
export function buildSearchUrls(filters: SearchFilters): string[] {
  const industries = filters.industries.length ? filters.industries : ['businesses'];

  // Every state selected is the same request as no state selected — both mean
  // the whole country — but they are not the same cost. BizBuySell's national
  // pages cover all fifty in ONE path, so twelve industries is twelve requests;
  // asking state by state is six hundred, and the site starts refusing long
  // before that finishes. It already has: a fifty-state run read 82 pages, was
  // blocked for the rest, and contacted nobody in three hours.
  //
  // So an all-states selection is collapsed to the national sweep. The operator
  // gets to tick every state — which is what "all of the USA" looks like — and
  // the crawler still does the cheap thing.
  const everyState = filters.states.length >= STATES.length;
  const states = filters.states.length && !everyState ? filters.states : [null];

  const query = financialQuery(filters);
  const urls: string[] = [];

  for (const state of states) {
    const stateSlug = state ? STATES.find((s) => s.code === state)?.slug : null;

    for (const industry of industries) {
      const path =
        industry === 'businesses'
          ? stateSlug
            ? `/${stateSlug}-businesses-for-sale/`
            : `/businesses-for-sale/`
          : stateSlug
            ? `/${stateSlug}/${industry}-businesses-for-sale/`
            : `/${industry}-businesses-for-sale/`;

      urls.push(`${BASE}${path}${query}`);
    }
  }

  return urls;
}

/**
 * Listing types, as BizBuySell numbers them.
 *
 * Read off the site's own Listing Types control. Note there is NO auction type:
 * auctions are a property of individual listings, not a category, which is why
 * they have to be detected from listing text rather than filtered out here.
 */
export const LISTING_TYPES = {
  startups: 20,
  assetSales: 30,
  established: 40,
  realEstate: 80,
} as const;

/** What a search from the site's own homepage applies: everything but start-ups. */
export const DEFAULT_LISTING_TYPES = [
  LISTING_TYPES.assetSales,
  LISTING_TYPES.established,
  LISTING_TYPES.realEstate,
];

/**
 * The financial filters, in BizBuySell's own encoding.
 *
 * The site carries filter state in a single `q` parameter that is base64 of an
 * ordinary query string. This was established by driving the real More Filters
 * dialog and reading what the address bar became — not by guessing, because
 * guessing was tried first and every one of eight plausible parameter names was
 * silently ignored. A search that looks filtered and is not returns the wrong
 * businesses without ever raising an error, which is the failure mode worth the
 * most effort to avoid.
 *
 * Verified encodings:
 *   cffrom / cfto   cash flow (SDE)      1,500+ results -> 92
 *   gifrom / gito   gross revenue        "gross income", NOT grfrom/grto
 *   lt              listing types, comma separated
 *
 * Asking price was not confirmed the same way; `prfrom`/`prto` follows the
 * pattern but is unverified, so it is sent only when explicitly set and should
 * be checked against a result count before anyone relies on it.
 */
function financialQuery(filters: SearchFilters): string {
  const parts: string[] = [];

  const listingTypes = filters.listingTypes?.length
    ? filters.listingTypes
    : DEFAULT_LISTING_TYPES;
  parts.push(`lt=${listingTypes.join(',')}`);

  if (filters.cashFlowMin != null) parts.push(`cffrom=${filters.cashFlowMin}`);
  if (filters.cashFlowMax != null) parts.push(`cfto=${filters.cashFlowMax}`);
  if (filters.revenueMin != null) parts.push(`gifrom=${filters.revenueMin}`);
  if (filters.revenueMax != null) parts.push(`gito=${filters.revenueMax}`);
  if (filters.askingPriceMin != null) parts.push(`prfrom=${filters.askingPriceMin}`);
  if (filters.askingPriceMax != null) parts.push(`prto=${filters.askingPriceMax}`);

  if (parts.length === 0) return '';
  return `?q=${encodeURIComponent(Buffer.from(parts.join('&'), 'utf8').toString('base64'))}`;
}

/** Decode a search URL's `q` back to readable filters. For tests and debugging. */
export function decodeSearchQuery(url: string): string | null {
  try {
    const q = new URL(url).searchParams.get('q');
    return q ? Buffer.from(q, 'base64').toString('utf8') : null;
  } catch {
    return null;
  }
}

/** Page 2 onward of a result set. */
export function paginate(url: string, page: number): string {
  if (page <= 1) return url;

  // The page number is a PATH SEGMENT, not a parameter:
  //   /manufacturing-businesses-for-sale/2/?q=...
  //
  // `?page=2`, and the same key inside the base64 `q` blob, are both accepted
  // and both silently ignored — every one returned page one's listings under a
  // different URL. A sweep built on that would collect the first fifty results
  // over and over, dedupe them back to fifty, and report a complete run over a
  // search with hundreds of matches. Verified by comparing the first listing id
  // rather than the result count, which does not change between pages.
  const parsed = new URL(url);
  parsed.pathname = `${parsed.pathname.replace(/\/$/, '')}/${page}/`;
  return parsed.toString();
}

/**
 * The listing ID out of a BizBuySell URL.
 *
 * `/business-opportunity/<slug>/2537183/` — the number is the stable identity.
 * Titles get rewritten and slugs change with them; this does not, which is what
 * makes it safe as the key that stops a broker being messaged twice.
 */
export function listingIdFrom(url: string): string | null {
  const match = url.match(/\/business-opportunity\/[^/]+\/(\d+)\/?/i);
  return match?.[1] ?? null;
}

export function isListingUrl(url: string): boolean {
  return listingIdFrom(url) !== null;
}

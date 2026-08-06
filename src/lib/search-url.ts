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
}

const BASE = 'https://www.bizbuysell.com';

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
  const states = filters.states.length ? filters.states : [null];

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
 * Financial filters as query parameters.
 *
 * BizBuySell's own "More Filters" dialog posts these names. They are additive:
 * an absent parameter means no bound, which is why undefined is skipped rather
 * than sent as an empty string — an empty bound returns nothing at all.
 */
function financialQuery(filters: SearchFilters): string {
  const params = new URLSearchParams();

  if (filters.cashFlowMin != null) params.set('cf_min', String(filters.cashFlowMin));
  if (filters.cashFlowMax != null) params.set('cf_max', String(filters.cashFlowMax));
  if (filters.revenueMin != null) params.set('gr_min', String(filters.revenueMin));
  if (filters.revenueMax != null) params.set('gr_max', String(filters.revenueMax));
  if (filters.askingPriceMin != null) params.set('pr_min', String(filters.askingPriceMin));
  if (filters.askingPriceMax != null) params.set('pr_max', String(filters.askingPriceMax));

  const query = params.toString();
  return query ? `?${query}` : '';
}

/** Page 2 onward of a result set. */
export function paginate(url: string, page: number): string {
  if (page <= 1) return url;
  const parsed = new URL(url);
  parsed.searchParams.set('page', String(page));
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

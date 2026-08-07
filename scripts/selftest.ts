/**
 * Offline checks.
 *
 * No network, no database, no API key. Everything here is logic that must be
 * right whether or not BizBuySell is reachable today — URL construction,
 * money parsing, listing identity, auction detection, dedupe behaviour. These
 * are the parts that would fail silently and wrongly rather than loudly.
 */
import {
  buildSearchUrls,
  paginate,
  listingIdFrom,
  isListingUrl,
  decodeSearchQuery,
  DEFAULT_LISTING_TYPES,
  INDUSTRIES,
  DEFAULT_INDUSTRIES,
  STATES,
} from '../src/lib/search-url.js';
import {
  parseMoney,
  extractSearchResults,
  extractListingDetail,
  mergeListing,
  looksLikeAuction,
  withinFinancialRange,
  type ExtractedListing,
} from '../src/lib/extract.js';
import { renderMessage, sendDelayMs, DEFAULT_MESSAGE } from '../src/lib/outreach.js';
import { looksBlocked } from '../src/lib/transport.js';

let passed = 0;
let failed = 0;
const failures: string[] = [];

function check(label: string, condition: boolean) {
  if (condition) {
    passed++;
    console.log(`  \x1b[32m✓\x1b[0m ${label}`);
  } else {
    failed++;
    failures.push(label);
    console.log(`  \x1b[31m✗\x1b[0m ${label}`);
  }
}

function section(title: string) {
  console.log(`\n\x1b[1m${title}\x1b[0m`);
}

// ---------------------------------------------------------------------------
section('Money parsing');

check('plain dollars', parseMoney('$1,440,000') === 1440000);
check('no dollar sign', parseMoney('530000') === 530000);
check('with suffix', parseMoney('$2.2M') === 2200000);
check('thousands suffix', parseMoney('$750K') === 750000);
// The single most important null in the system: EBITDA is undisclosed on most
// listings, and a zero there would read as "no earnings" rather than "not said".
check('Not Disclosed is null, never zero', parseMoney('Not Disclosed') === null);
check('N/A is null', parseMoney('N/A') === null);
check('empty is null', parseMoney('') === null);
check('undefined is null', parseMoney(undefined) === null);
check('garbage is null', parseMoney('call for details') === null);

// ---------------------------------------------------------------------------
section('Listing identity');

const sample = 'https://www.bizbuysell.com/business-opportunity/well-established-3pl/2537183/';
check('id extracted from a listing url', listingIdFrom(sample) === '2537183');
check('trailing slash optional', listingIdFrom(sample.replace(/\/$/, '')) === '2537183');
check('query string ignored', listingIdFrom(`${sample}?utm=x`) === '2537183');
check('search url has no listing id', listingIdFrom('https://www.bizbuysell.com/california-businesses-for-sale/') === null);
check('isListingUrl agrees', isListingUrl(sample) && !isListingUrl('https://www.bizbuysell.com/buy/'));
// The slug changes when a broker edits the title; the number does not. Dedupe
// keys off the number for exactly that reason.
check(
  'a renamed listing keeps its identity',
  listingIdFrom('https://www.bizbuysell.com/business-opportunity/totally-different-title/2537183/') ===
    listingIdFrom(sample),
);

// ---------------------------------------------------------------------------
section('Search URL construction');

const urls = buildSearchUrls({
  states: [],
  industries: ['manufacturing', 'financial-services'],
  cashFlowMin: 750000,
  cashFlowMax: 1000000,
});
check('one url per industry when no state is set', urls.length === 2);
check('industry lands in the path', urls[0]!.includes('/manufacturing-businesses-for-sale/'));
// The encoding is BizBuySell's own, established by driving its filter dialog:
// a single `q` parameter holding base64 of an ordinary query string. Eight
// guessed parameter names were silently ignored before this was measured, and a
// search that looks filtered but is not returns the wrong businesses without
// ever raising an error.
check('filters travel in a base64 q parameter', urls[0]!.includes('?q='));
check(
  'cash flow encodes as cffrom/cfto',
  decodeSearchQuery(urls[0]!)?.includes('cffrom=750000&cfto=1000000') === true,
  decodeSearchQuery(urls[0]!) ?? 'no q',
);
check(
  'listing types are always sent',
  decodeSearchQuery(urls[0]!)?.includes('lt=') === true,
);
check(
  'start-ups are excluded by default',
  !decodeSearchQuery(urls[0]!)?.includes('20'),
);

const stateUrls = buildSearchUrls({
  states: ['CA', 'TX'],
  industries: ['manufacturing', 'retail', 'travel'],
});
check('states multiply the url set', stateUrls.length === 6);
check('state slug is used, not the code', stateUrls[0]!.includes('/california/'));
// Listing types are always applied, so there is always a q — but never a
// cash-flow bound that nobody asked for.
check('no cash-flow bound when none was set', !decodeSearchQuery(stateUrls[0]!)?.includes('cffrom'));
check(
  'revenue encodes as gifrom/gito, not grfrom',
  decodeSearchQuery(
    buildSearchUrls({ states: [], industries: ['retail'], revenueMin: 1_000_000 })[0]!,
  )?.includes('gifrom=1000000') === true,
);

const noIndustry = buildSearchUrls({ states: ['CA'], industries: [] });
check('no industry falls back to all businesses', noIndustry[0]!.includes('/california-businesses-for-sale/'));

check('page 1 is the bare url', paginate(urls[0]!, 1) === urls[0]);
// A path segment, not a parameter. ?page=2 and page=2 inside q are both
// accepted and both silently return page one — which would make a sweep
// collect the same fifty results forever and call itself complete.
check('page 2 is a path segment', paginate(urls[0]!, 2).includes('-for-sale/2/'));
check('page 2 is not a query param', !paginate(urls[0]!, 2).includes('page=2'));
check(
  'paginating preserves the filters',
  decodeSearchQuery(paginate(urls[0]!, 3))?.includes('cffrom=750000') === true,
);

// ---------------------------------------------------------------------------
section('Buy-box reference data');

check('twelve industries in the client buy-box', DEFAULT_INDUSTRIES.length === 12);
check(
  'every default industry exists in the catalogue',
  DEFAULT_INDUSTRIES.every((slug) => INDUSTRIES.some((i) => i.slug === slug)),
);
// The excluded ones say as much about the buy-box as the included ones.
check('restaurants are excluded', !DEFAULT_INDUSTRIES.includes('restaurants-and-food'));
check('retail is excluded', !DEFAULT_INDUSTRIES.includes('retail'));
check('travel is excluded', !DEFAULT_INDUSTRIES.includes('travel'));
check('all fifty states are listed', STATES.length === 50);
check('state codes are two letters', STATES.every((s) => s.code.length === 2));

// ---------------------------------------------------------------------------
section('Extraction from search results');

const resultsHtml = `
  <div class="card">
    <a href="/business-opportunity/25-year-la-auto-repair-shop/2481001/">25-Year LA Auto Repair Shop</a>
    <span>Los Angeles, CA (Los Angeles County)</span>
    <span>Asking Price: $258,000</span>
    <span>Cash Flow: $150,000</span>
  </div>
  <div class="card">
    <a href="/business-opportunity/precision-machining-company/2537261/">Precision Machining Company</a>
    <span>Asking Price: $1,440,000</span>
    <span>Cash Flow (SDE): $530,000</span>
    <span>Gross Revenue: $2,220,000</span>
    <span>EBITDA: Not Disclosed</span>
  </div>
  <div class="card">
    <a href="/business-opportunity/estate-auction-lot/2500999/">Estate Auction Lot</a>
    <span>Bidding ends 12 August</span>
  </div>`;

const cards = extractSearchResults(resultsHtml);
check('every listing card is found', cards.length === 3);
check('titles are read', cards[0]!.title.includes('25-Year LA Auto Repair'));
check('relative hrefs become absolute', cards[0]!.url.startsWith('https://www.bizbuysell.com/'));
check('asking price parsed', cards[1]!.askingPrice === 1440000);
check('cash flow parsed from the SDE label', cards[1]!.cashFlow === 530000);
check('gross revenue parsed', cards[1]!.grossRevenue === 2220000);
check('undisclosed ebitda stays null', cards[1]!.ebitda === null);
check('location parsed', cards[0]!.location?.includes('Los Angeles, CA'));
check('auctions are flagged', cards[2]!.isAuction === true);
check('non-auctions are not flagged', cards[1]!.isAuction === false);

const duplicated = extractSearchResults(resultsHtml + resultsHtml);
check('the same listing twice on a page collapses to one', duplicated.length === 3);

check('auction wording detected', looksLikeAuction('This is an auction listing'));
check('bidding wording detected', looksLikeAuction('Bidding closes Friday'));
check('ordinary listing is not an auction', !looksLikeAuction('Established manufacturing business'));

// ---------------------------------------------------------------------------
section('Extraction from a listing page');

const detailHtml = `
  <h1>Owner Op Dealership and Service Center</h1>
  <div>Pittsburg, CA (Contra Costa County)</div>
  <div>Asking Price: $95,000</div>
  <div>Cash Flow (SDE): $110,000</div>
  <div>EBITDA: Not Disclosed</div>
  <div>Gross Revenue: $975,897</div>
  <div>Established: 2019</div>
  <div>Business Listed By: <span>Hamed Hakimi</span></div>`;

const detail = extractListingDetail(detailHtml, sample);
check('detail asking price', detail.askingPrice === 95000);
check('detail cash flow', detail.cashFlow === 110000);
check('detail gross revenue', detail.grossRevenue === 975897);
check('detail ebitda stays null', detail.ebitda === null);
check('established year', detail.established === '2019');
check('broker name', detail.brokerName === 'Hamed Hakimi');
check('title from h1', detail.title?.includes('Owner Op Dealership'));

// ---------------------------------------------------------------------------
section('Merging card and detail');

const base: ExtractedListing = {
  listingId: '1',
  url: 'https://x/business-opportunity/a/1/',
  title: 'From card',
  location: 'Los Angeles, CA',
  askingPrice: 258000,
  grossRevenue: 900000,
  cashFlow: 150000,
  ebitda: 40000,
  established: null,
  brokerName: null,
  brokerPhone: null,
  isAuction: false,
};

const merged = mergeListing(base, {
  title: 'From detail',
  grossRevenue: 975897,
  ebitda: null,
  brokerName: 'Hamed Hakimi',
});

check('detail overrides where it has a value', merged.title === 'From detail');
check('detail fills a better figure', merged.grossRevenue === 975897);
// The bug this prevents: an "EBITDA: Not Disclosed" on the detail page erasing
// a figure the search card had already given us.
check('a null in detail never erases the card value', merged.ebitda === 40000);
check('card value kept when detail is silent', merged.askingPrice === 258000);
check('detail adds what the card lacked', merged.brokerName === 'Hamed Hakimi');
check('auction flag from either source sticks', mergeListing(base, { isAuction: true }).isAuction === true);

// ---------------------------------------------------------------------------
section('Financial filtering');

const inRange = { ...base, cashFlow: 800000 };
const tooLow = { ...base, cashFlow: 500000 };
const tooHigh = { ...base, cashFlow: 2000000 };
const unknown = { ...base, cashFlow: null };
const bounds = { cashFlowMin: 750000, cashFlowMax: 1000000 };

check('in range passes', withinFinancialRange(inRange, bounds));
check('below the floor is dropped', !withinFinancialRange(tooLow, bounds));
check('above the ceiling is dropped', !withinFinancialRange(tooHigh, bounds));
// The site's own filter already ran in the URL; dropping a listing because we
// failed to parse a number would silently shrink the pipeline.
check('unknown cash flow is kept, not dropped', withinFinancialRange(unknown, bounds));

// ---------------------------------------------------------------------------
section('Message and pacing');

check('default message is the client wording', DEFAULT_MESSAGE.includes('We are a family office'));
check('default message asks for the CIM', DEFAULT_MESSAGE.includes('CIM'));
check('default message offers the NDA', DEFAULT_MESSAGE.includes('NDA'));
check('default message signs off correctly', DEFAULT_MESSAGE.includes('Hyperboards Team'));
check(
  'listing placeholder is substituted',
  renderMessage('Regarding {{listing}}.', { title: 'Machining Co' }) === 'Regarding Machining Co.',
);
check(
  'a message with no placeholder is untouched',
  renderMessage(DEFAULT_MESSAGE, { title: 'x' }).includes('Hyperboards Team'),
);

const delays = Array.from({ length: 200 }, () => sendDelayMs(45, 120));
check('delay respects the floor', Math.min(...delays) >= 45000);
check('delay respects the ceiling', Math.max(...delays) <= 120000);
check('delay is actually jittered', new Set(delays).size > 100);
check('a nonsense range still yields a sane delay', sendDelayMs(100, 1) >= 100000);

// ---------------------------------------------------------------------------
section('Bot-wall detection');

check('403 is blocked', looksBlocked(null, 403));
check('429 is blocked', looksBlocked(null, 429));
check('Akamai body is blocked', looksBlocked('<title>Access Denied</title>'));
check('edgesuite reference is blocked', looksBlocked('see https://errors.edgesuite.net/18.75'));
check('a real page is not blocked', !looksBlocked('<html><body>Businesses for sale</body></html>', 200));

// ---------------------------------------------------------------------------
console.log(
  `\n\x1b[1m${failed === 0 ? '\x1b[32mAll checks passed' : '\x1b[31mFailures'}\x1b[0m  ${passed} passed, ${failed} failed\n`,
);
if (failed > 0) {
  console.log('Failed:\n' + failures.map((f) => `  - ${f}`).join('\n') + '\n');
  process.exit(1);
}

/**
 * How does BizBuySell paginate?
 *
 * `?page=2` alongside `q` returns page one again — identical listing ids. That
 * is the quiet kind of wrong: a sweep would collect the first fifty results
 * over and over, dedupe them to fifty, and report a complete run over a search
 * with hundreds of matches.
 *
 * Filters already turned out to live inside the base64 `q` blob rather than as
 * plain parameters, so the page number probably does too. This tries the
 * candidates and compares the FIRST LISTING ID on each — the only reliable
 * evidence that the page actually moved.
 */
import { makeTransport } from '../src/lib/transport.js';
import { extractSearchResults } from '../src/lib/extract.js';

const PATH = 'https://www.bizbuysell.com/manufacturing-businesses-for-sale/';
const FILTERS = 'lt=30,40,80&cffrom=750000&cfto=1000000';

const b64 = (s: string) => encodeURIComponent(Buffer.from(s, 'utf8').toString('base64'));

const CANDIDATES: { label: string; url: string }[] = [
  { label: 'page 1 (baseline)', url: `${PATH}?q=${b64(FILTERS)}` },
  { label: 'q + &page=2 (current)', url: `${PATH}?q=${b64(FILTERS)}&page=2` },
  { label: 'pg=2 inside q', url: `${PATH}?q=${b64(`${FILTERS}&pg=2`)}` },
  { label: 'page=2 inside q', url: `${PATH}?q=${b64(`${FILTERS}&page=2`)}` },
  { label: 'p=2 inside q', url: `${PATH}?q=${b64(`${FILTERS}&p=2`)}` },
  { label: 'start=50 inside q', url: `${PATH}?q=${b64(`${FILTERS}&start=50`)}` },
  { label: '/2/ path segment', url: `${PATH}2/?q=${b64(FILTERS)}` },
];

async function main() {
  const transport = makeTransport({ transport: 'local' });
  const firstIds: Record<string, string> = {};

  try {
    for (const candidate of CANDIDATES) {
      const result = await transport.fetch(candidate.url);
      if (!result.ok || !result.html) {
        console.log(`  ${candidate.label.padEnd(24)} FAILED — ${result.reason}`);
        continue;
      }
      const listings = extractSearchResults(result.html);
      const first = listings[0]?.listingId ?? '(none)';
      firstIds[candidate.label] = first;

      const baseline = firstIds['page 1 (baseline)'];
      const moved = baseline && first !== baseline ? '  <-- MOVED' : '';
      console.log(
        `  ${candidate.label.padEnd(24)} ${String(listings.length).padStart(3)} listings   first id ${first}${moved}`,
      );
    }
  } finally {
    await transport.close();
  }

  console.log('\n  The candidate whose first id differs from the baseline is the real one.\n');
}

main().catch((err) => {
  console.error('probe crashed:', err?.message ?? err);
  process.exit(1);
});

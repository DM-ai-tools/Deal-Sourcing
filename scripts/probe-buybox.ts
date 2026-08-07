/**
 * The real thing, end to end, through the actual production code path.
 *
 * Not a hand-written probe with its own browser setup — this calls
 * `makeTransport()`, `buildSearchUrls()` and `extractSearchResults()` exactly as
 * `runner.ts` does. If this works, the read path works; if it does not, the
 * probes that came before it were measuring something the app does not do.
 *
 * Read-only. Nothing is written to the database and nothing is sent.
 */
import { makeTransport } from '../src/lib/transport.js';
import { buildSearchUrls, decodeSearchQuery, paginate } from '../src/lib/search-url.js';
import { extractSearchResults, withinFinancialRange } from '../src/lib/extract.js';

const FILTERS = {
  states: [],
  industries: ['manufacturing', 'health-care-and-fitness'],
  cashFlowMin: 750_000,
  cashFlowMax: 1_000_000,
  excludeAuctions: true,
};

const money = (n: number | null) => (n == null ? '—' : '$' + n.toLocaleString('en-US'));

async function main() {
  const urls = buildSearchUrls(FILTERS);
  console.log(`\n${urls.length} search URL(s) from the buy-box:\n`);
  for (const url of urls) {
    console.log(`  ${url}`);
    console.log(`     q decodes to: ${decodeSearchQuery(url)}`);
  }

  const transport = makeTransport({ transport: 'local' });
  let total = 0;
  let auctions = 0;
  let outOfBand = 0;

  try {
    for (const base of urls) {
      console.log(`\n${'─'.repeat(72)}`);
      console.log(base.split('?')[0]);

      for (let page = 1; page <= 2; page++) {
        const url = paginate(base, page);
        const result = await transport.fetch(url);

        if (!result.ok || !result.html) {
          console.log(`  page ${page}: FAILED — ${result.reason}`);
          break;
        }

        const listings = extractSearchResults(result.html);
        if (listings.length === 0) {
          console.log(`  page ${page}: no listings (end of results)`);
          break;
        }

        console.log(`  page ${page}: ${listings.length} listings`);

        for (const listing of listings.slice(0, 6)) {
          const inBand = withinFinancialRange(listing, FILTERS);
          if (listing.isAuction) auctions++;
          if (!inBand) outOfBand++;
          console.log(
            `     ${listing.isAuction ? 'A' : ' '}${inBand ? ' ' : '!'} ` +
              `${listing.title.slice(0, 44).padEnd(44)} ` +
              `ask ${money(listing.askingPrice).padStart(12)}  ` +
              `SDE ${money(listing.cashFlow).padStart(11)}  ` +
              `rev ${money(listing.grossRevenue).padStart(12)}`,
          );
        }
        total += listings.length;
      }
    }
  } finally {
    await transport.close();
  }

  console.log(`\n${'═'.repeat(72)}`);
  console.log(`  ${total} listings extracted`);
  console.log(`  ${auctions} flagged as auctions (excluded from outreach)`);
  console.log(`  ${outOfBand} outside the cash-flow band (marked ! above)`);
  console.log(
    total > 0
      ? '  READ PATH WORKS — the buy-box returns real, parsed listings.'
      : '  READ PATH BROKEN — nothing extracted.',
  );
  console.log('═'.repeat(72) + '\n');
  process.exit(total > 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('probe crashed:', err?.message ?? err);
  process.exit(1);
});

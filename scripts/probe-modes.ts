/**
 * Compare every transport against the same page.
 *
 * The point is not to pick a winner once — it is to make the comparison
 * repeatable, because which of these works is a property of the current
 * detection landscape rather than of the code, and it will change.
 *
 * Judged on whether LISTINGS came back, never on the status code. This site
 * answers a blocked client with a complete, valid-looking page shell containing
 * no data, so a 200 proves nothing. That distinction is the single most
 * important thing to preserve in any test written against this site.
 */
import { makeTransport, hasListings, type TransportKind } from '../src/lib/transport.js';
import { buildSearchUrls } from '../src/lib/search-url.js';
import { extractSearchResults } from '../src/lib/extract.js';

const URL = buildSearchUrls({
  states: [],
  industries: ['manufacturing'],
  cashFlowMin: 750_000,
  cashFlowMax: 1_000_000,
})[0]!;

const MODES: TransportKind[] = ['local', 'camoufox', 'firecrawl', 'auto'];

async function main() {
  console.log(`\n  target: ${URL}\n`);
  console.log('  mode        verdict    listings  bytes      detail');
  console.log('  ' + '─'.repeat(74));

  for (const mode of MODES) {
    const started = Date.now();
    let transport;
    try {
      transport = makeTransport({ transport: mode });
    } catch (err) {
      console.log(`  ${mode.padEnd(11)} SKIP       —         —          ${(err as Error).message.slice(0, 34)}`);
      continue;
    }

    try {
      const result = await transport.fetch(URL);
      const listings = result.html ? extractSearchResults(result.html).length : 0;
      const served = result.html ? hasListings(result.html) : false;

      // "ok" is not the verdict. Data is.
      const verdict = listings > 0 ? 'WORKS' : served ? 'PARTIAL' : result.ok ? 'EMPTY' : 'BLOCKED';

      console.log(
        `  ${mode.padEnd(11)} ${verdict.padEnd(10)} ${String(listings).padStart(5)}     ` +
          `${String(result.html?.length ?? 0).padStart(8)}   ` +
          `${((Date.now() - started) / 1000).toFixed(0)}s ${(result.reason ?? '').slice(0, 40)}`,
      );
    } catch (err) {
      console.log(`  ${mode.padEnd(11)} ERROR      —         —          ${(err as Error).message.slice(0, 34)}`);
    } finally {
      await transport.close().catch(() => {});
    }
  }

  console.log('  ' + '─'.repeat(74));
  console.log('  EMPTY means the page was served with no data in it — a soft block.\n');
}

main().catch((err) => {
  console.error('probe crashed:', err?.message ?? err);
  process.exit(1);
});

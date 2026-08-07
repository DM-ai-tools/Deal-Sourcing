/**
 * Is the page empty, or is the extractor failing on real markup?
 *
 * The buy-box URLs are correct and the transport reports success, yet zero
 * listings come out — while a hand-written probe against the same page found
 * fifty. Those two facts cannot both be about the network, so this separates
 * them: fetch through the real transport, then count what is in the HTML by
 * three independent methods before blaming either side.
 */
import { makeTransport } from '../src/lib/transport.js';
import { buildSearchUrls } from '../src/lib/search-url.js';
import { extractSearchResults } from '../src/lib/extract.js';
import { writeFileSync } from 'node:fs';

async function main() {
  const url = buildSearchUrls({
    states: [],
    industries: ['manufacturing'],
    cashFlowMin: 750_000,
    cashFlowMax: 1_000_000,
  })[0]!;

  const transport = makeTransport({ transport: 'local' });
  const result = await transport.fetch(url);
  await transport.close();

  console.log('\nfetch ok    :', result.ok);
  console.log('status      :', result.status);
  console.log('blocked     :', result.blocked ?? false);
  console.log('reason      :', result.reason ?? '—');
  console.log('html bytes  :', result.html?.length ?? 0);

  if (!result.html) return;
  const html = result.html;

  console.log('\n--- what is actually in the HTML ---');
  console.log('  "business-opportunity" occurrences :', (html.match(/business-opportunity/gi) ?? []).length);
  console.log('  "Access Denied"                    :', /access denied/i.test(html));
  console.log('  "Showing" + results                :', /Showing[^<]{0,40}result/i.test(html));

  // Every href that looks like a listing, by the simplest possible rule.
  const hrefs = [...html.matchAll(/href=["']([^"']*business-opportunity[^"']*)["']/gi)].map((m) => m[1]!);
  console.log('  hrefs matching business-opportunity:', hrefs.length);
  console.log('  distinct                           :', new Set(hrefs).size);
  hrefs.slice(0, 3).forEach((h) => console.log('     ', h));

  // The extractor's own anchor pattern, which is the suspect.
  const anchorPattern =
    /<a\b[^>]*href=["']([^"']*\/business-opportunity\/[^"']+)["'][^>]*>([\s\S]{0,400}?)<\/a>/gi;
  console.log('  extractor anchor matches           :', [...html.matchAll(anchorPattern)].length);

  console.log('  extractSearchResults returned      :', extractSearchResults(html).length);

  // If the anchor wraps a whole card, the {0,400} bound is the bug.
  const first = html.indexOf('business-opportunity');
  if (first > 0) {
    const open = html.lastIndexOf('<a', first);
    const close = html.indexOf('</a>', first);
    console.log('\n  first anchor inner length          :', close - open);
    writeFileSync('probe-anchor.html', html.slice(Math.max(0, open - 200), close + 100));
    console.log('  saved probe-anchor.html');
  }
}

main().catch((err) => {
  console.error('probe crashed:', err?.message ?? err);
  process.exit(1);
});

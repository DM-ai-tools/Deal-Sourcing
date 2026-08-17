/**
 * Where does BizBuySell say when a listing was posted?
 *
 * `datePosted` is null for all 644 listings in the database, so either the site
 * does not show it where we look, or it shows it in a shape the regex does not
 * match. Prioritising newest-first is impossible until this is answered, and
 * guessing at a format would produce an ordering that looks right and is not —
 * which is worse than no ordering, because nobody would check it.
 *
 * So: dump every date-shaped string from a search card AND a listing page, with
 * enough surrounding text to tell what each one refers to.
 */
import { makeBrowserTransport } from '../src/lib/transport.js';
import { extractDatePosted } from '../src/lib/extract.js';

const SEARCH =
  'https://www.bizbuysell.com/manufacturing-businesses-for-sale/?q=bHQ9MzAsNDAsODAmY2Zmcm9tPTc1MDAwMCZjZnRvPTEwMDAwMDA%3D';

/** Anything that could be a date, with context. */
function dateLike(text: string): string[] {
  const patterns = [
    /\b\d+\s+(?:hour|day|week|month|year)s?\s+ago\b/gi,
    /\b(?:today|yesterday)\b/gi,
    /\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s+\d{1,2},?\s+\d{4}\b/gi,
    /\b\d{1,2}\/\d{1,2}\/\d{2,4}\b/g,
    /\b(?:listed|posted|added|updated|refreshed)\b[^.\n]{0,40}/gi,
  ];
  const found = new Set<string>();
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) found.add(match[0].replace(/\s+/g, ' ').trim());
  }
  return [...found].slice(0, 25);
}

async function main() {
  const transport = makeBrowserTransport({ transport: (process.env.MODE ?? 'local') as 'local' });

  try {
    const page = await transport.page();

    console.log('\n=== SEARCH RESULTS PAGE ===');
    await page.goto(SEARCH, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    await page.waitForTimeout(6000);
    const searchText = await page.locator('body').innerText().catch(() => '');
    console.log('  page text length:', searchText.length);
    for (const hit of dateLike(searchText)) console.log('   •', hit.slice(0, 90));

    // What the extractor currently makes of it.
    console.log('\n  extractDatePosted(search text) ->', extractDatePosted(searchText));

    // First listing on the page, for the detail view.
    const href = await page
      .locator('a[href*="/business-opportunity/"]')
      .first()
      .getAttribute('href')
      .catch(() => null);

    if (href) {
      const url = href.startsWith('http') ? href : `https://www.bizbuysell.com${href}`;
      console.log(`\n=== LISTING PAGE ===\n  ${url.slice(0, 88)}`);
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
      await page.waitForTimeout(6000);
      const detailText = await page.locator('body').innerText().catch(() => '');
      console.log('  page text length:', detailText.length);
      for (const hit of dateLike(detailText)) console.log('   •', hit.slice(0, 90));
      console.log('\n  extractDatePosted(detail text) ->', extractDatePosted(detailText));

      // Structured data is often richer than the rendered page, and is where a
      // real timestamp would live if one exists at all.
      const structured = await page.evaluate(() => {
        const out: string[] = [];
        for (const el of Array.from(document.querySelectorAll('script[type="application/ld+json"]'))) {
          out.push((el.textContent ?? '').slice(0, 400));
        }
        const meta = Array.from(document.querySelectorAll('meta'))
          .map((m) => `${m.getAttribute('property') ?? m.getAttribute('name')}=${m.getAttribute('content')}`)
          .filter((t) => /date|time|publish|modif/i.test(t));
        return { ld: out.slice(0, 3), meta: meta.slice(0, 10) };
      });
      console.log('\n  JSON-LD blocks:', structured.ld.length);
      for (const block of structured.ld) console.log('    ', block.replace(/\s+/g, ' ').slice(0, 220));
      console.log('  date-ish meta tags:');
      for (const tag of structured.meta) console.log('    ', tag.slice(0, 110));
    }
    console.log();
  } finally {
    await transport.close().catch(() => {});
  }
}

main().catch((err) => {
  console.error('probe crashed:', err?.message ?? err);
  process.exit(1);
});

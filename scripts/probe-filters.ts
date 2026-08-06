/**
 * One-off reconnaissance.
 *
 * Everything about the read path depends on one question: does BizBuySell put
 * its filter state in the URL? If it does, the whole search phase is a handful
 * of GETs that Firecrawl can serve, and the browser is only needed to send
 * messages. If it does not, every run has to drive the filter UI in a real
 * browser before it can read a single listing — a different, slower, far more
 * fragile system.
 *
 * So this drives the actual UI once, watches what the address bar does, and
 * prints the answer. Not committed as part of the app; it exists so the design
 * rests on observation rather than assumption.
 */
import { chromium } from 'playwright';

const START = 'https://www.bizbuysell.com/california-businesses-for-sale/';

async function main() {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    viewport: { width: 1440, height: 900 },
  });

  const seen: string[] = [];
  page.on('framenavigated', (frame) => {
    if (frame === page.mainFrame()) seen.push(frame.url());
  });

  console.log('→ opening search page');
  await page.goto(START, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await page.waitForTimeout(3000);
  console.log('  landed:', page.url());
  console.log('  title :', await page.title());

  // What does the filter bar actually look like?
  const chips = await page
    .locator('button, a')
    .filter({ hasText: /industr|more filters|price range|listing type/i })
    .allTextContents();
  console.log('\n→ filter controls found:', JSON.stringify(chips.slice(0, 12)));

  // Result count, so we can tell whether a filter actually applied.
  const countText = await page
    .locator('text=/Showing .* results/i')
    .first()
    .textContent()
    .catch(() => null);
  console.log('  result count text:', countText?.trim() ?? '(not found)');

  // --- Open "More Filters" and set a cash-flow minimum ---------------------
  console.log('\n→ opening More Filters');
  const moreFilters = page.getByRole('button', { name: /more filters/i }).first();
  if (await moreFilters.isVisible().catch(() => false)) {
    await moreFilters.click();
    await page.waitForTimeout(1500);

    const html = await page.content();
    // Name the selects so we can drive them later.
    const selects = await page.locator('select').evaluateAll((nodes) =>
      nodes.map((n) => ({
        id: (n as HTMLSelectElement).id,
        name: (n as HTMLSelectElement).name,
        options: Array.from((n as HTMLSelectElement).options)
          .slice(0, 4)
          .map((o) => `${o.value}|${o.text}`),
      })),
    );
    console.log('  selects in modal:', JSON.stringify(selects, null, 1).slice(0, 1800));

    const inputs = await page.locator('input').evaluateAll((nodes) =>
      nodes
        .map((n) => ({
          id: (n as HTMLInputElement).id,
          name: (n as HTMLInputElement).name,
          type: (n as HTMLInputElement).type,
          placeholder: (n as HTMLInputElement).placeholder,
        }))
        .filter((n) => n.id || n.name),
    );
    console.log('  inputs in modal:', JSON.stringify(inputs).slice(0, 1200));

    console.log('  modal html mentions cashflow param?', /cf_?min|cashflow|cash_flow/i.test(html));
  } else {
    console.log('  (More Filters button not visible)');
  }

  console.log('\n→ navigations observed:');
  for (const u of [...new Set(seen)]) console.log('   ', u);

  await browser.close();
}

main().catch((err) => {
  console.error('probe failed:', err?.message ?? err);
  process.exit(1);
});

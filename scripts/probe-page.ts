/**
 * What is actually on the search page once we get there?
 *
 * Clicking through reaches the results URL without a block, but the listing
 * selector used so far finds nothing. Either the page is still an interstitial,
 * or the cards use a link shape different from the one the extractor expects.
 * Dumping what is really in the DOM settles which, and the answer decides
 * whether the extractor needs a different selector or the transport needs more
 * work.
 */
import { chromium } from 'playwright';
import { writeFileSync } from 'node:fs';

async function main() {
  const browser = await chromium.launch({
    headless: false,
    channel: 'chrome',
    args: ['--disable-blink-features=AutomationControlled', '--no-first-run'],
  });
  const context = await browser.newContext({
    viewport: { width: 1500, height: 950 },
    locale: 'en-US',
    timezoneId: 'America/New_York',
  });
  await context.addInitScript(`
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    window.chrome = { runtime: {}, loadTimes: () => {}, csi: () => {} };
  `);
  const page = await context.newPage();

  await page.goto('https://www.bizbuysell.com/', { waitUntil: 'load', timeout: 60_000 });
  await page.waitForTimeout(9000);
  await page.mouse.move(640, 380);

  await page.getByRole('button', { name: /^search$/i }).first().click();
  await page.waitForTimeout(12_000); // generous: results render client-side

  console.log('url  :', page.url());
  console.log('title:', await page.title());

  const text = await page.locator('body').innerText().catch(() => '');
  console.log('\n--- first 700 chars of visible text ---');
  console.log(text.slice(0, 700).replace(/\n{2,}/g, '\n'));

  // No helper functions inside evaluate: tsx compiles them with a `__name`
  // shim that does not exist in the page's context.
  const hrefs: string[] = await page.$$eval('a', (nodes) =>
    nodes.map((n) => (n as HTMLAnchorElement).href),
  );

  console.log('\n--- link shapes ---');
  console.log('  total links        :', hrefs.length);
  console.log('  business-opportunity:', hrefs.filter((h) => /business-opportunity/i.test(h)).length);
  console.log('  -for-sale          :', hrefs.filter((h) => /-for-sale/i.test(h)).length);
  console.log('  ending in an id    :', hrefs.filter((h) => /\/\d{6,}\/?$/.test(h)).length);
  console.log('  distinct with digits:');
  [...new Set(hrefs.filter((h) => /\d{6,}/.test(h)))].slice(0, 8).forEach((h) => console.log('     ', h));

  const html = await page.content();
  writeFileSync('search-page.html', html);
  console.log(`\nsaved search-page.html (${html.length} bytes) for offline inspection`);

  await page.screenshot({ path: 'search-page.png', fullPage: false });
  console.log('saved search-page.png');

  await browser.close();
}

main().catch((err) => {
  console.error('probe failed:', err?.message ?? err);
  process.exit(1);
});

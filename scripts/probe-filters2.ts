/**
 * What does BizBuySell actually accept as a cash-flow filter?
 *
 * The probe that got through reported "Showing 1,500+ results" for
 * manufacturing at a supposed $750k-$1M SDE band. That is not plausible, so the
 * `cf_min`/`cf_max` query parameters invented in search-url.ts are being
 * ignored — the site takes its filter state in a single `q` parameter that is
 * base64 of an ordinary query string. A default search returns
 * q=bHQ9MzAsNDAsODA= which decodes to `lt=30,40,80`, the listing-type filter.
 *
 * Guessing the cash-flow key would produce a system that runs beautifully and
 * silently profiles the wrong businesses — the worst kind of wrong. So this
 * asks the site: it requests a baseline and then each candidate encoding, and
 * compares the reported result counts. The encoding that changes the count is
 * the real one; the ones that do not are being ignored.
 *
 * Read-only.
 */
import { chromium } from 'patchright';
import path from 'node:path';
import os from 'node:os';

const PROFILE = process.env.PROFILE_DIR ?? path.join(os.tmpdir(), 'bbs-probe-profile');
const BASE = 'https://www.bizbuysell.com/manufacturing-businesses-for-sale/';

const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64');

/**
 * Candidates, drawn from the one encoding we have confirmed (`lt=30,40,80`)
 * and from the labels the More Filters dialog uses.
 */
const CANDIDATES: { label: string; query: string }[] = [
  { label: 'baseline (no q)', query: '' },
  { label: 'cf=min,max', query: 'cf=750000,1000000' },
  { label: 'cfl=min,max', query: 'cfl=750000,1000000' },
  { label: 'cash=min,max', query: 'cash=750000,1000000' },
  { label: 'sde=min,max', query: 'sde=750000,1000000' },
  { label: 'cf=min,max + lt', query: 'lt=30,40,80&cf=750000,1000000' },
  { label: 'cfmin/cfmax pair', query: 'cfmin=750000&cfmax=1000000' },
  { label: 'gr=min,max (revenue)', query: 'gr=750000,1000000' },
];

async function main() {
  const context = await chromium.launchPersistentContext(PROFILE, {
    channel: 'chrome',
    headless: false,
    viewport: null,
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });
  const page = context.pages()[0] ?? (await context.newPage());

  // Warm up on the homepage first — reaching a deep URL cold was refused before.
  await page.goto('https://www.bizbuysell.com/', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(7000);
  await page.mouse.move(600, 400);
  await page.mouse.wheel(0, 500);

  console.log('\n  encoding                        results        listings');
  console.log('  ' + '─'.repeat(64));

  for (const candidate of CANDIDATES) {
    const url = candidate.query ? `${BASE}?q=${encodeURIComponent(b64(candidate.query))}` : BASE;
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
      await page.waitForTimeout(9000);

      const title = await page.title();
      if (/access denied/i.test(title)) {
        console.log(`  ${candidate.label.padEnd(30)} BLOCKED`);
        continue;
      }

      const count =
        (await page
          .locator('text=/Showing .*result/i')
          .first()
          .textContent()
          .catch(() => null)) ?? '(none)';

      const hrefs: string[] = await page.$$eval('a', (nodes) =>
        nodes.map((n) => (n as HTMLAnchorElement).href),
      );
      const listings = new Set(hrefs.filter((h) => /business-opportunity\/[^/]+\/\d+/.test(h))).size;

      console.log(
        `  ${candidate.label.padEnd(30)} ${count.replace(/Showing\s*/i, '').replace(/\s*sorted by.*/i, '').trim().padEnd(14)} ${listings}`,
      );
    } catch (err) {
      console.log(`  ${candidate.label.padEnd(30)} ERROR ${(err as Error).message.slice(0, 30)}`);
    }
  }

  console.log('  ' + '─'.repeat(64));
  console.log('  The encoding whose count differs from baseline is the real one.\n');

  await context.close();
}

main().catch((err) => {
  console.error('probe crashed:', err?.message ?? err);
  process.exit(1);
});

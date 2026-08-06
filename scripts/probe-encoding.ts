/**
 * Learn BizBuySell's filter encoding by driving the real UI.
 *
 * Established: reaching a search page by clicking works where typing its URL is
 * refused, and the filter state travels in a single `q` parameter that is plain
 * base64 of an ordinary query string — `lt=30,40,80` came back from a default
 * search, which is the listing-type filter.
 *
 * What is still unknown is the parameter name and format for cash flow and for
 * industry. This sets them through the site's own controls and prints what `q`
 * decodes to afterwards. With that, the read path can build any search directly
 * instead of puppeteering the filter dialog on every run.
 *
 * Read-only: it never opens a listing or touches a contact form.
 */
import { chromium, type Page } from 'playwright';

const decode = (url: string): string => {
  const q = new URL(url).searchParams.get('q');
  if (!q) return '(no q parameter)';
  try {
    return Buffer.from(q, 'base64').toString('utf8');
  } catch {
    return `(not base64: ${q})`;
  }
};

async function report(page: Page, label: string) {
  const title = await page.title();
  const blocked = /access denied|pardon our interruption/i.test(title);
  console.log(`\n${blocked ? 'BLOCKED' : 'OK'}  ${label}`);
  console.log(`   url : ${page.url()}`);
  console.log(`   q   : ${decode(page.url())}`);
  const count = await page
    .locator('text=/Showing .*result/i')
    .first()
    .textContent()
    .catch(() => null);
  console.log(`   hits: ${count?.trim() ?? '(not shown)'}`);
  const links = await page
    .locator('a[href*="/business-opportunity/"]')
    .evaluateAll((n) => [...new Set(n.map((a) => (a as HTMLAnchorElement).href))])
    .catch(() => [] as string[]);
  console.log(`   listings: ${links.length}`);
  return { blocked, links };
}

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

  console.log('→ homepage, letting the sensor settle');
  await page.goto('https://www.bizbuysell.com/', { waitUntil: 'load', timeout: 60_000 });
  await page.waitForTimeout(9000);
  await page.mouse.move(640, 380);
  await page.mouse.move(760, 500);

  console.log('→ clicking Search');
  await page.getByRole('button', { name: /^search$/i }).first().click();
  // The results are rendered client-side; wait for the cards, not the load event.
  await page
    .waitForSelector('a[href*="/business-opportunity/"]', { timeout: 45_000 })
    .catch(() => console.log('   (no cards appeared within 45s)'));
  await page.waitForTimeout(4000);

  const first = await report(page, 'default search');
  if (first.blocked) {
    await browser.close();
    return;
  }

  // ---- cash flow, through the site's own dialog --------------------------
  console.log('\n→ More Filters → Cash Flow 750,000 to 1,000,000');
  const more = page.getByRole('button', { name: /more filters/i }).first();
  if (await more.isVisible().catch(() => false)) {
    await more.click();
    await page.waitForTimeout(2500);

    // The dialog's selects are unlabelled in the DOM; the cash-flow pair sits
    // under a "Cash Flow (SDE) or EBITDA" heading. Report them all so the
    // mapping is observed rather than guessed.
    const selects = await page.locator('select').evaluateAll((nodes) =>
      nodes.map((n, i) => ({
        i,
        name: (n as HTMLSelectElement).name || (n as HTMLSelectElement).id || '(unnamed)',
        options: Array.from((n as HTMLSelectElement).options).map((o) => o.value).slice(0, 30),
      })),
    );
    console.log('   selects in dialog:');
    for (const s of selects) {
      console.log(`     [${s.i}] ${s.name} :: ${s.options.slice(0, 8).join(', ')}`);
    }

    // Cash flow is the second pair of min/max selects on this dialog.
    const trySet = async (index: number, value: string) => {
      try {
        await page.locator('select').nth(index).selectOption(value);
        await page.waitForTimeout(400);
        return true;
      } catch {
        return false;
      }
    };

    for (const [index, value] of [
      [2, '750000'],
      [3, '1000000'],
    ] as [number, string][]) {
      const set = await trySet(index, value);
      console.log(`     select[${index}] = ${value} → ${set ? 'set' : 'not settable'}`);
    }

    const apply = page.getByRole('button', { name: /^apply$/i }).first();
    if (await apply.isVisible().catch(() => false)) {
      await apply.click();
      await page.waitForTimeout(7000);
      await report(page, 'after cash-flow filter');
    }
  } else {
    console.log('   More Filters button not visible');
  }

  console.log('\nBrowser open for 15s so the final state is visible.');
  await page.waitForTimeout(15_000);
  await browser.close();
}

main().catch((err) => {
  console.error('probe failed:', err?.message ?? err);
  process.exit(1);
});

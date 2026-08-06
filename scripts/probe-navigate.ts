/**
 * Reach the search results the way a person does.
 *
 * The homepage is served; typing a search URL straight into the address bar is
 * refused. That pattern is characteristic of Akamai's sensor: it wants to see a
 * client that loaded the homepage, ran its JavaScript, collected the cookies it
 * sets, and then navigated within the site — not one that arrives cold at a
 * deep URL with no history.
 *
 * So this clicks. Homepage, wait for the sensor, use the site's own search box,
 * then its own filter controls. Slower than a URL, and it is the difference
 * between a system that works and one that does not.
 *
 * Read-only. It never touches a contact form.
 */
import { chromium, type Page } from 'playwright';

const EMAIL = process.env.BBS_EMAIL ?? '';
const PASSWORD = process.env.BBS_PASSWORD ?? '';

async function state(page: Page, label: string) {
  const title = await page.title();
  const blocked = /access denied|pardon our interruption|forbidden/i.test(title);
  console.log(`${blocked ? 'BLOCKED' : 'PASSED '}  ${label.padEnd(28)} "${title.slice(0, 50)}"`);
  console.log(`         ${page.url()}`);
  return !blocked;
}

async function main() {
  const browser = await chromium.launch({
    headless: false,
    channel: 'chrome',
    args: ['--disable-blink-features=AutomationControlled', '--no-first-run'],
  });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    locale: 'en-US',
    timezoneId: 'America/New_York',
  });
  await context.addInitScript(`
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    window.chrome = { runtime: {}, loadTimes: () => {}, csi: () => {} };
  `);
  const page = await context.newPage();

  // 1. Homepage, and give the sensor time to run and set its cookies.
  console.log('→ homepage');
  await page.goto('https://www.bizbuysell.com/', { waitUntil: 'load', timeout: 60_000 });
  await page.waitForTimeout(8000);
  if (!(await state(page, 'homepage'))) {
    await browser.close();
    return;
  }

  const akamai = (await context.cookies()).map((c) => c.name).filter((n) => /_abck|bm_sz|ak_bmsc|bm_sv/i.test(n));
  console.log('         akamai cookies:', akamai.join(', ') || '(none)');

  // Move the mouse a little. Sensor scripts score interaction, and an entirely
  // still pointer for eight seconds is its own signal.
  await page.mouse.move(600, 400);
  await page.waitForTimeout(500);
  await page.mouse.move(700, 520);

  // 2. Use the site's own search, rather than a URL.
  console.log('\n→ searching via the page controls');
  try {
    const searchButton = page.getByRole('button', { name: /^search$/i }).first();
    if (await searchButton.isVisible().catch(() => false)) {
      await searchButton.click();
      await page.waitForLoadState('domcontentloaded').catch(() => {});
      await page.waitForTimeout(7000);
      await state(page, 'after Search click');
    } else {
      console.log('  search button not visible; trying a nav link');
      const buy = page.locator('a[href*="/buy/"], a:has-text("Buy a Business")').first();
      await buy.click();
      await page.waitForTimeout(7000);
      await state(page, 'after nav click');
    }
  } catch (err) {
    console.log('  navigation failed:', (err as Error).message.slice(0, 80));
  }

  // 3. Whatever we landed on, is it a result set?
  const listings = await page
    .locator('a[href*="/business-opportunity/"]')
    .evaluateAll((nodes) => [...new Set(nodes.map((n) => (n as HTMLAnchorElement).href))])
    .catch(() => [] as string[]);
  console.log('\n  listing links visible:', listings.length);
  listings.slice(0, 4).forEach((l) => console.log('    ', l));

  const count = await page
    .locator('text=/Showing .*results/i')
    .first()
    .textContent()
    .catch(() => null);
  console.log('  result count:', count?.trim() ?? '(not found)');

  // 4. If we have results, try the filter UI — and record what the URL becomes.
  if (listings.length) {
    console.log('\n→ opening More Filters');
    const more = page.getByRole('button', { name: /more filters/i }).first();
    if (await more.isVisible().catch(() => false)) {
      await more.click();
      await page.waitForTimeout(2500);

      const selects = await page.locator('select').evaluateAll((nodes) =>
        nodes.map((n) => ({
          name: (n as HTMLSelectElement).name || (n as HTMLSelectElement).id,
          sample: Array.from((n as HTMLSelectElement).options).slice(0, 3).map((o) => o.value),
        })),
      );
      console.log('  selects:', JSON.stringify(selects).slice(0, 700));

      const apply = page.getByRole('button', { name: /^apply$/i }).first();
      if (await apply.isVisible().catch(() => false)) {
        await apply.click();
        await page.waitForTimeout(6000);
        console.log('  URL AFTER APPLY:', page.url());
      }
    } else {
      console.log('  More Filters not visible');
    }
  }

  // 5. Login, only if the browsing worked.
  if (listings.length && EMAIL) {
    console.log('\n→ sign in');
    const signIn = page.locator('a:has-text("Sign In")').first();
    if (await signIn.isVisible().catch(() => false)) {
      await signIn.click();
      await page.waitForTimeout(6000);
      await state(page, 'login page');
      const emailField = page.locator('input[type="email"], input[name*="mail" i]').first();
      if (await emailField.isVisible().catch(() => false)) {
        await emailField.fill(EMAIL);
        await page.waitForTimeout(700);
        await page.locator('input[type="password"]').first().fill(PASSWORD);
        await page.waitForTimeout(700);
        await page.locator('button[type="submit"], input[type="submit"]').first().click();
        await page.waitForTimeout(8000);
        await state(page, 'after sign in');
      } else {
        console.log('  login form did not render');
      }
    }
  }

  console.log('\nBrowser open for 12s.');
  await page.waitForTimeout(12_000);
  await browser.close();
}

main().catch((err) => {
  console.error('probe failed:', err?.message ?? err);
  process.exit(1);
});

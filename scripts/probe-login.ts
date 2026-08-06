/**
 * End-to-end check with the buyer's own account.
 *
 * Launches a clean, visible Chrome — no profile of the operator's is read or
 * copied — signs in with the supplied credentials, applies the buy-box filters,
 * and reports what it can see. Reads only: it stops short of the contact form's
 * Send button, so nothing can reach a broker from a test run.
 *
 * Credentials come from the environment, never from source:
 *   BBS_EMAIL=... BBS_PASSWORD=... npx tsx scripts/probe-login.ts
 */
import { chromium } from 'playwright';

const EMAIL = process.env.BBS_EMAIL ?? '';
const PASSWORD = process.env.BBS_PASSWORD ?? '';

const SEARCH =
  'https://www.bizbuysell.com/manufacturing-businesses-for-sale/?cf_min=750000&cf_max=1000000';

async function main() {
  if (!EMAIL || !PASSWORD) {
    console.log('Set BBS_EMAIL and BBS_PASSWORD in the environment first.');
    process.exit(1);
  }

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

  const visit = async (label: string, url: string, pause = 6000) => {
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
      await page.waitForTimeout(pause);
      const title = await page.title();
      const blocked = /access denied|pardon our interruption|forbidden/i.test(title);
      console.log(`${blocked ? 'BLOCKED' : 'PASSED '}  ${label.padEnd(22)} "${title.slice(0, 55)}"`);
      return !blocked;
    } catch (err) {
      console.log(`ERROR    ${label.padEnd(22)} ${(err as Error).message.slice(0, 70)}`);
      return false;
    }
  };

  // 1. Reachable at all?
  if (!(await visit('homepage', 'https://www.bizbuysell.com/'))) {
    console.log('\nBlocked at the front door. Nothing below can be tested from this network.');
    await browser.close();
    return;
  }

  // 2. Sign in.
  console.log('\n→ signing in');
  await page.goto('https://www.bizbuysell.com/users/login.aspx', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(3000);

  const emailField = page.locator('input[type="email"], input[name*="mail" i]').first();
  if (await emailField.isVisible().catch(() => false)) {
    await emailField.fill(EMAIL);
    await page.waitForTimeout(600);
    await page.locator('input[type="password"]').first().fill(PASSWORD);
    await page.waitForTimeout(600);
    await page.locator('button[type="submit"], input[type="submit"]').first().click();
    await page.waitForTimeout(6000);
    const anonymous = await page
      .locator('a:has-text("Sign In")')
      .first()
      .isVisible()
      .catch(() => false);
    console.log(anonymous ? '  still signed out — check credentials' : '  signed in');
  } else {
    console.log('  login form did not render');
  }

  // 3. The filtered search — and what the address bar actually says.
  console.log('\n→ filtered search');
  if (await visit('search', SEARCH)) {
    console.log('  final url    :', page.url());
    const count = await page
      .locator('text=/Showing .*results/i')
      .first()
      .textContent()
      .catch(() => null);
    console.log('  result count :', count?.trim() ?? '(not found)');

    const links = await page
      .locator('a[href*="/business-opportunity/"]')
      .evaluateAll((nodes) => [...new Set(nodes.map((n) => (n as HTMLAnchorElement).href))]);
    console.log('  listings     :', links.length);
    links.slice(0, 5).forEach((l) => console.log('     ', l));

    // 4. A listing, and whether the form is prefilled once signed in.
    if (links[0]) {
      console.log('\n→ listing detail');
      if (await visit('listing', links[0]!, 5000)) {
        const value = async (selector: string) =>
          page.locator(selector).first().inputValue().catch(() => '');
        console.log('  name field   :', (await value('input[placeholder*="Full Name" i]')) || '(empty)');
        console.log('  email field  :', (await value('input[type="email"]')) || '(empty)');
        console.log('  textareas    :', await page.locator('textarea').count());
        console.log('  send buttons :', await page.getByRole('button', { name: /send message/i }).count());
        console.log('\n  NOTHING WAS SENT — this probe never clicks Send.');
      }
    }
  }

  console.log('\nBrowser stays open for 10s.');
  await page.waitForTimeout(10_000);
  await browser.close();
}

main().catch((err) => {
  console.error('probe failed:', err?.message ?? err);
  process.exit(1);
});

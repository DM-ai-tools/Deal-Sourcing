/**
 * Does a warmed, persistent browser session get past Akamai?
 *
 * Established so far: the homepage is served to everyone, while /buy/ and the
 * listing pages are not — and curl from this very machine gets 403 while the
 * user's own Chrome renders the site perfectly. That combination says the block
 * is Akamai's sensor script judging the client, not the IP.
 *
 * A real person never lands on a search URL cold. They hit the homepage, the
 * sensor runs, it sets its cookies, and every later request carries them. This
 * reproduces that: a persistent profile, a homepage visit, a human pause, then
 * navigation to the pages that matter. If this passes, the whole system can run
 * on an ordinary browser session and no proxy is needed.
 */
import { chromium } from 'playwright';
import path from 'node:path';

const PROFILE = path.join(process.cwd(), '.browser-profile');

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

async function main() {
  const context = await chromium.launchPersistentContext(PROFILE, {
    headless: false,
    channel: 'chrome',
    viewport: { width: 1440, height: 900 },
    userAgent: UA,
    locale: 'en-US',
    timezoneId: 'America/New_York',
    args: ['--disable-blink-features=AutomationControlled', '--start-maximized'],
  });

  await context.addInitScript(`
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    window.chrome = { runtime: {}, loadTimes: () => {}, csi: () => {} };
  `);

  const page = context.pages()[0] ?? (await context.newPage());

  const visit = async (label: string, url: string, pause = 4000) => {
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
      await page.waitForTimeout(pause);
      const title = await page.title();
      const blocked = /access denied|forbidden|pardon our interruption/i.test(title);
      console.log(`${blocked ? 'BLOCKED' : 'PASSED '}  ${label.padEnd(26)} "${title}"`);
      return !blocked;
    } catch (err) {
      console.log(`ERROR    ${label.padEnd(26)} ${(err as Error).message.slice(0, 70)}`);
      return false;
    }
  };

  // 1. Warm up exactly as a person would.
  await visit('homepage (warm-up)', 'https://www.bizbuysell.com/', 6000);

  // Akamai's cookies are the whole point of the warm-up — show whether they landed.
  const cookies = await context.cookies();
  console.log(
    '  cookies set:',
    cookies.map((c) => c.name).filter((n) => /^_abck|bm_sz|ak_bmsc|bm_sv|RT/i.test(n)).join(', ') || '(no Akamai cookies)',
  );

  // 2. Now the pages that matter, reached by navigation rather than cold.
  const searchOk = await visit('search page', 'https://www.bizbuysell.com/california-businesses-for-sale/', 6000);

  if (searchOk) {
    const links = await page
      .locator('a[href*="/business-opportunity/"]')
      .evaluateAll((nodes) => nodes.map((n) => (n as HTMLAnchorElement).href).slice(0, 3));
    console.log('  listing links found:', links.length);
    if (links[0]) {
      const listingOk = await visit('listing detail', links[0], 5000);
      if (listingOk) {
        const hasForm = await page.locator('textarea, input[type="email"]').count();
        console.log('  contact form controls on listing:', hasForm);
      }
    }
  }

  await context.close();
}

main().catch((err) => {
  console.error('probe failed:', err?.message ?? err);
  process.exit(1);
});

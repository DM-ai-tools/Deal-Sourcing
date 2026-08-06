/**
 * Which browser configuration does BizBuySell actually let through?
 *
 * Plain headless Chromium gets "Access Denied" — the site fingerprints
 * automation. Since the whole write path depends on driving a real session,
 * this tries the configurations in increasing order of cost and reports the
 * cheapest one that works. Guessing here would mean building the send path on
 * a browser that is blocked in production.
 */
import { chromium, type Browser, type BrowserContext } from 'playwright';

const TARGET = 'https://www.bizbuysell.com/california-businesses-for-sale/';

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

/** Strips the automation tells a stock Playwright page leaves behind. */
const STEALTH = `
  Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
  Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
  window.chrome = { runtime: {}, loadTimes: () => {}, csi: () => {} };
  const origQuery = window.navigator.permissions.query;
  window.navigator.permissions.query = (p) =>
    p.name === 'notifications'
      ? Promise.resolve({ state: Notification.permission })
      : origQuery(p);
`;

const ARGS = [
  '--disable-blink-features=AutomationControlled',
  '--no-sandbox',
  '--disable-dev-shm-usage',
];

async function check(label: string, make: () => Promise<{ browser: Browser; context: BrowserContext }>) {
  let browser: Browser | null = null;
  try {
    const made = await make();
    browser = made.browser;
    const page = await made.context.newPage();
    await page.goto(TARGET, { waitUntil: 'domcontentloaded', timeout: 45_000 });
    await page.waitForTimeout(3500);
    const title = await page.title();
    const body = (await page.locator('body').innerText().catch(() => '')).slice(0, 120);
    const blocked = /access denied|forbidden|are you a human|verify you are/i.test(`${title} ${body}`);
    console.log(`${blocked ? 'BLOCKED ' : 'PASSED  '} ${label.padEnd(38)} title="${title}"`);
    return !blocked;
  } catch (err) {
    console.log(`ERROR   ${label.padEnd(38)} ${(err as Error).message.slice(0, 90)}`);
    return false;
  } finally {
    await browser?.close().catch(() => {});
  }
}

async function main() {
  await check('headless chromium, stock', async () => {
    const browser = await chromium.launch({ headless: true });
    return { browser, context: await browser.newContext() };
  });

  await check('headless + UA + stealth', async () => {
    const browser = await chromium.launch({ headless: true, args: ARGS });
    const context = await browser.newContext({ userAgent: UA, viewport: { width: 1440, height: 900 }, locale: 'en-US' });
    await context.addInitScript(STEALTH);
    return { browser, context };
  });

  await check('headed chromium + stealth', async () => {
    const browser = await chromium.launch({ headless: false, args: ARGS });
    const context = await browser.newContext({ userAgent: UA, viewport: { width: 1440, height: 900 }, locale: 'en-US' });
    await context.addInitScript(STEALTH);
    return { browser, context };
  });

  await check('real Chrome channel, headed', async () => {
    const browser = await chromium.launch({ headless: false, channel: 'chrome', args: ARGS });
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'en-US' });
    await context.addInitScript(STEALTH);
    return { browser, context };
  });

  await check('real Chrome channel, headless', async () => {
    const browser = await chromium.launch({ headless: true, channel: 'chrome', args: ARGS });
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'en-US' });
    await context.addInitScript(STEALTH);
    return { browser, context };
  });
}

main();

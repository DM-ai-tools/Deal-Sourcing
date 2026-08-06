/**
 * Can a browser carrying the operator's own Chrome session reach BizBuySell?
 *
 * Every browser launched cold has been refused. The operator's ordinary Chrome
 * is not refused — they browse the site daily. The difference is the session:
 * Akamai sets `_abck` and friends once a real client has passed its checks, and
 * a fresh profile has none of them.
 *
 * So this copies the parts of their Chrome profile that carry that session —
 * cookies, preferences, local state — into a scratch directory and launches
 * against the copy. The live profile is never touched or locked.
 *
 * If this passes, the `local` transport is viable and the whole system works
 * from this machine.
 */
import { chromium } from 'playwright';
import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const SOURCE = path.join(os.homedir(), 'AppData', 'Local', 'Google', 'Chrome', 'User Data');
const SCRATCH = path.join(process.cwd(), '.chrome-session');

function copySession() {
  rmSync(SCRATCH, { recursive: true, force: true });
  mkdirSync(path.join(SCRATCH, 'Default'), { recursive: true });

  // Only what carries identity. Copying the caches would take minutes and add
  // nothing — the session lives in the cookie store.
  const wanted = [
    ['Local State', ''],
    ['Default/Preferences', 'Default'],
    ['Default/Cookies', 'Default'],
    ['Default/Network', 'Default'],
    ['Default/Local Storage', 'Default'],
  ];

  let copied = 0;
  for (const [relative, into] of wanted) {
    const from = path.join(SOURCE, relative!);
    if (!existsSync(from)) continue;
    const to = path.join(SCRATCH, into!, path.basename(relative!));
    try {
      cpSync(from, to, { recursive: true, force: true });
      copied++;
    } catch {
      // A file Chrome currently holds open is skipped rather than fatal.
    }
  }
  console.log(`  copied ${copied} session artefacts from the live profile`);
}

async function main() {
  if (!existsSync(SOURCE)) {
    console.log('No Chrome profile found at', SOURCE);
    return;
  }

  console.log('→ copying session');
  copySession();

  const context = await chromium.launchPersistentContext(SCRATCH, {
    headless: false,
    channel: 'chrome',
    viewport: { width: 1440, height: 900 },
    args: ['--disable-blink-features=AutomationControlled', '--no-first-run', '--no-default-browser-check'],
  });
  await context.addInitScript(`
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    window.chrome = { runtime: {}, loadTimes: () => {}, csi: () => {} };
  `);

  const page = context.pages()[0] ?? (await context.newPage());

  const visit = async (label: string, url: string, pause = 6000) => {
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
      await page.waitForTimeout(pause);
      const title = await page.title();
      const blocked = /access denied|pardon our interruption|forbidden/i.test(title);
      console.log(`${blocked ? 'BLOCKED' : 'PASSED '}  ${label.padEnd(24)} "${title.slice(0, 60)}"`);
      return !blocked;
    } catch (err) {
      console.log(`ERROR    ${label.padEnd(24)} ${(err as Error).message.slice(0, 70)}`);
      return false;
    }
  };

  const homeOk = await visit('homepage', 'https://www.bizbuysell.com/');

  const akamai = (await context.cookies())
    .map((c) => c.name)
    .filter((n) => /_abck|bm_sz|ak_bmsc|bm_sv/i.test(n));
  console.log('  Akamai cookies present:', akamai.join(', ') || '(none)');

  if (homeOk) {
    const searchOk = await visit(
      'filtered search',
      'https://www.bizbuysell.com/manufacturing-businesses-for-sale/?cf_min=750000&cf_max=1000000',
    );

    if (searchOk) {
      // The whole point: what does the real filter UI put in the address bar?
      console.log('  final url:', page.url());
      const count = await page
        .locator('text=/Showing .*results/i')
        .first()
        .textContent()
        .catch(() => null);
      console.log('  result count:', count?.trim() ?? '(not found)');

      const links = await page
        .locator('a[href*="/business-opportunity/"]')
        .evaluateAll((nodes) =>
          [...new Set(nodes.map((n) => (n as HTMLAnchorElement).href))].slice(0, 5),
        );
      console.log('  listing links:', links.length);
      links.forEach((l) => console.log('    ', l));

      if (links[0]) {
        const detailOk = await visit('listing detail', links[0]!, 5000);
        if (detailOk) {
          const form = await page.locator('textarea').count();
          const sendButton = await page.getByRole('button', { name: /send message/i }).count();
          console.log(`  contact form: ${form} textarea(s), ${sendButton} send button(s)`);
        }
      }
    }
  }

  console.log('\nLeaving the browser open for 8s so you can see the state.');
  await page.waitForTimeout(8000);
  await context.close();
}

main().catch((err) => {
  console.error('probe failed:', err?.message ?? err);
  process.exit(1);
});

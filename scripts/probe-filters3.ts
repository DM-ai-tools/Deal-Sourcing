/**
 * Ask the site for its own filter encoding.
 *
 * Eight guessed cash-flow parameter names all returned exactly the baseline
 * result count, which means every one of them was ignored. Guessing further
 * would eventually produce a system that runs perfectly and silently profiles
 * businesses outside the buy-box — wrong in the way that does not announce
 * itself.
 *
 * So this drives the actual More Filters dialog, sets the cash-flow band
 * through the site's own controls, clicks Apply, and prints what the address
 * bar becomes. Whatever `q` decodes to afterwards IS the encoding, by
 * construction.
 *
 * Read-only.
 */
import { chromium, type Page } from 'patchright';
import path from 'node:path';
import os from 'node:os';

const PROFILE = process.env.PROFILE_DIR ?? path.join(os.tmpdir(), 'bbs-probe-profile');
const START = 'https://www.bizbuysell.com/manufacturing-businesses-for-sale/';

function decodeQ(url: string): string {
  const q = new URL(url).searchParams.get('q');
  if (!q) return '(no q parameter)';
  try {
    return Buffer.from(q, 'base64').toString('utf8');
  } catch {
    return `(not base64: ${q})`;
  }
}

async function resultCount(page: Page): Promise<string> {
  return (
    (await page
      .locator('text=/Showing .*result/i')
      .first()
      .textContent()
      .catch(() => null))
      ?.replace(/\s+/g, ' ')
      .trim() ?? '(none)'
  );
}

async function main() {
  const context = await chromium.launchPersistentContext(PROFILE, {
    channel: 'chrome',
    headless: false,
    viewport: null,
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });
  const page = context.pages()[0] ?? (await context.newPage());

  await page.goto('https://www.bizbuysell.com/', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(7000);
  await page.mouse.move(600, 400);

  console.log('\n→ opening a search page');
  await page.goto(START, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await page.waitForTimeout(10_000);
  console.log('  before :', page.url());
  console.log('  count  :', await resultCount(page));

  console.log('\n→ opening More Filters');
  const more = page.getByRole('button', { name: /more filters/i }).first();
  if (!(await more.isVisible().catch(() => false))) {
    console.log('  More Filters not visible — cannot continue');
    await context.close();
    return;
  }
  await more.click();
  await page.waitForTimeout(3000);

  // Find the cash-flow pair by their heading rather than by index: the dialog
  // holds several identical min/max select pairs and position is not a
  // contract. The site labels this block "Cash Flow (SDE) or EBITDA".
  const selects = page.locator('select');
  const total = await selects.count();
  console.log(`  ${total} selects in the dialog`);

  for (let i = 0; i < total; i++) {
    const info = await selects.nth(i).evaluate((node) => {
      const el = node as HTMLSelectElement;
      // Walk up for the nearest heading text, so each select can be identified.
      let context = '';
      let parent: HTMLElement | null = el.parentElement;
      for (let up = 0; up < 4 && parent; up++) {
        context = (parent.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 70);
        if (/cash flow|gross revenue|price/i.test(context)) break;
        parent = parent.parentElement;
      }
      return {
        name: el.name || el.id || '(unnamed)',
        first: Array.from(el.options).slice(0, 3).map((o) => o.value).join('|'),
        context,
      };
    });
    console.log(`   [${i}] ${info.name.padEnd(14)} ${info.first.padEnd(22)} ${info.context}`);
  }

  // Set the cash-flow pair directly.
  //
  // selectOption() times out here: these are hidden native selects behind a
  // custom dropdown, and Playwright refuses to interact with what it cannot
  // see. Setting .value and dispatching the events the site's own listener
  // expects works from an isolated context, because isolated contexts share
  // the DOM — only JS globals are separated.
  console.log('\n→ setting cash flow 750,000 to 1,000,000');
  const setCount: number = await page.$$eval('select', (nodes) => {
    let done = 0;
    for (const node of nodes) {
      const el = node as HTMLSelectElement;
      let context = '';
      let parent: HTMLElement | null = el.parentElement;
      for (let up = 0; up < 4 && parent; up++) {
        context += ' ' + (parent.textContent ?? '');
        parent = parent.parentElement;
      }
      if (!/cash flow/i.test(context)) continue;

      // AngularJS ngOptions renders values as "<index>: <value>" — the option
      // for $750,000 has value "7: 750000", not "750000". Match the numeric
      // tail, and fall back to the visible label.
      const wanted = done === 0 ? '750000' : '1000000';
      const label = done === 0 ? '$750,000' : '$1,000,000';
      const option = Array.from(el.options).find(
        (o) =>
          o.value === wanted ||
          o.value.replace(/^\s*\d+\s*:\s*/, '') === wanted ||
          o.text.trim() === label,
      );
      if (!option) continue;

      el.value = option.value;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      done++;
      if (done >= 2) break;
    }
    return done;
  });
  console.log(`   set ${setCount} cash-flow select(s)`);
  await page.waitForTimeout(1500);

  console.log('\n→ applying');
  const apply = page.getByRole('button', { name: /^apply$/i }).first();
  if (await apply.isVisible().catch(() => false)) {
    await apply.click();
    await page.waitForTimeout(11_000);
  } else {
    console.log('  Apply button not visible');
  }

  console.log('\n' + '─'.repeat(72));
  console.log('  URL AFTER APPLY:');
  console.log('   ', page.url());
  console.log('  q DECODES TO:');
  console.log('   ', decodeQ(page.url()));
  console.log('  count now:', await resultCount(page));
  console.log('─'.repeat(72) + '\n');

  await page.waitForTimeout(5000);
  await context.close();
}

main().catch((err) => {
  console.error('probe crashed:', err?.message ?? err);
  process.exit(1);
});

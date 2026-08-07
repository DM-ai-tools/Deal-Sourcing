/**
 * The remaining encoding questions.
 *
 * Cash flow is settled: q = base64("cffrom=750000&cfto=1000000"), which took
 * manufacturing from 1,500+ results to 92. This confirms the rest by the same
 * method rather than by pattern-matching on that one success — `grfrom`/`grto`
 * looks obvious, and obvious has already been wrong once here.
 *
 * Also reads the Listing Types control, because "exclude auctions" is a
 * requirement and `lt=30,40,80` is currently a magic number copied out of a
 * default search with no idea which code means what.
 *
 * Read-only.
 */
import { chromium } from 'patchright';
import path from 'node:path';
import os from 'node:os';

const PROFILE = process.env.PROFILE_DIR ?? path.join(os.tmpdir(), 'bbs-probe-profile');
const START = 'https://www.bizbuysell.com/manufacturing-businesses-for-sale/';

const decode = (url: string) => {
  const q = new URL(url).searchParams.get('q');
  if (!q) return '(none)';
  try {
    return Buffer.from(q, 'base64').toString('utf8');
  } catch {
    return `(not base64: ${q})`;
  }
};

async function main() {
  const context = await chromium.launchPersistentContext(PROFILE, {
    channel: 'chrome',
    headless: false,
    viewport: null,
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });
  const page = context.pages()[0] ?? (await context.newPage());

  await page.goto('https://www.bizbuysell.com/', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(6000);
  await page.goto(START, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await page.waitForTimeout(9000);

  // ---- 1. Listing Types: what are the codes? -----------------------------
  console.log('\n→ Listing Types control');
  const listingTypes = page.getByRole('button', { name: /listing types/i }).first();
  if (await listingTypes.isVisible().catch(() => false)) {
    await listingTypes.click();
    await page.waitForTimeout(2500);

    const boxes = await page.$$eval('input[type="checkbox"]', (nodes) =>
      nodes
        .map((n) => {
          const el = n as HTMLInputElement;
          const label =
            el.closest('label')?.textContent ??
            (el.parentElement?.textContent ?? '') ??
            '';
          return {
            value: el.value,
            checked: el.checked,
            label: label.replace(/\s+/g, ' ').trim().slice(0, 60),
          };
        })
        .filter((b) => b.label),
    );
    for (const b of boxes) {
      console.log(`   ${b.checked ? '[x]' : '[ ]'} value="${String(b.value).padEnd(6)}" ${b.label}`);
    }
    await page.keyboard.press('Escape').catch(() => {});
    await page.waitForTimeout(1200);
  } else {
    console.log('   control not visible');
  }

  // ---- 2. Gross revenue, by the same DOM-set method ----------------------
  console.log('\n→ setting Gross Revenue 1,000,000 to 5,000,000');
  const more = page.getByRole('button', { name: /more filters/i }).first();
  if (await more.isVisible().catch(() => false)) {
    await more.click();
    await page.waitForTimeout(2500);

    const set: number = await page.$$eval('select', (nodes) => {
      let done = 0;
      for (const node of nodes) {
        const el = node as HTMLSelectElement;
        let context = '';
        let parent: HTMLElement | null = el.parentElement;
        for (let up = 0; up < 4 && parent; up++) {
          context += ' ' + (parent.textContent ?? '');
          parent = parent.parentElement;
        }
        // Gross Revenue only — the cash-flow block must stay untouched so the
        // parameter that appears can be attributed to this control alone.
        if (!/gross revenue/i.test(context) || /cash flow/i.test(context)) continue;

        const wanted = done === 0 ? '1000000' : '5000000';
        const option = Array.from(el.options).find(
          (o) => o.value.replace(/^\s*\d+\s*:\s*/, '') === wanted,
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
    console.log(`   set ${set} gross-revenue select(s)`);

    const apply = page.getByRole('button', { name: /^apply$/i }).first();
    if (await apply.isVisible().catch(() => false)) {
      await apply.click();
      await page.waitForTimeout(10_000);
    }
  }

  console.log('\n' + '─'.repeat(70));
  console.log('  url :', page.url());
  console.log('  q   :', decode(page.url()));
  console.log(
    '  hits:',
    (await page.locator('text=/Showing .*result/i').first().textContent().catch(() => '(none)'))
      ?.replace(/\s+/g, ' ')
      .trim(),
  );
  console.log('─'.repeat(70) + '\n');

  await context.close();
}

main().catch((err) => {
  console.error('probe crashed:', err?.message ?? err);
  process.exit(1);
});

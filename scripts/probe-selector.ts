/**
 * Which locator strategy actually fills this form?
 *
 * The DOM dump reports id="txtName" and placeholder="Full Name", and a locator
 * built from either times out waiting for the element. Something about how the
 * rail renders means the field the DOM reports and the field Playwright can act
 * on are not the same thing.
 *
 * Rather than guess a fourth time, try every strategy against the live page and
 * report which ones resolve, which are actionable, and which actually accept a
 * value. Read-only: it types into fields and never submits.
 */
import { makeBrowserTransport } from '../src/lib/transport.js';
import type { Page } from 'patchright';

const URL_ARG =
  process.argv[2] ??
  'https://www.bizbuysell.com/business-opportunity/military-and-commercial-aircraft-component-part-manufacturing/2485742/';

async function try_(page: Page, label: string, build: () => ReturnType<Page['locator']>) {
  const locator = build();
  const count = await locator.count().catch(() => -1);
  const visible = count > 0 ? await locator.first().isVisible().catch(() => false) : false;

  let filled = false;
  let error = '';
  if (visible) {
    try {
      await locator.first().fill('PROBE', { timeout: 6000 });
      filled = (await locator.first().inputValue().catch(() => '')) === 'PROBE';
    } catch (err) {
      error = (err as Error).message.split('\n')[0]!.slice(0, 50);
    }
  }

  console.log(
    `  ${label.padEnd(40)} count=${String(count).padStart(3)} visible=${String(visible).padEnd(5)} ` +
      `filled=${String(filled).padEnd(5)} ${error}`,
  );
  return filled;
}

async function main() {
  const transport = makeBrowserTransport({ transport: (process.env.MODE ?? 'local') as 'local' });
  const page = await transport.page();

  try {
    await page.goto(URL_ARG, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    await page.waitForTimeout(8000);
    console.log('\ntitle:', (await page.title()).slice(0, 60), '\n');

    // Does the id exist in the DOM at all, right now?
    const inDom = await page.evaluate(() => ({
      txtName: Boolean(document.querySelector('#txtName')),
      byPlaceholder: Boolean(document.querySelector('input[placeholder="Full Name"]')),
      totalInputs: document.querySelectorAll('input').length,
      iframes: document.querySelectorAll('iframe').length,
    }));
    console.log('  DOM check:', JSON.stringify(inDom), '\n');

    await try_(page, 'getByPlaceholder("Full Name")', () => page.getByPlaceholder('Full Name'));
    await try_(page, 'getByPlaceholder(/full name/i)', () => page.getByPlaceholder(/full name/i));
    await try_(page, '#txtName', () => page.locator('#txtName'));
    await try_(page, 'input[placeholder="Full Name"]', () => page.locator('input[placeholder="Full Name"]'));
    await try_(page, 'getByLabel(/full name/i)', () => page.getByLabel(/full name/i));
    await try_(page, 'input[type=text] near form', () => page.locator('form input[type="text"]'));

    // Frames — if the form lives in one, everything above legitimately fails.
    console.log(`\n  frames on page: ${page.frames().length}`);
    for (const frame of page.frames()) {
      const has = await frame.locator('#txtName').count().catch(() => 0);
      if (has) console.log(`   FOUND #txtName in frame: ${frame.url().slice(0, 70)}`);
    }
  } finally {
    await transport.close().catch(() => {});
  }
}

main().catch((err) => {
  console.error('probe crashed:', err?.message ?? err);
  process.exit(1);
});

/**
 * What is the contact form actually made of?
 *
 * A dry run reported success and the screenshot showed Full Name, Phone and
 * Email empty — only the message had been filled. The selectors matched on the
 * `placeholder` attribute, but the visible text is a floating label, so three
 * locators resolved to nothing. `isVisible()` returned false, the code skipped
 * them, and the outcome still said ok.
 *
 * That is the worst failure this form can have: an enquiry with no name and no
 * reply address, sent to a real broker, reported as delivered.
 *
 * So: dump every field, with every attribute that could identify it.
 */
import { makeBrowserTransport } from '../src/lib/transport.js';

const URL_ARG =
  process.argv[2] ??
  'https://www.bizbuysell.com/business-opportunity/military-and-commercial-aircraft-component-part-manufacturing/2485742/';

async function main() {
  const transport = makeBrowserTransport({ transport: (process.env.MODE ?? 'local') as 'local' });
  const page = await transport.page();

  try {
    await page.goto(URL_ARG, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    await page.waitForTimeout(6000);
    console.log('title:', await page.title(), '\n');

    const fields = await page.$$eval('input, textarea, select, button', (nodes) =>
      nodes
        .map((n) => {
          const el = n as HTMLInputElement;
          const rect = el.getBoundingClientRect();
          // The visible label may be a wrapping <label>, an aria-label, or a
          // sibling — collect all of them rather than betting on one.
          const label =
            el.closest('label')?.textContent ??
            (el.id ? document.querySelector(`label[for="${el.id}"]`)?.textContent : '') ??
            el.parentElement?.querySelector('label')?.textContent ??
            '';
          return {
            tag: el.tagName.toLowerCase(),
            type: el.type ?? '',
            id: el.id ?? '',
            name: el.name ?? '',
            placeholder: el.placeholder ?? '',
            aria: el.getAttribute('aria-label') ?? '',
            label: (label ?? '').replace(/\s+/g, ' ').trim().slice(0, 40),
            text: (el.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 30),
            visible: rect.width > 0 && rect.height > 0,
            required: el.required ?? false,
            checked: el.type === 'checkbox' ? el.checked : undefined,
          };
        })
        .filter((f) => f.visible),
    );

    console.log('VISIBLE FORM CONTROLS');
    console.log('-'.repeat(100));
    for (const f of fields) {
      console.log(
        `${f.tag.padEnd(9)} ${String(f.type).padEnd(9)} id=${f.id.slice(0, 22).padEnd(23)} ` +
          `name=${f.name.slice(0, 16).padEnd(17)} ph="${f.placeholder.slice(0, 18)}" ` +
          `aria="${f.aria.slice(0, 18)}" label="${f.label.slice(0, 22)}" ` +
          `${f.required ? 'REQUIRED ' : ''}${f.checked === true ? 'CHECKED' : ''}${f.text ? ' text=' + f.text : ''}`,
      );
    }
    console.log('-'.repeat(100));
  } finally {
    await transport.close().catch(() => {});
  }
}

main().catch((err) => {
  console.error('probe crashed:', err?.message ?? err);
  process.exit(1);
});

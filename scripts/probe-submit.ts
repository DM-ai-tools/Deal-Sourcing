/**
 * What actually submits the contact form?
 *
 * `getByRole('button', { name: /send message/i })` times out, and a dump of
 * every visible input/textarea/select/button on the page does not contain it —
 * so the control is not a `<button>` and not an `<input type="submit">`. It is
 * something else wearing a button's clothes, which is common enough on sites
 * that style their own controls.
 *
 * Rather than guess a second time, list every element on the page whose own
 * text looks like a submit action, with enough identity to write a locator.
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

    // Wait for the form, don't assume it. The rail is inconsistent — one load
    // in several renders the page without it, and a fixed timeout turns that
    // into "the button doesn't exist" when the truth is "nothing rendered yet".
    const ready = await page
      .waitForSelector('#txtMessage', { state: 'attached', timeout: 45_000 })
      .then(() => true)
      .catch(() => false);
    console.log(ready ? '\nform rendered.' : '\nform never rendered on this load.');
    if (!ready) return;
    await page.waitForTimeout(1500);

    // The direct route: whatever submits this form is a sibling of the message
    // box. Print the container's own markup rather than guessing at its label.
    const container = await page.evaluate(() => {
      const message = document.querySelector('#txtMessage') as any;
      if (!message) return 'no #txtMessage on the page';
      const form = message.closest('form') ?? message.parentElement?.parentElement;
      const html = (form?.outerHTML ?? '').replace(/\s+/g, ' ');
      // The tail is where the actions live; the head is fields already known.
      return html.length > 3000 ? '…' + html.slice(-3000) : html;
    });
    console.log('\nFORM CONTAINER (tail)\n' + '-'.repeat(105));
    console.log(container);
    console.log('-'.repeat(105));

    const found = await page.evaluate(() => {
      const out: any[] = [];
      for (const el of Array.from(document.querySelectorAll('*')) as any[]) {
        // Own text only — otherwise every ancestor up to <body> matches.
        const own = Array.from(el.childNodes)
          .filter((n: any) => n.nodeType === 3)
          .map((n: any) => n.textContent)
          .join(' ')
          .replace(/\s+/g, ' ')
          .trim();
        if (!/^(send|submit|contact|request)/i.test(own)) continue;
        const rect = el.getBoundingClientRect();
        out.push({
          tag: el.tagName.toLowerCase(),
          type: el.getAttribute('type') ?? '',
          id: el.id ?? '',
          cls: (el.className?.baseVal ?? el.className ?? '').toString().slice(0, 45),
          text: own.slice(0, 35),
          visible: rect.width > 0 && rect.height > 0,
          disabled: Boolean(el.disabled),
        });
      }
      return out;
    });

    console.log('\nSUBMIT-LIKE ELEMENTS');
    console.log('-'.repeat(105));
    for (const f of found) {
      console.log(
        `${f.tag.padEnd(8)} type=${f.type.padEnd(8)} id=${f.id.slice(0, 20).padEnd(21)} ` +
          `class="${f.cls.padEnd(45)}" vis=${String(f.visible).padEnd(5)} ` +
          `${f.disabled ? 'DISABLED ' : ''}text="${f.text}"`,
      );
    }
    console.log('-'.repeat(105));
    console.log(`${found.length} candidates\n`);
  } finally {
    await transport.close().catch(() => {});
  }
}

main().catch((err) => {
  console.error('probe crashed:', err?.message ?? err);
  process.exit(1);
});

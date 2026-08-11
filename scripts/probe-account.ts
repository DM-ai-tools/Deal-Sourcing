/**
 * Does BizBuySell itself tell us when a broker replies?
 *
 * Worth settling before committing to a mailbox integration. If the buyer
 * account has an inbox or an enquiry history, that is a far better source than
 * email: it is already tied to the listing, so no matching heuristics, no
 * ambiguity when one broker handles several businesses, and no Entra app
 * registration to wait on.
 *
 * Login was previously reported as "page did not render its form". That was the
 * hidden-duplicate-field bug, not a block — same fault as the contact form. So
 * this signs in properly and then reports what the account actually offers,
 * rather than guessing at URLs.
 *
 * Read-only: it navigates and reads. It sends nothing and changes nothing.
 */
import { makeBrowserTransport } from '../src/lib/transport.js';
import { login } from '../src/lib/outreach.js';
import type { Page } from 'patchright';

const CANDIDATE_PATHS = [
  '/my-bizbuysell/',
  '/users/dashboard.aspx',
  '/my-bizbuysell/inquiries/',
  '/my-bizbuysell/messages/',
  '/my-bizbuysell/saved-listings/',
];

async function report(page: Page, url: string) {
  try {
    await page.goto(`https://www.bizbuysell.com${url}`, {
      waitUntil: 'domcontentloaded',
      timeout: 45_000,
    });
    await page.waitForTimeout(2500);

    const title = await page.title();
    const finalUrl = page.url();
    const redirected = !finalUrl.includes(url);
    const text = await page.locator('body').innerText().catch(() => '');

    // The words that would indicate a conversation record rather than a
    // marketing page.
    const signals = ['inquir', 'message', 'conversation', 'reply', 'contacted', 'saved']
      .filter((word) => new RegExp(word, 'i').test(text));

    console.log(`\n  ${url}`);
    console.log(`    title     : ${title.slice(0, 70)}`);
    console.log(`    ended at  : ${finalUrl.slice(0, 88)}${redirected ? '  <-- REDIRECTED' : ''}`);
    console.log(`    signals   : ${signals.join(', ') || 'none'}`);
  } catch (err) {
    console.log(`\n  ${url}\n    failed: ${(err as Error).message.split('\n')[0]?.slice(0, 80)}`);
  }
}

async function main() {
  const transport = makeBrowserTransport({ transport: (process.env.MODE ?? 'local') as 'local' });

  try {
    console.log('\nsigning in…');
    const auth = await login(transport, {
      email: process.env.BBS_EMAIL ?? '',
      password: process.env.BBS_PASSWORD ?? '',
    });
    console.log(auth.ok ? '  signed in.' : `  FAILED: ${auth.error}`);
    if (!auth.ok) return;

    const page = await transport.page();

    // What does the account menu actually contain? Better than guessing paths.
    await page.goto('https://www.bizbuysell.com/', { waitUntil: 'domcontentloaded', timeout: 45_000 });
    await page.waitForTimeout(3000);

    const links = await page.$$eval('a[href]', (anchors) =>
      (anchors as any[])
        .map((a) => ({ href: a.getAttribute('href') ?? '', text: (a.textContent ?? '').trim() }))
        .filter(
          (l) =>
            /my-bizbuysell|account|dashboard|inquir|message|saved|profile/i.test(l.href) &&
            l.text.length > 0 && l.text.length < 40,
        )
        .slice(0, 30),
    );

    console.log('\nACCOUNT LINKS ON THE SIGNED-IN HOMEPAGE');
    console.log('-'.repeat(88));
    const seen = new Set<string>();
    for (const link of links) {
      if (seen.has(link.href)) continue;
      seen.add(link.href);
      console.log(`  ${link.text.padEnd(30)} ${link.href.slice(0, 54)}`);
    }
    if (!links.length) console.log('  (none found — the header may not have rendered)');
    console.log('-'.repeat(88));

    console.log('\nPROBING LIKELY PAGES');
    for (const path of CANDIDATE_PATHS) await report(page, path);
    console.log();
  } finally {
    await transport.close().catch(() => {});
  }
}

main().catch((err) => {
  console.error('probe crashed:', err?.message ?? err);
  process.exit(1);
});

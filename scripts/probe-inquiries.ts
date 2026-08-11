/**
 * What is on BizBuySell's own "My Inquiries" page?
 *
 * The account menu has /mybbs/MyInquiries. If that page records each enquiry
 * AND whether the broker answered, it beats the mailbox route outright: the
 * record is already tied to a listing, so there is no matching to get wrong, no
 * ambiguity when one broker handles several businesses, and no Entra app
 * registration to wait on.
 *
 * So: sign in, open it, and print what is genuinely there — headings, table
 * structure, row text, and any wording that would indicate a reply.
 *
 * Read-only.
 */
import { makeBrowserTransport } from '../src/lib/transport.js';
import { login } from '../src/lib/outreach.js';

async function main() {
  const transport = makeBrowserTransport({ transport: (process.env.MODE ?? 'local') as 'local' });

  try {
    const auth = await login(transport, {
      email: process.env.BBS_EMAIL ?? '',
      password: process.env.BBS_PASSWORD ?? '',
    });
    if (!auth.ok) throw new Error(`login failed: ${auth.error}`);
    console.log('signed in.\n');

    const page = await transport.page();
    await page.goto('https://www.bizbuysell.com/mybbs/MyInquiries', {
      waitUntil: 'domcontentloaded',
      timeout: 60_000,
    });
    await page.waitForTimeout(6000);

    console.log('title    :', await page.title());
    console.log('ended at :', page.url(), '\n');

    const text = (await page.locator('body').innerText().catch(() => '')) ?? '';
    console.log('PAGE TEXT (first 2500 chars)');
    console.log('-'.repeat(90));
    console.log(text.replace(/\n{3,}/g, '\n\n').slice(0, 2500));
    console.log('-'.repeat(90));

    // Structure: tables and repeated rows are what a machine would read.
    const structure = await page.evaluate(() => {
      const tables = Array.from(document.querySelectorAll('table')).map((t) => ({
        headers: Array.from(t.querySelectorAll('th')).map((h) => (h.textContent ?? '').trim()),
        rows: t.querySelectorAll('tbody tr').length,
      }));
      const listingLinks = Array.from(document.querySelectorAll('a[href*="business-opportunity"]')).length;
      return { tables, listingLinks };
    });

    console.log('\nSTRUCTURE');
    console.log('  tables            :', JSON.stringify(structure.tables));
    console.log('  listing links     :', structure.listingLinks);

    // Words that would mean the page tracks a response, not just a send.
    const replyWords = ['replied', 'response', 'responded', 'unread', 'new message', 'answered']
      .filter((w) => new RegExp(w, 'i').test(text));
    console.log('  reply indicators  :', replyWords.join(', ') || 'NONE FOUND');

    await page.screenshot({ path: 'my-inquiries.png', fullPage: true }).catch(() => {});
    console.log('\n  screenshot: my-inquiries.png\n');
  } finally {
    await transport.close().catch(() => {});
  }
}

main().catch((err) => {
  console.error('probe crashed:', err?.message ?? err);
  process.exit(1);
});

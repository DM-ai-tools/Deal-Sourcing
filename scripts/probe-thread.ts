/**
 * Does an inquiry open into a conversation?
 *
 * "My Inquiries" is laid out as a sent log — To / Business For Sale / Date, no
 * reply column. But the Message Center carries a red 16 badge, and a badge on a
 * list of things you sent makes no sense unless something has come back. If
 * broker replies thread in here, this beats the mailbox route outright: the
 * record is already tied to a listing, so no matching, no ambiguity, and no
 * Entra registration to wait for.
 *
 * So: find what a row actually links to, follow it, and report whether the
 * destination contains a reply or just the message we sent.
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

    const page = await transport.page();
    await page.goto('https://www.bizbuysell.com/mybbs/MyInquiries', {
      waitUntil: 'domcontentloaded',
      timeout: 60_000,
    });
    await page.waitForTimeout(6000);

    // Every link inside the table, and what the badge is attached to.
    const detail = await page.evaluate(() => {
      const table = document.querySelector('table');
      const links = Array.from(table?.querySelectorAll('a[href]') ?? [])
        .map((a) => ({ text: (a.textContent ?? '').trim().slice(0, 46), href: a.getAttribute('href') ?? '' }))
        .slice(0, 8);

      // Anything that looks like an unread counter, with its surrounding text.
      const badges = Array.from(document.querySelectorAll('*'))
        .filter((el) => /^\s*\d{1,3}\s*$/.test(el.textContent ?? '') && el.children.length === 0)
        .map((el) => ({
          count: (el.textContent ?? '').trim(),
          near: (el.parentElement?.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 60),
          cls: String((el as HTMLElement).className ?? '').slice(0, 40),
        }))
        .slice(0, 10);

      return { links, badges };
    });

    console.log('\nROW LINKS');
    console.log('-'.repeat(92));
    for (const link of detail.links) console.log(`  ${link.text.padEnd(46)} -> ${link.href.slice(0, 40)}`);

    console.log('\nNUMERIC BADGES ON THE PAGE');
    console.log('-'.repeat(92));
    for (const badge of detail.badges) {
      console.log(`  "${badge.count}"  near: ${badge.near}  class: ${badge.cls}`);
    }

    // Follow the first row's link and see what is on the other side.
    const first = detail.links[0]?.href;
    if (first) {
      const url = first.startsWith('http') ? first : `https://www.bizbuysell.com${first}`;
      console.log(`\nFOLLOWING: ${url.slice(0, 90)}`);
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
      await page.waitForTimeout(5000);

      const text = (await page.locator('body').innerText().catch(() => '')) ?? '';
      console.log(`  title  : ${(await page.title()).slice(0, 70)}`);
      console.log(`  at     : ${page.url().slice(0, 90)}`);

      const replyWords = ['replied', 'response', 'responded', 'wrote', 'sent you', 'conversation', 'reply']
        .filter((w) => new RegExp(`\\b${w}\\b`, 'i').test(text));
      console.log(`  reply words: ${replyWords.join(', ') || 'NONE'}`);
      console.log(`  our own message present: ${/family office/i.test(text)}`);
      await page.screenshot({ path: 'inquiry-detail.png', fullPage: true }).catch(() => {});
      console.log('  screenshot: inquiry-detail.png');
    }
    console.log();
  } finally {
    await transport.close().catch(() => {});
  }
}

main().catch((err) => {
  console.error('probe crashed:', err?.message ?? err);
  process.exit(1);
});

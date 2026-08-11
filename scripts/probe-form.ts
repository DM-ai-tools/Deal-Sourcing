/**
 * Can we actually reach and fill the contact form?
 *
 * Search pages work; sending failed forty-four times. The cause was the wrong
 * browser being used for the write path, now fixed — but "fixed" is a claim
 * until the form is reached, so this reaches it.
 *
 * It fills every field exactly as a real send would and STOPS BEFORE THE BUTTON.
 * Nothing is submitted. That is the whole point: prove the mechanism without
 * putting a message in front of a broker.
 */
import { makeBrowserTransport } from '../src/lib/transport.js';
import { buildSearchUrls } from '../src/lib/search-url.js';
import { extractSearchResults } from '../src/lib/extract.js';
import { makeTransport } from '../src/lib/transport.js';
import { sendEnquiry } from '../src/lib/outreach.js';

const mode = (process.env.MODE ?? 'camoufox') as 'camoufox' | 'local';

async function main() {
  console.log(`\n  mode: ${mode}\n`);

  // Get a real listing URL from a real search.
  const searchUrl = buildSearchUrls({
    states: [],
    industries: ['manufacturing'],
    cashFlowMin: 750_000,
    cashFlowMax: 1_000_000,
  })[0]!;

  const reader = makeTransport({ transport: mode });
  const page = await reader.fetch(searchUrl);
  await reader.close();

  if (!page.ok || !page.html) {
    console.log('  search failed:', page.reason);
    process.exit(1);
  }
  const listings = extractSearchResults(page.html);
  console.log(`  search returned ${listings.length} listings`);
  const target = listings[0];
  if (!target) process.exit(1);
  console.log(`  target: ${target.title.slice(0, 60)}`);
  console.log(`          ${target.url}\n`);

  // Now the write path, unarmed.
  const writer = makeBrowserTransport({ transport: mode });
  try {
    const outcome = await sendEnquiry(
      writer,
      target.url,
      {
        fullName: 'Sai Sushant Reddy Allu',
        // Overridable, because the reply address is a live question: Microsoft
        // 365 blocks forwarding out of deals@hyperboards.com, so replies have
        // to be steered somewhere readable instead — and whether this form
        // accepts a plus-address decides how.
        email: process.env.BUYER_EMAIL ?? 'deals@hyperboards.com',
        phone: '(857) 366-7779',
        message: 'PROBE ONLY — this form was filled and deliberately not submitted.',
      },
      false, // NOT armed. Fills the form and stops.
    );

    console.log('  form reached :', outcome.ok);
    console.log('  detail       :', (outcome.confirmation ?? outcome.error ?? '').slice(0, 140));
    if (outcome.screenshot) {
      const { writeFileSync } = await import('node:fs');
      writeFileSync('form-filled.png', Buffer.from(outcome.screenshot.split(',')[1]!, 'base64'));
      console.log('  screenshot   : saved form-filled.png');
    }
    console.log(outcome.ok ? '\n  VERDICT: the send path works. Arming would send.\n'
                           : '\n  VERDICT: still cannot reach the form.\n');
    process.exit(outcome.ok ? 0 : 1);
  } finally {
    await writer.close().catch(() => {});
  }
}

main().catch((err) => {
  console.error('probe crashed:', err?.message ?? err);
  process.exit(1);
});

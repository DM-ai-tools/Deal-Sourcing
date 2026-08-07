/**
 * Phase 0 — does patchright change Akamai's verdict?
 *
 * Everything downstream rests on this. Stock Playwright was refused in every
 * configuration tried (see the header of src/lib/transport.ts). patchright
 * removes a different class of signal: the `Runtime.enable` CDP leak that
 * fires on essentially every page.evaluate and that Akamai's sensor script is
 * known to probe for. That is a real, untested hypothesis — not a fix.
 *
 * This runs patchright's documented optimal configuration, unmodified:
 * persistent context, real Chrome, headed, no custom user-agent, no injected
 * stealth script. Deviating from that is documented to REDUCE undetectability,
 * because a spoofed UA desyncs from the binary actually making the request.
 *
 * It answers two questions and prints both plainly:
 *
 *   1. Do we get a valid `_abck` and an actual rendered listing set?
 *      `ak_bmsc` and `bm_sv` do not count — the edge sets those for everyone.
 *      `_abck` is the only cookie that reflects sensor validation.
 *
 *   2. Is the "Business Listed By:" name wrapped in an anchor to
 *      /business-broker/<broker>/<firm>/<id>/ ?
 *      If yes, one listing fetch yields the broker, the FIRM NAME and a stable
 *      id for free, and every step of email discovery gets cheaper.
 *
 * Read-only. It never opens a contact form and never sends anything.
 *
 *   npx tsx scripts/probe-patchright.ts
 *   railway run npx tsx scripts/probe-patchright.ts   # the one that counts
 */
import { chromium } from 'patchright';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const PROFILE = process.env.PROFILE_DIR ?? path.join(os.tmpdir(), 'bbs-probe-profile');

const SEARCH =
  'https://www.bizbuysell.com/manufacturing-businesses-for-sale/?cf_min=750000&cf_max=1000000';

interface Verdict {
  label: string;
  ok: boolean;
  detail: string;
}

const verdicts: Verdict[] = [];

function record(label: string, ok: boolean, detail = '') {
  verdicts.push({ label, ok, detail });
  console.log(`${ok ? '  PASS ' : '  FAIL '} ${label.padEnd(34)} ${detail}`);
}

async function main() {
  console.log('─'.repeat(74));
  console.log('  Phase 0 — patchright against Akamai');
  console.log('─'.repeat(74));
  console.log(`  profile   ${PROFILE}`);
  console.log(`  headless  false (patchright's documented optimum)`);
  console.log('─'.repeat(74));

  // patchright's documented optimal config. No userAgent, no viewport override,
  // no locale/timezone, no init script — each of those desyncs from the real
  // binary and is itself a signal.
  const context = await chromium.launchPersistentContext(PROFILE, {
    channel: 'chrome',
    headless: false,
    viewport: null,
    args: [
      // Required running as root in a container; harmless locally.
      '--no-sandbox',
      // Railway gives no --shm-size control, so this stays even though
      // patchright would rather the flag set were untouched. Knowing trade-off.
      '--disable-dev-shm-usage',
    ],
  });

  const page = context.pages()[0] ?? (await context.newPage());

  const visit = async (label: string, url: string, settle = 8000) => {
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
      await page.waitForTimeout(settle);
      const title = await page.title();
      const blocked = /access denied|pardon our interruption|forbidden/i.test(title);
      record(label, !blocked, `"${title.slice(0, 44)}"`);
      return !blocked;
    } catch (err) {
      record(label, false, (err as Error).message.slice(0, 50));
      return false;
    }
  };

  // ---- 1. Homepage, then the cookies that actually mean something ---------
  console.log('\nReachability');
  await visit('homepage', 'https://www.bizbuysell.com/', 9000);

  // A person moves. An entirely still pointer for nine seconds is its own tell.
  await page.mouse.move(620, 380);
  await page.waitForTimeout(400);
  await page.mouse.move(780, 520);
  await page.mouse.wheel(0, 600);
  await page.waitForTimeout(1200);

  const cookieNames = (await context.cookies()).map((c) => c.name);
  const abck = (await context.cookies()).find((c) => c.name === '_abck');
  record(
    'edge cookies present',
    cookieNames.some((n) => /ak_bmsc|bm_sv|bm_sz/.test(n)),
    cookieNames.filter((n) => /^(_abck|ak_bmsc|bm_)/.test(n)).join(', ') || '(none)',
  );
  // The whole question. `~0~` means the sensor payload validated.
  record(
    '_abck issued',
    Boolean(abck),
    abck ? `${abck.value.slice(0, 28)}…` : 'NOT SET — sensor never validated',
  );
  if (abck) {
    record(
      '_abck looks validated (~0~)',
      abck.value.includes('~0~') && !abck.value.endsWith('~0~-1~-1'),
      abck.value.includes('~0~') ? 'contains ~0~' : 'no ~0~ — payload likely rejected',
    );
  }

  // ---- 2. The search page, reached by URL ---------------------------------
  console.log('\nSearch');
  const searchOk = await visit('filtered search', SEARCH, 12_000);

  let listingUrl: string | null = null;

  if (searchOk) {
    // The real test: does the listings XHR return, or does it tarpit?
    const hrefs: string[] = await page.$$eval('a', (nodes) =>
      nodes.map((n) => (n as HTMLAnchorElement).href),
    );
    const listings = [...new Set(hrefs.filter((h) => /business-opportunity\/[^/]+\/\d+/.test(h)))];
    record(
      'listings rendered',
      listings.length > 0,
      `${listings.length} listing links (0 = XHR tarpitted)`,
    );
    listingUrl = listings[0] ?? null;

    const count = await page
      .locator('text=/Showing .*result/i')
      .first()
      .textContent()
      .catch(() => null);
    if (count) console.log(`         result count: ${count.trim()}`);
  }

  // ---- 3. A listing page, and the broker anchor ---------------------------
  console.log('\nListing detail and broker anchor');
  if (listingUrl) {
    if (await visit('listing detail', listingUrl, 8000)) {
      const html = await page.content();

      // Question 2. Everything in email discovery is cheaper if this holds.
      const anchor = html.match(
        /Business\s+Listed\s+By[\s\S]{0,400}?href=["']([^"']*\/business-broker\/[^"']+)["']/i,
      );
      record(
        'broker profile anchor present',
        Boolean(anchor),
        anchor?.[1] ?? 'no /business-broker/ href near "Business Listed By"',
      );

      if (anchor?.[1]) {
        const parts = anchor[1].match(/\/business-broker\/([^/]+)\/([^/]+)\/(\d+)/);
        if (parts) {
          console.log(`         broker slug : ${parts[1]}`);
          console.log(`         FIRM slug   : ${parts[2]}  <- the input to email discovery`);
          console.log(`         profile id  : ${parts[3]}`);
        }
      }

      // Keep the raw region so question 2 can be settled by eye if the regex
      // misses — the markup is the site's to change, not ours to assume.
      const index = html.search(/Business\s+Listed\s+By/i);
      if (index >= 0) {
        writeFileSync(
          'probe-broker-block.html',
          html.slice(Math.max(0, index - 1500), index + 3000),
        );
        console.log('         saved probe-broker-block.html for inspection');
      }

      record('contact form present', (await page.locator('textarea').count()) > 0);
    }
  } else {
    record('listing detail', false, 'skipped — no listing URL to open');
  }

  // ---- verdict ------------------------------------------------------------
  console.log('\n' + '─'.repeat(74));
  const passed = verdicts.filter((v) => v.ok).length;
  const gate = verdicts.find((v) => v.label === 'listings rendered')?.ok ?? false;
  console.log(`  ${passed}/${verdicts.length} checks passed`);
  console.log(
    gate
      ? '  VERDICT: patchright gets through. Proceed to Phase 1.'
      : '  VERDICT: still blocked at the data layer. Do not refactor —\n' +
        '           reconsider a commercial unblocker, or drop automated reading.',
  );
  console.log('─'.repeat(74));

  await page.waitForTimeout(4000);
  await context.close();
  process.exit(gate ? 0 : 1);
}

main().catch((err) => {
  console.error('probe crashed:', err?.message ?? err);
  process.exit(1);
});

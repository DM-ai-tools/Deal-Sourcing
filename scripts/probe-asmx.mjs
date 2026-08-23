/**
 * Does the contact form's real endpoint answer an XHR?
 *
 * The listing page's Send Message button does not post a form. It calls
 *   POST /listings/Services/ListingUtilities.asmx/ContactSeller
 * with a JSON body. If Akamai lets that XHR through from a page we are already
 * allowed to hold, sending never needs a listing-detail page load at all.
 *
 * This probe is deliberately side-effect free: it posts an EMPTY body, which an
 * ASMX endpoint answers with a 500 "missing value for parameter" — proof the
 * request reached the origin, and a free readout of the parameter names. No
 * lead is created and no broker is contacted.
 */
import { chromium } from 'patchright';
import os from 'node:os';
import path from 'node:path';

const ENDPOINT = 'https://www.bizbuysell.com/listings/Services/ListingUtilities.asmx/ContactSeller';
const LANDING = process.env.LANDING ?? 'https://www.bizbuysell.com/manufacturing-businesses-for-sale/';

const ctx = await chromium.launchPersistentContext(
  path.join(os.tmpdir(), 'bbs-asmx-probe'),
  { channel: 'chrome', headless: false, viewport: null, args: ['--no-sandbox'] },
);

try {
  const page = await ctx.newPage();
  console.log('\n[1] homepage warm-up');
  const home = await page.goto('https://www.bizbuysell.com/', { waitUntil: 'domcontentloaded', timeout: 60_000 });
  console.log('    status', home?.status(), '| title', (await page.title()).slice(0, 60));
  await page.waitForTimeout(7000);
  await page.mouse.move(620, 380);
  await page.mouse.wheel(0, 500);
  await page.waitForTimeout(1500);

  console.log('\n[2] landing page (search/category, the least-refused surface)');
  const landing = await page.goto(LANDING, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  console.log('    status', landing?.status(), '| title', (await page.title()).slice(0, 60));
  await page.waitForTimeout(4000);

  const token = await page.evaluate(() => document.querySelector('#__AntiXsrfToken')?.value ?? null);
  console.log('    __AntiXsrfToken on this page:', token ?? '(absent)');

  const cookies = await ctx.cookies('https://www.bizbuysell.com');
  // The hidden field is only a mirror of this cookie — measured identical on
  // archived responses — and Playwright can read HttpOnly cookies, so the token
  // never requires parsing a listing page.
  const tokenFromJar = cookies.find((c) => c.name === '__AntiXsrfToken')?.value ?? '';
  console.log('    __AntiXsrfToken from cookie jar:', tokenFromJar || '(absent)');
  console.log('    cookies:', cookies.map((c) => c.name).join(', '));

  console.log('\n[3] in-page XHR to the ASMX endpoint (empty body — no lead created)');
  const inPage = await page.evaluate(async (url) => {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8', 'X-Requested-With': 'XMLHttpRequest' },
      body: '{}',
      credentials: 'include',
    });
    return { status: res.status, server: res.headers.get('server'), body: (await res.text()).slice(0, 400) };
  }, ENDPOINT);
  console.log('    status', inPage.status, '| server', inPage.server);
  console.log('    body  ', inPage.body.replace(/\s+/g, ' ').slice(0, 320));

  console.log('\n[4] same POST from Node, carrying the browser cookies (non-browser TLS)');
  const jar = cookies.map((c) => `${c.name}=${c.value}`).join('; ');
  const ua = await page.evaluate(() => navigator.userAgent);
  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'X-Requested-With': 'XMLHttpRequest',
      'User-Agent': ua,
      Accept: 'application/json, text/javascript, */*; q=0.01',
      'Accept-Language': 'en-US,en;q=0.9',
      Origin: 'https://www.bizbuysell.com',
      Referer: LANDING,
      Cookie: jar,
    },
    body: '{}',
  });
  const text = await res.text();
  console.log('    status', res.status, '| server', res.headers.get('server'));
  console.log('    body  ', text.replace(/\s+/g, ' ').slice(0, 320));
} finally {
  await ctx.close().catch(() => {});
}

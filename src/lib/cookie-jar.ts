/**
 * Keep Akamai's cookies alive across restarts.
 *
 * The browser profile lives in `os.tmpdir()`, which Railway wipes on every
 * deploy, crash and scale event. Chrome therefore launches with an empty cookie
 * jar every time, and Akamai meets a client that has never visited before,
 * carries no `_abck`, and immediately asks for a filtered search page. That is
 * the profile of a scraper, and it is the profile we present on every single
 * cold start — several times a day.
 *
 * A returning visitor with a warmed `_abck` is treated very differently from a
 * stranger. So the jar is persisted to Postgres, which survives everything the
 * filesystem does not, and restored before the first navigation.
 *
 * Postgres rather than a mounted Volume on purpose: a Volume is a dashboard
 * setting nobody will remember to reattach, and this has to keep working
 * without anyone maintaining it.
 *
 * Cookies are session state, not secrets to hoard — they expire, and a stale
 * jar is worse than none because it presents a dead session as a live one. So
 * anything older than MAX_AGE is discarded rather than replayed.
 */
import type { BrowserContext } from 'patchright';
import { prisma } from './db.js';

/**
 * How long a saved jar is worth restoring.
 *
 * Akamai's `_abck` is refreshed constantly and its validity is measured in
 * hours, not weeks. Replaying a jar from last Tuesday asserts a session that
 * expired days ago, which is a worse signal than arriving clean.
 */
const MAX_AGE_MS = 12 * 60 * 60 * 1000;

/** The cookies actually worth carrying between sessions. */
const WORTH_KEEPING = /^(_abck|ak_bmsc|bm_sv|bm_mi|bm_sz|RT|ASP\.NET|__cf|_gcl|visid)/i;

interface StoredCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  expires: number;
  httpOnly: boolean;
  secure: boolean;
  sameSite: 'Strict' | 'Lax' | 'None';
}

/**
 * Put yesterday's session back before the first request.
 *
 * Best-effort throughout: a jar that will not restore must never stop a run,
 * because arriving cold still works often enough to be worth trying.
 */
export async function restoreCookies(context: BrowserContext): Promise<number> {
  try {
    const settings = await prisma.settings.findUnique({
      where: { id: 1 },
      select: { browserCookies: true, browserCookiesAt: true },
    });

    if (!settings?.browserCookies || !settings.browserCookiesAt) return 0;

    const age = Date.now() - new Date(settings.browserCookiesAt).getTime();
    if (age > MAX_AGE_MS) return 0;

    const cookies = settings.browserCookies as unknown as StoredCookie[];
    if (!Array.isArray(cookies) || !cookies.length) return 0;

    // Drop anything already expired. Playwright accepts them and the browser
    // then discards them, so a count of "restored" would otherwise be fiction.
    const now = Date.now() / 1000;
    const live = cookies.filter((c) => c.expires === -1 || c.expires > now);
    if (!live.length) return 0;

    await context.addCookies(live);
    return live.length;
  } catch {
    return 0;
  }
}

/**
 * Save the jar for next time.
 *
 * Called after work that Akamai accepted, so what gets stored is a session that
 * demonstrably worked rather than one that was merely attempted.
 */
export async function saveCookies(context: BrowserContext): Promise<number> {
  try {
    const all = await context.cookies();
    const keep = all
      .filter((c) => WORTH_KEEPING.test(c.name) && c.domain.includes('bizbuysell'))
      .map((c) => ({
        name: c.name,
        value: c.value,
        domain: c.domain,
        path: c.path,
        expires: c.expires,
        httpOnly: c.httpOnly,
        secure: c.secure,
        sameSite: c.sameSite,
      }));

    if (!keep.length) return 0;

    await prisma.settings.update({
      where: { id: 1 },
      data: {
        browserCookies: keep as unknown as object,
        browserCookiesAt: new Date(),
      },
    });
    return keep.length;
  } catch {
    return 0;
  }
}

/**
 * Throw the jar away.
 *
 * A session Akamai has started refusing is actively harmful to replay: it
 * identifies us as the client that was just blocked. Better to arrive as
 * somebody new.
 */
export async function clearCookies(): Promise<void> {
  await prisma.settings
    .update({ where: { id: 1 }, data: { browserCookies: undefined, browserCookiesAt: null } })
    .catch(() => {});
}

/**
 * How this system reaches BizBuySell.
 *
 * BizBuySell sits behind Akamai Bot Manager. Measured 6-7 August 2026 from a
 * residential connection whose ordinary Chrome renders the site perfectly:
 *
 *   plain HTTP request ........................... 403 Access Denied
 *   headless Chromium ............................ 403 Access Denied
 *   headless Chromium + stealth patches .......... 403 Access Denied
 *   real Chrome, visible, hand-rolled stealth .... 403 Access Denied
 *   Firecrawl proxy network ...................... homepage yes, search no
 *   patchright, its own recommended config ....... WORKS — 198 listings
 *
 * The last line is the one that matters, and the difference between it and the
 * line above it is instructive: patchright succeeds partly because it does
 * LESS. No custom user-agent, no viewport override, no injected stealth script.
 * Those were all present in the failing configuration and all counterproductive
 * — a spoofed user-agent desyncs from the binary actually making the request,
 * and a JS shim is its own signature layered on patches that already work below
 * the JS layer. What patchright removes instead is the `Runtime.enable` CDP
 * leak, which fires on essentially every automated interaction and which
 * Akamai's sensor probes for directly.
 *
 * Every byte read from the site goes through one interface with several
 * implementations behind it. Filters, extraction, the tracker, the scheduler
 * and the dashboard are written against the interface and none of them know
 * which one is in use — so changing transport is a setting, not a refactor,
 * and `auto` can fall between them without anything else noticing.
 *
 * One trap worth naming: this site answers a blocked client with a complete,
 * valid-looking page shell containing no data. HTTP 200 is therefore not
 * evidence of success, which is why the redundancy chain judges a transport on
 * whether listings actually came back rather than on the status code.
 */
import { chromium, type BrowserContext, type Page } from 'patchright';
import { env } from './env.js';

/**
 * The ways this system can reach BizBuySell.
 *
 *   firecrawl  proxy network, read-only, no setup. Partial coverage.
 *   local      patchright + real Chrome. MEASURED WORKING: 198 listings.
 *   proxy      the same, routed through residential proxies.
 *   camoufox   Firefox fork with anti-detect patches compiled in.
 *   auto       try each in turn until one returns a usable page.
 */
export type TransportKind = 'firecrawl' | 'local' | 'proxy' | 'camoufox' | 'auto';

export interface FetchResult {
  ok: boolean;
  url: string;
  html: string | null;
  status?: number;
  /** Set when the response was a bot-wall rather than the page asked for. */
  blocked?: boolean;
  reason?: string;
}

export interface Transport {
  readonly kind: TransportKind;
  /** Read a page. Used for search results and listing detail. */
  fetch(url: string): Promise<FetchResult>;
  /** True when this transport can also fill in and submit forms. */
  readonly canWrite: boolean;
  /** Release anything long-lived. Safe to call twice. */
  close(): Promise<void>;
}

/**
 * A transport that can hand out a live page for the outreach step to drive.
 *
 * This exists because the write path was hardcoded to Chrome. Reading honoured
 * whichever mode was configured while sending always launched patchright — so
 * on Railway, where Chrome is refused and Camoufox is not, every search
 * succeeded and every send failed with a page.goto error. Forty-four of them,
 * all attributed to the site rather than to us picking the wrong browser.
 *
 * Both browser transports satisfy this; Firecrawl does not, and says so.
 */
export interface WritableTransport extends Transport {
  page(): Promise<Page>;
}

/** Akamai's refusal page is a 403 with a recognisable body. */
export function looksBlocked(html: string | null, status?: number): boolean {
  if (status === 403 || status === 429) return true;
  if (!html) return false;
  return /access denied|pardon our interruption|errors\.edgesuite\.net|you don't have permission/i.test(
    html.slice(0, 4000),
  );
}

// ---------------------------------------------------------------------------
// Firecrawl — read only
// ---------------------------------------------------------------------------

/**
 * Reads through Firecrawl's proxy network.
 *
 * Zero setup and no browser to run, which is why it is the default. Its
 * coverage of BizBuySell is currently partial — the homepage returns, the
 * search pages do not — and that is worth retrying periodically rather than
 * designing around, because proxy pools change.
 */
class FirecrawlTransport implements Transport {
  readonly kind = 'firecrawl' as const;
  readonly canWrite = false;

  async fetch(url: string): Promise<FetchResult> {
    const key = env.firecrawlKey;
    if (!key) return { ok: false, url, html: null, reason: 'FIRECRAWL_API_KEY is not set' };

    try {
      const response = await fetch('https://api.firecrawl.dev/v2/scrape', {
        method: 'POST',
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          url,
          formats: ['rawHtml'],
          onlyMainContent: false,
          proxy: 'stealth',
          maxAge: 0,
          timeout: 60_000,
        }),
      });

      const payload = (await response.json().catch(() => ({}))) as {
        success?: boolean;
        code?: string;
        error?: string;
        data?: { rawHtml?: string; html?: string; metadata?: { statusCode?: number } };
      };

      const html = payload.data?.rawHtml ?? payload.data?.html ?? null;
      const status = payload.data?.metadata?.statusCode;

      if (!payload.success || !html) {
        const reason = payload.code ?? payload.error ?? `HTTP ${response.status}`;
        return {
          ok: false,
          url,
          html: null,
          status,
          // Firecrawl reports every engine failing when the origin refuses it.
          blocked: /ENGINES_FAILED/i.test(String(payload.code)),
          reason: String(reason).slice(0, 300),
        };
      }

      if (looksBlocked(html, status)) {
        return { ok: false, url, html, status, blocked: true, reason: 'bot wall' };
      }
      return { ok: true, url, html, status };
    } catch (err) {
      return { ok: false, url, html: null, reason: (err as Error).message.slice(0, 200) };
    }
  }

  async close() {}
}

// ---------------------------------------------------------------------------
// Browser — read and write
// ---------------------------------------------------------------------------

/**
 * There is deliberately no user-agent, viewport, locale or timezone override
 * here, and no injected stealth script.
 *
 * Every one of those was present in the previous version and every one made
 * things worse. patchright patches `navigator.webdriver`, the launch flags and
 * the CDP leaks below the JavaScript layer; re-patching them from an init
 * script is redundant AND is itself an injection signature. A spoofed
 * user-agent desyncs from the binary actually making the request, which is a
 * stronger signal than not spoofing at all.
 *
 * Measured: with this configuration BizBuySell went from "Access Denied" to a
 * rendered result set of 50 listings.
 */
const PROFILE_LOCK = { held: false as boolean, waiters: [] as (() => void)[] };

/**
 * Chrome takes an exclusive lock on its user-data-dir, so two persistent
 * contexts on the same path cannot coexist. `checkReachability()` is reachable
 * from the settings page at any moment, including halfway through a run — this
 * serialises them rather than letting the second one crash.
 */
const PROFILE_WAIT_MS = 3 * 60 * 1000;

async function acquireProfile(): Promise<() => void> {
  if (PROFILE_LOCK.held) {
    // Wait, but never forever.
    //
    // This used to park on a promise that nothing was obliged to resolve. If a
    // holder ever failed to release — a browser that threw on launch, a close()
    // that ran twice and corrupted the queue — the next caller blocked for the
    // life of the process with no error, no log and no timeout. That is exactly
    // how an armed run reached "Sending to 60 listings" and then sat there for
    // twenty minutes with zero sent AND zero failed: the send loop was not
    // failing, it was waiting on a lock nobody still owned.
    //
    // Failing loudly after three minutes turns a permanent silent wedge into
    // one legible error on one listing, which the retry budget then covers.
    let timer: NodeJS.Timeout | undefined;
    const waiter = new Promise<void>((resolve) => PROFILE_LOCK.waiters.push(resolve));
    const expiry = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error('Timed out waiting for the browser profile — another task still holds it.')),
        PROFILE_WAIT_MS,
      );
    });

    try {
      await Promise.race([waiter, expiry]);
    } finally {
      clearTimeout(timer);
    }
  }

  PROFILE_LOCK.held = true;

  // Releasing twice used to shift a second waiter off the queue and hand the
  // profile to two owners at once — two Chromes on one user-data-dir, which is
  // the crash this lock exists to prevent. Now the second call does nothing.
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const next = PROFILE_LOCK.waiters.shift();
    if (next) next();
    else PROFILE_LOCK.held = false;
  };
}

/**
 * A real browser, optionally routed through a residential proxy.
 *
 * This is the only transport that can send a message, because sending means
 * filling a form and clicking a button on a page that renders in JavaScript.
 * With `proxyServer` set it runs unattended on a server; without it, it is
 * meant for a machine whose connection the site already trusts.
 */
class BrowserTransport implements Transport {
  readonly kind: TransportKind;
  readonly canWrite = true;

  private context: BrowserContext | null = null;
  private release: (() => void) | null = null;
  private warmed = false;

  constructor(
    private readonly opts: {
      kind: TransportKind;
      proxy?: { server: string; username?: string; password?: string };
      profileDir?: string;
    },
  ) {
    this.kind = opts.kind;
  }

  private async ensure(): Promise<BrowserContext> {
    if (this.context) return this.context;

    this.release = await acquireProfile();

    // Everything after acquiring the lock has to hand it back on the way out.
    //
    // It did not before: if Chrome failed to launch, or the warm-up threw, the
    // exception escaped with the lock still held and nothing left holding a
    // reference to the release function. The profile was then unusable for the
    // life of the process — and the next caller waited on it in silence.
    try {
      // patchright's documented optimal configuration, unmodified. Persistent
      // context matters twice over: it is what the project recommends, and it is
      // where Akamai's cookies accumulate across runs. On Railway this path must
      // be a mounted Volume or every deploy starts cold.
      this.context = await chromium.launchPersistentContext(env.profileDir, {
        channel: 'chrome',
        headless: false,
        viewport: null,
        args: [
          // Required when running as root in a container.
          '--no-sandbox',
          // Railway exposes no --shm-size control, so this stays even though
          // patchright would prefer an untouched flag set. Knowing trade-off.
          '--disable-dev-shm-usage',
        ],
        ...(this.opts.proxy ? { proxy: this.opts.proxy } : {}),
      });

      await this.warmUp();
      return this.context;
    } catch (err) {
      await this.context?.close().catch(() => {});
      this.context = null;
      this.release?.();
      this.release = null;
      throw err;
    }
  }

  /**
   * Land on the homepage before asking for anything else.
   *
   * Not politeness — a requirement. Navigating straight to a deep search URL
   * returns a page with no listings in it, while the identical URL reached
   * after a homepage visit returns fifty. Akamai's sensor wants to see a client
   * that loaded the site, ran its script and collected its cookies before it
   * asks for data; a cold arrival at a filtered URL has none of that history.
   *
   * Measured both ways on this machine, minutes apart. This one step is what
   * separates a working read path from an empty one.
   *
   * Once per browser session. The small mouse movement is part of it: the
   * sensor scores interaction, and a pointer that never moves is its own tell.
   */
  private async warmUp(): Promise<void> {
    if (this.warmed || !this.context) return;
    this.warmed = true;

    const page = await this.context.newPage();
    try {
      await page.goto('https://www.bizbuysell.com/', {
        waitUntil: 'domcontentloaded',
        timeout: 60_000,
      });
      await page.waitForTimeout(7000);
      await page.mouse.move(620, 380);
      await page.waitForTimeout(300);
      await page.mouse.move(780, 520);
      await page.mouse.wheel(0, 500);
      await page.waitForTimeout(1500);
    } catch {
      // A failed warm-up is not fatal by itself — the fetch that follows will
      // report the real problem, against the URL that actually matters.
    } finally {
      await page.close().catch(() => {});
    }
  }

  /** A page the caller drives directly — used by the outreach step. */
  async page(): Promise<Page> {
    const context = await this.ensure();
    return context.newPage();
  }

  async fetch(url: string): Promise<FetchResult> {
    let page: Page | null = null;
    try {
      page = await this.page();
      const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
      // Results are rendered client-side; wait for the cards rather than the
      // load event, or every page looks empty.
      await page
        .waitForSelector('a[href*="/business-opportunity/"]', { timeout: 20_000 })
        .catch(() => {});
      await page.waitForTimeout(2500);

      const html = await page.content();
      const status = response?.status();
      if (looksBlocked(html, status)) {
        return { ok: false, url, html, status, blocked: true, reason: 'bot wall' };
      }
      return { ok: true, url, html, status };
    } catch (err) {
      return { ok: false, url, html: null, reason: (err as Error).message.slice(0, 200) };
    } finally {
      await page?.close().catch(() => {});
    }
  }

  async close() {
    await this.context?.close().catch(() => {});
    this.context = null;
    this.release?.();
    this.release = null;
  }
}

export type { BrowserTransport, CamoufoxTransport };

// ---------------------------------------------------------------------------
// Camoufox — a Firefox fork with anti-detect patches compiled in
// ---------------------------------------------------------------------------

/**
 * Camoufox spoofs its fingerprint in C++ rather than by injecting JavaScript,
 * so there is nothing in the page for a detector to introspect, and no CDP at
 * all — Firefox speaks Juggler, so the `Runtime.enable` class of leak does not
 * exist here.
 *
 * Two things to know before reaching for it.
 *
 * First, it is specifically contraindicated for THIS site. camoufox issue #555
 * reports Akamai returning 403 to Camoufox while stock Firefox loads fine over
 * the same protocol, with JA3/JA4 and HTTP/2 fingerprints confirmed identical —
 * isolating the cause to Camoufox's own patches being detectable at the
 * behaviour layer. Against Akamai it may be worse than doing nothing.
 *
 * Second, it is here anyway, on purpose. Detection landscapes move, the patched
 * builds get patched again, and a redundancy layer that costs nothing while
 * idle is worth having ready. It is a selectable mode and never the default.
 *
 * The import is lazy because camoufox-js pulls in a native dependency that will
 * not build on every machine. A missing Camoufox must degrade to a readable
 * message, not take down the process that would have explained it.
 */
class CamoufoxTransport implements Transport {
  readonly kind = 'camoufox' as const;
  readonly canWrite = true;

  private browser: {
    newContext: (options?: Record<string, unknown>) => Promise<BrowserContext>;
    close: () => Promise<void>;
  } | null = null;
  private context: BrowserContext | null = null;
  private warmed = false;

  constructor(private readonly opts: { proxy?: { server: string; username?: string; password?: string } } = {}) {}

  private async ensure() {
    if (this.browser) return this.browser;

    // Import AND launch inside the same guard. The dependency resolves fine on
    // a machine with no C++ toolchain; it fails later, when a native binding is
    // actually dereferenced, with "Could not locate the bindings file" — which
    // says nothing about what to do. Translate it once, here.
    try {
      const { Camoufox } = (await import('camoufox-js')) as {
        Camoufox: (options: Record<string, unknown>) => Promise<unknown>;
      };

      this.browser = (await Camoufox({
        headless: false,
        // Camoufox's own cursor-movement humanisation. Behavioural signals are
        // the layer no fingerprint patch reaches, so this is worth having on.
        humanize: true,
        ...(this.opts.proxy ? { proxy: this.opts.proxy } : {}),
      })) as {
        newContext: (options?: Record<string, unknown>) => Promise<BrowserContext>;
        close: () => Promise<void>;
      };

      // An explicit context with viewport null.
      //
      // Calling newPage() straight off the browser makes Playwright apply a
      // default viewport, and Camoufox rejects that at the protocol layer:
      // "failed to call method 'Browser.setDefaultViewport'". It generates its
      // own window geometry as part of the fingerprint, and overriding it would
      // desync the reported size from the real one — which is itself one of the
      // tells its issue tracker cites.
      this.context = await this.browser.newContext({ viewport: null });
    } catch (err) {
      const message = (err as Error).message;
      const nativeBuildMissing = /bindings file|better.sqlite3|MODULE_NOT_FOUND|NODE_MODULE_VERSION/i.test(message);

      throw new Error(
        nativeBuildMissing
          ? 'Camoufox needs a native module (better-sqlite3) that is not built in this ' +
            'environment. It builds in the Linux container, so this transport works in ' +
            'production and not on a dev machine without a C++ toolchain. Use the Chrome ' +
            'transport locally.'
          : `Camoufox could not start: ${message.slice(0, 160)}`,
      );
    }

    await this.warmUp();
    return this.browser;
  }

  /** Same reasoning as the Chrome transport: a cold deep URL is answered empty. */
  private async warmUp(): Promise<void> {
    if (this.warmed || !this.context) return;
    this.warmed = true;
    const page = await this.context.newPage();
    try {
      await page.goto('https://www.bizbuysell.com/', { waitUntil: 'domcontentloaded', timeout: 60_000 });
      await page.waitForTimeout(7000);
      await page.mouse.move(600, 380);
      await page.mouse.wheel(0, 500);
      await page.waitForTimeout(1200);
    } catch {
      /* the fetch that follows reports the real problem */
    } finally {
      await page.close().catch(() => {});
    }
  }

  async page(): Promise<Page> {
    await this.ensure();
    if (!this.context) throw new Error('Camoufox context was not created');
    return this.context.newPage();
  }

  async fetch(url: string): Promise<FetchResult> {
    let page: Page | null = null;
    try {
      page = await this.page();
      const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
      await page
        .waitForSelector('a[href*="/business-opportunity/"]', { timeout: 20_000 })
        .catch(() => {});
      await page.waitForTimeout(2500);

      const html = await page.content();
      const status = response?.status();
      if (looksBlocked(html, status)) {
        return { ok: false, url, html, status, blocked: true, reason: 'bot wall' };
      }
      return { ok: true, url, html, status };
    } catch (err) {
      return { ok: false, url, html: null, reason: (err as Error).message.slice(0, 200) };
    } finally {
      await page?.close().catch(() => {});
    }
  }

  async close() {
    await this.context?.close().catch(() => {});
    await this.browser?.close().catch(() => {});
    this.context = null;
    this.browser = null;
  }
}

// ---------------------------------------------------------------------------
// Redundancy
// ---------------------------------------------------------------------------

/**
 * Try each transport in turn until one returns a usable page.
 *
 * A page counts as usable only if it actually carries listings. That
 * distinction is the whole point: BizBuySell answers a blocked client with a
 * complete, valid-looking page shell and no data in it, so "HTTP 200" is not
 * evidence of anything. Falling back on status alone would stop at the first
 * transport that was being quietly stonewalled.
 *
 * The winner is remembered for the rest of the session, so a sweep of three
 * hundred pages pays the discovery cost once rather than on every fetch.
 */
class RedundantTransport implements Transport {
  readonly kind = 'auto' as const;
  readonly canWrite = true;

  private members: Transport[];
  private preferred: Transport | null = null;

  constructor(members: Transport[]) {
    this.members = members;
  }

  async fetch(url: string): Promise<FetchResult> {
    const order = this.preferred
      ? [this.preferred, ...this.members.filter((m) => m !== this.preferred)]
      : this.members;

    let last: FetchResult | null = null;

    for (const member of order) {
      let result: FetchResult;
      try {
        result = await member.fetch(url);
      } catch (err) {
        result = { ok: false, url, html: null, reason: (err as Error).message.slice(0, 160) };
      }
      last = { ...result, reason: `[${member.kind}] ${result.reason ?? ''}`.trim() };

      if (result.ok && result.html && hasListings(result.html)) {
        this.preferred = member;
        return { ...result, reason: `via ${member.kind}` };
      }
      // A 200 with no listings is a soft block — keep going rather than
      // reporting success over an empty page.
    }

    return last ?? { ok: false, url, html: null, reason: 'no transport available' };
  }

  async close() {
    await Promise.all(this.members.map((m) => m.close().catch(() => {})));
  }
}

/**
 * Does this page actually contain results?
 *
 * Used to tell a served page from a stonewalled one. Deliberately generous —
 * a single listing link is enough — because the question is "did the data
 * layer answer", not "how many matched".
 */
export function hasListings(html: string): boolean {
  return /href=["'][^"']*\/business-opportunity\/[^"']*\/\d+/i.test(html);
}

// ---------------------------------------------------------------------------
// Selection
// ---------------------------------------------------------------------------

export interface TransportConfig {
  transport: TransportKind;
  proxyServer?: string | null;
  proxyUsername?: string | null;
  proxyPassword?: string | null;
}

export function makeTransport(config: TransportConfig): Transport {
  const proxy = config.proxyServer
    ? {
        server: config.proxyServer,
        username: config.proxyUsername ?? undefined,
        password: config.proxyPassword ?? undefined,
      }
    : undefined;

  switch (config.transport) {
    case 'local':
      return new BrowserTransport({ kind: 'local' });

    case 'proxy': {
      if (!proxy) {
        throw new Error(
          'Proxy transport selected but no proxy server is configured. Set one in Settings, ' +
            'or choose another mode.',
        );
      }
      return new BrowserTransport({ kind: 'proxy', proxy });
    }

    case 'camoufox':
      return new CamoufoxTransport({ proxy });

    /**
     * Redundant mode: the working one first, then the alternatives.
     *
     * Order is by measured result, not by preference. patchright is the only
     * transport observed returning listings from this site; Camoufox is second
     * because it at least runs a real browser; Firecrawl is last because its
     * coverage of the pages that matter is currently nil. Whichever answers
     * first becomes the preferred one for the rest of the session.
     */
    case 'auto': {
      const members: Transport[] = [
        proxy ? new BrowserTransport({ kind: 'proxy', proxy }) : new BrowserTransport({ kind: 'local' }),
        new CamoufoxTransport({ proxy }),
        new FirecrawlTransport(),
      ];
      return new RedundantTransport(members);
    }

    case 'firecrawl':
    default:
      return new FirecrawlTransport();
  }
}

/** A browser-backed transport, for the paths that must write. */
export function makeBrowserTransport(config: TransportConfig): WritableTransport {
  const proxy = config.proxyServer
    ? {
        server: config.proxyServer,
        username: config.proxyUsername ?? undefined,
        password: config.proxyPassword ?? undefined,
      }
    : undefined;

  switch (config.transport) {
    case 'camoufox':
      return new CamoufoxTransport({ proxy });

    // Explicit, not falling through to the default. Omitting this sent every
    // 'local' request to Camoufox — which on a dev machine with no native build
    // reported "Camoufox needs better-sqlite3" for a mode that never asked for
    // Camoufox. A default branch that silently swallows a named option is worse
    // than no default at all.
    case 'local':
      return new BrowserTransport({ kind: 'local', proxy });

    case 'proxy':
      if (proxy) return new BrowserTransport({ kind: 'proxy', proxy });
      return new BrowserTransport({ kind: 'local' });

    /**
     * Firecrawl cannot fill a form, and `auto` is a read-side chain. Both fall
     * back to a real browser — but which one matters, so prefer whichever the
     * reachability check last found working rather than assuming Chrome.
     */
    case 'auto':
    case 'firecrawl':
    default:
      return preferredWriteTransport(proxy);
  }
}

/**
 * Remembered from the last successful reachability check.
 *
 * The write path cannot try three browsers per listing — each launch costs
 * twenty seconds and the form is behind a page load. So it uses what was
 * observed to work, and defaults to Camoufox on a server because that is what
 * this deployment measured: Chrome from a datacentre IP is refused, Camoufox is
 * not. On a machine where Chrome works, testing the mode updates this.
 */
let lastWorkingBrowser: 'local' | 'camoufox' | null = null;

export function noteWorkingBrowser(kind: TransportKind): void {
  if (kind === 'local' || kind === 'camoufox') lastWorkingBrowser = kind;
}

function preferredWriteTransport(
  proxy?: { server: string; username?: string; password?: string },
): WritableTransport {
  const choice = lastWorkingBrowser ?? (env.defaultWriteBrowser as 'local' | 'camoufox');
  return choice === 'camoufox'
    ? new CamoufoxTransport({ proxy })
    : new BrowserTransport({ kind: 'local', proxy });
}

/**
 * Can we reach the site at all right now?
 *
 * Surfaced in the dashboard so the answer to "why did the run find nothing" is
 * one click away rather than a support conversation.
 */
export interface ModeVerdict {
  mode: TransportKind;
  /** works | empty | blocked | error */
  verdict: 'works' | 'empty' | 'blocked' | 'error';
  listings: number;
  seconds: number;
  detail: string;
}

/** One search page, filtered exactly as a real run would ask for it. */
const PROBE_URL =
  'https://www.bizbuysell.com/manufacturing-businesses-for-sale/?q=' +
  encodeURIComponent(Buffer.from('lt=30,40,80&cffrom=750000&cfto=1000000', 'utf8').toString('base64'));

/**
 * Can this specific transport get data, right now?
 *
 * ONE transport, ONE page, hard time limit. An earlier version walked every
 * transport in sequence, launching a browser and warming up for each — which on
 * the deployed container took longer than the platform's proxy would wait and
 * came back to the operator as a bare 502. A diagnostic that cannot finish is
 * worse than no diagnostic, because it looks like the app is broken rather than
 * the site being blocked.
 *
 * The homepage is deliberately NOT tested. Everybody is served the homepage,
 * including clients that get nothing else, so a pass there is not evidence of
 * anything. The only question worth asking is whether a filtered search page
 * comes back carrying listings.
 */
export async function checkMode(
  mode: TransportKind,
  config: TransportConfig,
  budgetMs = 90_000,
): Promise<ModeVerdict> {
  const started = Date.now();
  const seconds = () => Math.round((Date.now() - started) / 1000);

  let transport: Transport;
  try {
    transport = makeTransport({ ...config, transport: mode });
  } catch (err) {
    return { mode, verdict: 'error', listings: 0, seconds: seconds(), detail: (err as Error).message };
  }

  try {
    const result = await Promise.race([
      transport.fetch(PROBE_URL),
      new Promise<FetchResult>((resolve) =>
        setTimeout(
          () => resolve({ ok: false, url: PROBE_URL, html: null, reason: `gave up after ${budgetMs / 1000}s` }),
          budgetMs,
        ),
      ),
    ]);

    if (!result.ok || !result.html) {
      return {
        mode,
        verdict: result.blocked ? 'blocked' : 'error',
        listings: 0,
        seconds: seconds(),
        detail: result.reason ?? 'no page returned',
      };
    }

    // Count listings, not status codes. A blocked client is served a complete,
    // valid-looking page with no data in it, so HTTP 200 proves nothing.
    const listings = (result.html.match(/href=["'][^"']*\/business-opportunity\/[^"']*\/\d+/gi) ?? []).length;

    if (listings > 0) noteWorkingBrowser(mode);

    return listings > 0
      ? { mode, verdict: 'works', listings, seconds: seconds(), detail: `${listings} listings returned` }
      : {
          mode,
          verdict: 'empty',
          listings: 0,
          seconds: seconds(),
          detail: 'page served but carried no listings — a silent block',
        };
  } catch (err) {
    return { mode, verdict: 'error', listings: 0, seconds: seconds(), detail: (err as Error).message.slice(0, 200) };
  } finally {
    await transport.close().catch(() => {});
  }
}

/**
 * Test the configured transport, and say plainly what to do about the answer.
 */
export async function checkReachability(
  config: TransportConfig,
): Promise<{ ok: boolean; detail: string; verdict: ModeVerdict }> {
  const verdict = await checkMode(config.transport, config);

  const advice: Record<ModeVerdict['verdict'], string> = {
    works: `"${verdict.mode}" is working — ${verdict.listings} listings came back. Runs will find businesses.`,
    empty:
      `"${verdict.mode}" reached the site but was served an empty page. That is Akamai blocking silently, ` +
      `not an error in the app. Try another mode, or run the browser from a network the site trusts.`,
    blocked: `"${verdict.mode}" was refused outright: ${verdict.detail}. Try another mode.`,
    error: `"${verdict.mode}" could not run: ${verdict.detail}`,
  };

  return { ok: verdict.verdict === 'works', detail: advice[verdict.verdict], verdict };
}

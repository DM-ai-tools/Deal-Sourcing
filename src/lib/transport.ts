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
async function acquireProfile(): Promise<() => void> {
  if (PROFILE_LOCK.held) {
    await new Promise<void>((resolve) => PROFILE_LOCK.waiters.push(resolve));
  }
  PROFILE_LOCK.held = true;
  return () => {
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

export type { BrowserTransport };

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

  private browser: { newPage: () => Promise<Page>; close: () => Promise<void> } | null = null;
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
      })) as { newPage: () => Promise<Page>; close: () => Promise<void> };
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
    if (this.warmed || !this.browser) return;
    this.warmed = true;
    const page = await this.browser.newPage();
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
    const browser = await this.ensure();
    return browser.newPage();
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
    await this.browser?.close().catch(() => {});
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
export function makeBrowserTransport(config: TransportConfig): BrowserTransport {
  if (config.transport === 'proxy' && config.proxyServer) {
    return new BrowserTransport({
      kind: 'proxy',
      proxy: {
        server: config.proxyServer,
        username: config.proxyUsername ?? undefined,
        password: config.proxyPassword ?? undefined,
      },
    });
  }
  return new BrowserTransport({ kind: 'local' });
}

/**
 * Can we reach the site at all right now?
 *
 * Surfaced in the dashboard so the answer to "why did the run find nothing" is
 * one click away rather than a support conversation.
 */
export async function checkReachability(
  config: TransportConfig,
): Promise<{ ok: boolean; detail: string; checked: { url: string; ok: boolean; reason?: string }[] }> {
  const transport = makeTransport(config);
  const targets = [
    'https://www.bizbuysell.com/',
    'https://www.bizbuysell.com/california-businesses-for-sale/',
  ];

  const checked: { url: string; ok: boolean; reason?: string }[] = [];
  try {
    for (const url of targets) {
      const result = await transport.fetch(url);
      checked.push({ url, ok: result.ok, reason: result.reason });
    }
  } finally {
    await transport.close();
  }

  const searchOk = checked[1]?.ok ?? false;
  return {
    ok: searchOk,
    detail: searchOk
      ? `Search pages are reachable via "${config.transport}".`
      : `Search pages are blocked via "${config.transport}". This is Akamai refusing the connection, ` +
        `not a fault in the app — try the "local" transport from a trusted machine, or configure residential proxies.`,
    checked,
  };
}

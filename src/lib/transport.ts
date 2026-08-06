/**
 * How this system reaches BizBuySell.
 *
 * BizBuySell sits behind Akamai Bot Manager. Measured on 6 August 2026, from a
 * residential connection whose ordinary Chrome renders the site perfectly:
 *
 *   plain HTTP request ........................... 403 Access Denied
 *   headless Chromium ............................ 403 Access Denied
 *   headless Chromium + stealth patches .......... 403 Access Denied
 *   real Chrome, visible, stealth patches ........ 403 Access Denied
 *   real Chrome, warmed persistent profile ....... 403 Access Denied
 *   Firecrawl proxy network ...................... homepage yes, search no
 *
 * No arrangement of code changes that. What changes it is the network the
 * request comes from — which is a deployment decision, not a programming one.
 *
 * So every byte this system reads from BizBuySell goes through one interface
 * with three implementations behind it. Filters, extraction, the tracker, the
 * scheduler and the dashboard are all written against the interface and none of
 * them know which one is in use. Changing transport is a setting.
 */
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { env } from './env.js';

export type TransportKind = 'firecrawl' | 'local' | 'proxy';

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

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

/**
 * Removes the tells that a stock automated browser leaves in the DOM.
 *
 * Not sufficient on its own against Akamai — proven above — but it costs
 * nothing and it is necessary alongside a network the site accepts.
 */
const STEALTH_INIT = `
  Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  Object.defineProperty(navigator, 'plugins', { get: () => [1,2,3,4,5] });
  Object.defineProperty(navigator, 'languages', { get: () => ['en-US','en'] });
  window.chrome = { runtime: {}, loadTimes: () => {}, csi: () => {} };
`;

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

  private browser: Browser | null = null;
  private context: BrowserContext | null = null;

  constructor(
    private readonly opts: {
      kind: TransportKind;
      headless?: boolean;
      proxy?: { server: string; username?: string; password?: string };
      profileDir?: string;
    },
  ) {
    this.kind = opts.kind;
  }

  private async ensure(): Promise<BrowserContext> {
    if (this.context) return this.context;

    this.browser = await chromium.launch({
      headless: this.opts.headless ?? true,
      args: [
        '--disable-blink-features=AutomationControlled',
        '--no-sandbox',
        '--disable-dev-shm-usage',
      ],
      ...(this.opts.proxy ? { proxy: this.opts.proxy } : {}),
    });

    this.context = await this.browser.newContext({
      userAgent: UA,
      viewport: { width: 1440, height: 900 },
      locale: 'en-US',
      timezoneId: 'America/New_York',
    });
    await this.context.addInitScript(STEALTH_INIT);
    return this.context;
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
      // Listing pages hydrate their price block after load.
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

export type { BrowserTransport };

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
  switch (config.transport) {
    case 'local':
      return new BrowserTransport({ kind: 'local', headless: env.headlessBrowser });

    case 'proxy': {
      if (!config.proxyServer) {
        throw new Error(
          'Proxy transport selected but no proxy server is configured. Set one in Settings, ' +
            'or switch transport to "local" or "firecrawl".',
        );
      }
      return new BrowserTransport({
        kind: 'proxy',
        headless: true,
        proxy: {
          server: config.proxyServer,
          username: config.proxyUsername ?? undefined,
          password: config.proxyPassword ?? undefined,
        },
      });
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
      headless: true,
      proxy: {
        server: config.proxyServer,
        username: config.proxyUsername ?? undefined,
        password: config.proxyPassword ?? undefined,
      },
    });
  }
  return new BrowserTransport({ kind: 'local', headless: env.headlessBrowser });
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

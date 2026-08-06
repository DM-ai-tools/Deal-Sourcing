/**
 * Sending the enquiry.
 *
 * This is the only module that does something irreversible, so it is written
 * defensively at every step:
 *
 *   - Nothing sends unless sending is armed in Settings AND the run itself is
 *     not a dry run. Two switches, both of which default to off.
 *   - The database, not a flag, guarantees one message per listing: Outreach
 *     has a unique constraint on listingId, so even two runs racing each other
 *     cannot double-send.
 *   - Every send is paced with a randomised delay and bounded by a daily cap.
 *     Three hundred identical messages in ten minutes is how an account gets
 *     suspended and how brokers learn to ignore you.
 *   - A failure captures a screenshot, because "it didn't work" is not a
 *     diagnosis and this page is not ours to guess about.
 */
import type { Page } from 'playwright';
import type { BrowserTransport } from './transport.js';

export interface ContactDetails {
  fullName: string;
  email: string;
  phone: string;
  message: string;
}

export interface SendOutcome {
  ok: boolean;
  confirmation?: string;
  error?: string;
  screenshot?: string;
  /** True when the page showed the form as already submitted for this listing. */
  alreadyContacted?: boolean;
}

/**
 * Log in once per browser session.
 *
 * Called before the first send and never again for that session — the whole
 * point of a persistent context. If BizBuySell drops the session mid-run the
 * next send fails visibly rather than silently posting as an anonymous user.
 */
export async function login(
  transport: BrowserTransport,
  credentials: { email: string; password: string },
): Promise<{ ok: boolean; error?: string }> {
  let page: Page | null = null;
  try {
    page = await transport.page();
    await page.goto('https://www.bizbuysell.com/users/login.aspx', {
      waitUntil: 'domcontentloaded',
      timeout: 60_000,
    });
    await page.waitForTimeout(2000);

    const email = page.locator('input[type="email"], input[name*="mail" i], #username').first();
    const password = page.locator('input[type="password"]').first();

    if (!(await email.isVisible().catch(() => false))) {
      return { ok: false, error: 'Login page did not render its form — likely blocked before login.' };
    }

    await email.fill(credentials.email);
    await humanPause(page, 400, 900);
    await password.fill(credentials.password);
    await humanPause(page, 400, 900);

    await Promise.all([
      page.waitForLoadState('domcontentloaded').catch(() => {}),
      page.locator('button[type="submit"], input[type="submit"]').first().click(),
    ]);
    await page.waitForTimeout(4000);

    // Signed-in pages stop offering "Sign In".
    const stillAnonymous = await page
      .locator('a:has-text("Sign In"), a[href*="login"]')
      .first()
      .isVisible()
      .catch(() => false);

    if (stillAnonymous) {
      return { ok: false, error: 'Signed in but the page still shows Sign In — credentials rejected?' };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: (err as Error).message.slice(0, 200) };
  } finally {
    await page?.close().catch(() => {});
  }
}

/**
 * Fill and submit the contact form on one listing.
 *
 * `armed` is passed explicitly rather than read from config inside here, so the
 * decision to send is always made by the caller and is visible at the call
 * site. When false this does everything except press the button — which is
 * exactly what a dry run should prove.
 */
export async function sendEnquiry(
  transport: BrowserTransport,
  listingUrl: string,
  contact: ContactDetails,
  armed: boolean,
): Promise<SendOutcome> {
  let page: Page | null = null;

  try {
    page = await transport.page();
    await page.goto(listingUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    await page.waitForTimeout(2500);

    const title = await page.title();
    if (/access denied|pardon our interruption/i.test(title)) {
      return { ok: false, error: 'Blocked by the site before the form could be reached.' };
    }

    // The form sits in the right-hand rail. Locate by its own field labels
    // rather than by class names, which are the site's to change.
    const nameField = page
      .locator('input[placeholder*="Full Name" i], input[name*="name" i]')
      .first();
    const emailField = page
      .locator('input[type="email"], input[placeholder*="Email" i]')
      .first();
    const phoneField = page
      .locator('input[type="tel"], input[placeholder*="Phone" i]')
      .first();
    const messageField = page
      .locator('textarea, [placeholder*="Message" i]')
      .first();
    const submit = page
      .getByRole('button', { name: /send message/i })
      .first();

    if (!(await messageField.isVisible().catch(() => false))) {
      // Some listings are sold or withdrawn and drop the form entirely.
      const sold = await page
        .locator('text=/no longer available|has been sold|listing removed/i')
        .first()
        .isVisible()
        .catch(() => false);
      return {
        ok: false,
        error: sold ? 'Listing is no longer available.' : 'Contact form not found on this listing.',
        screenshot: await shot(page),
      };
    }

    // Fill in the order a person would, with pauses between fields. The delays
    // are not superstition: form-analytics timing is one of the cheaper bot
    // signals, and a form completed in 40ms is conspicuous.
    if (await nameField.isVisible().catch(() => false)) {
      await nameField.fill(contact.fullName);
      await humanPause(page);
    }
    if (await phoneField.isVisible().catch(() => false)) {
      await phoneField.fill(contact.phone);
      await humanPause(page);
    }
    if (await emailField.isVisible().catch(() => false)) {
      await emailField.fill(contact.email);
      await humanPause(page);
    }

    await messageField.fill(contact.message);
    await humanPause(page, 700, 1500);

    // The newsletter opt-in is pre-ticked by the site. Leave the buyer opted
    // out unless they have asked otherwise — this is their inbox.
    const newsletter = page.locator('input[type="checkbox"]').first();
    if (await newsletter.isChecked().catch(() => false)) {
      await newsletter.uncheck().catch(() => {});
    }

    if (!armed) {
      return {
        ok: true,
        confirmation:
          'DRY RUN — form filled exactly as it would be sent, and left unsubmitted. Nothing was sent.',
        screenshot: await shot(page),
      };
    }

    await submit.click();
    await page.waitForTimeout(5000);

    const body = await page.locator('body').innerText().catch(() => '');
    const confirmed = /thank you|your message has been sent|we've sent|request sent|has been submitted/i.test(body);

    if (!confirmed) {
      return {
        ok: false,
        error: 'Submitted, but no confirmation appeared. Treat as unsent and check the screenshot.',
        screenshot: await shot(page),
      };
    }

    return {
      ok: true,
      confirmation: body.match(/[^.\n]*(?:thank you|message has been sent)[^.\n]*/i)?.[0]?.trim().slice(0, 200),
    };
  } catch (err) {
    return {
      ok: false,
      error: (err as Error).message.slice(0, 300),
      screenshot: page ? await shot(page) : undefined,
    };
  } finally {
    await page?.close().catch(() => {});
  }
}

async function shot(page: Page): Promise<string | undefined> {
  try {
    const buffer = await page.screenshot({ type: 'png', fullPage: false });
    return `data:image/png;base64,${buffer.toString('base64')}`;
  } catch {
    return undefined;
  }
}

async function humanPause(page: Page, min = 250, max = 700): Promise<void> {
  await page.waitForTimeout(min + Math.random() * (max - min));
}

/** Delay between two sends, jittered so the rhythm is not machine-regular. */
export function sendDelayMs(minSeconds: number, maxSeconds: number): number {
  const min = Math.max(5, minSeconds);
  const max = Math.max(min + 1, maxSeconds);
  return Math.round((min + Math.random() * (max - min)) * 1000);
}

/** The client's message, with the placeholders they may want filled. */
export function renderMessage(template: string, listing: { title: string }): string {
  return template
    .replace(/\{\{\s*listing\s*\}\}/gi, listing.title)
    .replace(/\{\{\s*title\s*\}\}/gi, listing.title)
    .trim();
}

export const DEFAULT_MESSAGE = `Hi,

We are a family office with ample capital to deploy and are reaching out regarding this listing. Based on the information available, we are interested in evaluating the opportunity further and would appreciate receiving the CIM and any relevant process materials.

We are prepared to execute an NDA promptly. Please let us know the next steps and whether any additional information is needed from our side.

I'm looking forward to hearing from you soon.

Best regards,
Hyperboards Team`;

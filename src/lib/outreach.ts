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
import type { Page } from 'patchright';
import type { WritableTransport } from './transport.js';

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
  transport: WritableTransport,
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

    // First VISIBLE match, not first match.
    //
    // This previously used `.first()` on comma-separated selectors and reported
    // "the login page did not render its form" — which was never true. The form
    // was there; the locator was resolving to a hidden duplicate, exactly as it
    // did on the contact form. That false diagnosis is why login was written off
    // as blocked and made non-fatal.
    const email = await visibleField(page, [
      '#username',
      'input[type="email"]',
      'input[name*="mail" i]',
    ]);
    const password = await visibleField(page, ['input[type="password"]']);

    if (!email || !password) {
      return { ok: false, error: 'No visible login form on the page — blocked, or the page changed.' };
    }

    await email.fill(credentials.email);
    await humanPause(page, 400, 900);
    await password.fill(credentials.password);
    await humanPause(page, 400, 900);

    const submit = await visibleField(page, [
      'button[type="submit"]',
      'input[type="submit"]',
      'button:has-text("Sign In")',
      'a:has-text("Sign In")',
    ]);
    if (!submit) return { ok: false, error: 'Login form found but no visible submit control.' };

    await Promise.all([
      page.waitForLoadState('domcontentloaded').catch(() => {}),
      submit.click(),
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
 * The first VISIBLE element matching any of these selectors.
 *
 * A listing page carries three copies of the contact form — one in the rail,
 * others hidden for other breakpoints — plus five iframes and forty-three
 * inputs. A comma-separated selector matches all three copies and `.first()`
 * returns whichever appears first in the DOM, which is a hidden one. That is
 * how a dry run came back "ok" over a form with an empty name, phone and email:
 * the locator resolved, the fill silently went nowhere visible, and nothing
 * checked afterwards.
 *
 * So: walk the strategies in order, walk each match, and return the first that
 * a person could actually see.
 */
async function visibleField(page: Page, selectors: string[]) {
  for (const selector of selectors) {
    const locator = page.locator(selector);
    const count = await locator.count().catch(() => 0);
    for (let index = 0; index < count; index++) {
      const candidate = locator.nth(index);
      if (await candidate.isVisible().catch(() => false)) return candidate;
    }
  }
  return null;
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
  transport: WritableTransport,
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

    // Wait for the form to exist before looking for its fields.
    //
    // The right-hand rail hydrates well after the page body, and it is not
    // consistent: one probe load never rendered the form within 45 seconds
    // while the next rendered it in three. A fixed sleep turns that variance
    // into "this listing has no contact form", which is a lie that costs a
    // deal — the listing is fine, we simply looked too early.
    const formAppeared = await page
      .waitForSelector('#txtMessage, textarea', { state: 'attached', timeout: 40_000 })
      .then(() => true)
      .catch(() => false);

    if (!formAppeared) {
      const sold = await page
        .locator('text=/no longer available|has been sold|listing removed/i')
        .first()
        .isVisible()
        .catch(() => false);
      return {
        ok: false,
        error: sold
          ? 'Listing is no longer available.'
          : 'The contact form never rendered — the page loaded but the rail did not. Worth retrying.',
        screenshot: await shot(page),
      };
    }
    // Let the fields finish wiring up now that the form itself is there.
    await page.waitForTimeout(1200);

    // Exact ids first — measured to be unique and visible — then a labelled
    // fallback for pages whose ids differ. Each returns the first VISIBLE match.
    const nameField = await visibleField(page, ['#txtName', 'input[placeholder="Full Name"]']);
    const phoneField = await visibleField(page, ['#txtPhone', 'input[type="tel"]']);
    const emailField = await visibleField(page, ['#txtEmail', 'input[type="email"]']);
    const messageField = await visibleField(page, ['#txtMessage', 'textarea']);

    if (!messageField || !nameField || !emailField) {
      const sold = await page
        .locator('text=/no longer available|has been sold|listing removed/i')
        .first()
        .isVisible()
        .catch(() => false);
      return {
        ok: false,
        error: sold
          ? 'Listing is no longer available.'
          : `Contact form incomplete on this listing (name=${Boolean(nameField)}, ` +
            `email=${Boolean(emailField)}, message=${Boolean(messageField)}).`,
        screenshot: await shot(page),
      };
    }

    // Fill in the order a person would, with pauses. Form-analytics timing is a
    // cheap bot signal and a form completed in 40ms is conspicuous.
    await nameField.fill(contact.fullName);
    await humanPause(page);
    if (phoneField) {
      await phoneField.fill(contact.phone);
      await humanPause(page);
    }
    await emailField.fill(contact.email);
    await humanPause(page);
    await messageField.fill(contact.message);
    await humanPause(page, 700, 1500);

    // Read every required field back before going near the button.
    //
    // This is the guard the earlier version lacked. All three are marked
    // required by the site, and an enquiry reaching a broker with an empty name
    // and no reply address is worse than one that never arrives — they cannot
    // answer it, and it burns the relationship the whole system exists to build.
    const written = {
      name: await nameField.inputValue().catch(() => ''),
      phone: phoneField ? await phoneField.inputValue().catch(() => '') : 'n/a',
      email: await emailField.inputValue().catch(() => ''),
      message: await messageField.inputValue().catch(() => ''),
    };

    const empty = Object.entries(written)
      .filter(([, value]) => !value.trim())
      .map(([field]) => field);

    if (empty.length) {
      return {
        ok: false,
        error:
          `The form did not accept: ${empty.join(', ')}. Nothing was submitted — sending a broker ` +
          `an enquiry with those blank is worse than not sending one.`,
        screenshot: await shot(page),
      };
    }

    if (written.email !== contact.email || written.name !== contact.fullName) {
      return {
        ok: false,
        error:
          `Field mismatch — the page holds name "${written.name}" and email "${written.email}". ` +
          `A different element was filled than the one intended. Not submitted.`,
        screenshot: await shot(page),
      };
    }

    // The newsletter opt-in is pre-ticked by the site. Leave the buyer opted
    // out unless they ask otherwise — it is their inbox.
    // The newsletter opt-in is pre-ticked by the site. Leave the buyer opted
    // out unless they ask otherwise — it is their inbox, and nobody asked for it.
    //
    // The real <input> is visually replaced by a styled label, so `isVisible()`
    // is false for it and `uncheck()` never lands. Untick it in the DOM and fire
    // the events the framework listens for — the same approach the search
    // filters needed, and for the same reason.
    await page
      .$$eval('input[type="checkbox"]', (boxes) => {
        for (const box of boxes as any[]) {
          const near = (box.closest('label') ?? box.parentElement)?.textContent ?? '';
          // A real click toggles it and fires the framework's own handlers —
          // no need to synthesise events the page may or may not listen for.
          if (box.checked && /newsletter|send me|subscribe/i.test(near)) box.click();
        }
      })
      .catch(() => {});

    if (!armed) {
      return {
        ok: true,
        confirmation:
          `DRY RUN — form verified filled (name, phone, email, message all present) and left ` +
          `unsubmitted. Nothing was sent.`,
        screenshot: await shot(page),
      };
    }

    // The submit control is not a <button> and not an <input type="submit"> —
    // a dump of every visible form control on the page contains neither. It is
    // styled markup, so find it the same way as the fields: first visible match
    // across several strategies, widest last.
    const submit = await visibleField(page, [
      '#btnSubmit',
      '#btnSendMessage',
      'button[type="submit"]',
      'input[type="submit"]',
      'button:has-text("Send Message")',
      'a:has-text("Send Message")',
      '[class*="submit" i]:has-text("Send")',
      ':is(button, a, div, span)[role="button"]:has-text("Send")',
      ':is(button, a):has-text("Send")',
    ]);

    if (!submit) {
      // Say what was actually there. "Button not found" sends whoever reads it
      // back to the browser to look; the markup answers it in the log.
      const around = await page
        .$eval('#txtMessage', (element) => {
          const node = element as any;
          const form = node.closest('form') ?? node.parentElement?.parentElement;
          return ((form?.outerHTML ?? '(no form found)') as string).replace(/\s+/g, ' ').slice(-700);
        })
        .catch(() => '(could not read the form)');
      return {
        ok: false,
        error: `Form filled but no submit control matched. Nothing sent. Form tail: ${around}`,
        screenshot: await shot(page),
      };
    }

    // Snapshot the page before clicking, so success means the confirmation
    // APPEARED rather than merely being present. A listing page that already
    // says "thank you" anywhere — a testimonial, a footer, a cookie notice —
    // would otherwise be read as proof of a send that never happened, and a
    // false "sent" is the one error that can never be recovered: the listing is
    // retired, nobody is contacted, and the tracker says the job is done.
    const CONFIRMATION = /thank you|your message has been sent|we've sent|request sent|has been submitted/i;
    const before = await page.locator('body').innerText().catch(() => '');
    const alreadySaidIt = CONFIRMATION.test(before);

    await submit.scrollIntoViewIfNeeded().catch(() => {});
    await submit.click();
    await page.waitForTimeout(5000);

    const body = await page.locator('body').innerText().catch(() => '');
    const confirmed = alreadySaidIt
      ? // The phrase was already on the page, so its presence proves nothing.
        // Fall back to the stronger signal: the form is gone or emptied, which
        // is what this site does on a successful submit.
        !(await messageField.inputValue().catch(() => '')).trim()
      : CONFIRMATION.test(body);

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

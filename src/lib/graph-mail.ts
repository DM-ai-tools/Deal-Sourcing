/**
 * Reading the mailbox through Microsoft Graph.
 *
 * IMAP does not work here and no password will fix it: hyperboards.com is on
 * Exchange Online, and Microsoft disabled basic authentication for IMAP across
 * the service. The probe returns `AUTHENTICATE failed / authenticationFailed:
 * true` for a correct password, which is the server saying "not this way"
 * rather than "wrong secret".
 *
 * Graph with client credentials is the route that suits a daemon: no user is
 * sitting there to approve a login, the token is fetched and refreshed by the
 * app itself, and the permission granted is `Mail.Read` — read-only, which
 * matches what this feature is allowed to do anyway.
 *
 * No SDK. This is two HTTP calls, and `@azure/msal-node` plus the Graph client
 * is a large dependency to carry for a form POST and a GET — the same reasoning
 * that kept `googleapis` out of sheets.ts.
 */

export interface GraphCredentials {
  tenantId: string;
  clientId: string;
  clientSecret: string;
  userEmail: string;
}

/** One message, in the shape the inbox pipeline works with. */
export interface RawMessage {
  messageId: string;
  fromEmail: string;
  fromName: string | null;
  subject: string;
  body: string;
  receivedAt: Date;
  headers: Map<string, string>;
  /// Everyone the message was addressed to, lower-cased. Used to tell a
  /// forwarded broker reply apart from the mailbox owner's own mail.
  toEmails: string[];
}

interface TokenCache {
  token: string;
  expiresAt: number;
}

const tokens = new Map<string, TokenCache>();

/**
 * An app-only access token.
 *
 * Cached until shortly before expiry — the poll runs every five minutes and
 * asking for a new token each time is both slow and a good way to meet a rate
 * limit for no reason.
 */
export async function graphToken(credentials: GraphCredentials): Promise<string> {
  const key = `${credentials.tenantId}:${credentials.clientId}`;
  const cached = tokens.get(key);
  if (cached && cached.expiresAt > Date.now() + 60_000) return cached.token;

  const response = await fetch(
    `https://login.microsoftonline.com/${encodeURIComponent(credentials.tenantId)}/oauth2/v2.0/token`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: credentials.clientId,
        client_secret: credentials.clientSecret,
        scope: 'https://graph.microsoft.com/.default',
        grant_type: 'client_credentials',
      }),
    },
  );

  const payload = (await response.json().catch(() => ({}))) as {
    access_token?: string;
    expires_in?: number;
    error?: string;
    error_description?: string;
  };

  if (!response.ok || !payload.access_token) {
    // Azure's error_description is genuinely useful — it names the missing
    // consent or the wrong tenant — and hiding it behind "token request failed"
    // would waste someone's afternoon.
    throw new Error(
      payload.error_description?.split('\n')[0] ??
        payload.error ??
        `Token request failed (${response.status})`,
    );
  }

  tokens.set(key, {
    token: payload.access_token,
    expiresAt: Date.now() + (payload.expires_in ?? 3600) * 1000,
  });
  return payload.access_token;
}

/** Confirm the credentials work and the mailbox is readable. */
export async function graphTest(credentials: GraphCredentials): Promise<string> {
  const token = await graphToken(credentials);

  const response = await fetch(
    `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(credentials.userEmail)}` +
      `/mailFolders/inbox?$select=displayName,totalItemCount,unreadItemCount`,
    { headers: { Authorization: `Bearer ${token}` } },
  );

  const payload = (await response.json().catch(() => ({}))) as {
    displayName?: string;
    totalItemCount?: number;
    unreadItemCount?: number;
    error?: { message?: string; code?: string };
  };

  if (!response.ok) {
    const code = payload.error?.code ?? String(response.status);
    const message = payload.error?.message ?? 'Graph refused the request.';
    if (code === 'Authorization_RequestDenied' || response.status === 403) {
      throw new Error(
        `${message} — the app registration is missing admin consent for the ` +
          `application permission Mail.Read (not the delegated one).`,
      );
    }
    if (response.status === 404) {
      throw new Error(`${message} — no mailbox found for ${credentials.userEmail}.`);
    }
    throw new Error(`${code}: ${message}`);
  }

  return (
    `Connected to ${credentials.userEmail} — Inbox has ${payload.totalItemCount ?? 0} message(s), ` +
    `${payload.unreadItemCount ?? 0} unread. Read-only.`
  );
}

/**
 * Messages received after `since`, oldest first.
 *
 * Ascending on purpose: the watermark advances as each message is processed, so
 * if the poll dies halfway the next one resumes from the last message actually
 * handled rather than skipping everything before the newest.
 */
export async function graphFetchSince(
  credentials: GraphCredentials,
  since: Date,
  limit = 50,
): Promise<RawMessage[]> {
  const token = await graphToken(credentials);

  const query = new URLSearchParams({
    $filter: `receivedDateTime gt ${since.toISOString()}`,
    $select:
      'id,internetMessageId,from,toRecipients,ccRecipients,subject,body,bodyPreview,receivedDateTime,internetMessageHeaders',
    $orderby: 'receivedDateTime asc',
    $top: String(limit),
  });

  const response = await fetch(
    `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(credentials.userEmail)}` +
      `/mailFolders/inbox/messages?${query}`,
    { headers: { Authorization: `Bearer ${token}` } },
  );

  const payload = (await response.json().catch(() => ({}))) as {
    value?: GraphMessage[];
    error?: { message?: string; code?: string };
  };

  if (!response.ok) {
    throw new Error(payload.error?.message ?? `Graph read failed (${response.status})`);
  }

  return (payload.value ?? []).map(toRawMessage);
}

interface GraphMessage {
  id: string;
  internetMessageId?: string;
  from?: { emailAddress?: { address?: string; name?: string } };
  toRecipients?: { emailAddress?: { address?: string } }[];
  ccRecipients?: { emailAddress?: { address?: string } }[];
  subject?: string;
  body?: { contentType?: string; content?: string };
  bodyPreview?: string;
  receivedDateTime?: string;
  internetMessageHeaders?: { name: string; value: string }[];
}

function toRawMessage(message: GraphMessage): RawMessage {
  const headers = new Map<string, string>();
  for (const header of message.internetMessageHeaders ?? []) {
    headers.set(header.name.toLowerCase(), header.value);
  }

  // Graph returns HTML for most mail. The matcher works on words, and tags
  // would both hide the text it looks for and pad every snippet with markup.
  const raw = message.body?.content ?? message.bodyPreview ?? '';
  const body =
    message.body?.contentType?.toLowerCase() === 'html'
      ? raw
          .replace(/<style[\s\S]*?<\/style>/gi, ' ')
          .replace(/<script[\s\S]*?<\/script>/gi, ' ')
          .replace(/<br\s*\/?>|<\/p>|<\/div>/gi, '\n')
          .replace(/<[^>]+>/g, ' ')
          .replace(/&nbsp;/gi, ' ')
          .replace(/&amp;/gi, '&')
          .replace(/&lt;/gi, '<')
          .replace(/&gt;/gi, '>')
          .replace(/&quot;/gi, '"')
          .replace(/&#0?39;|&apos;/gi, "'")
      : raw;

  return {
    // internetMessageId is the RFC Message-ID and is stable across folders and
    // re-reads; Graph's own id is not, so it is only the fallback.
    messageId: message.internetMessageId ?? `graph-${message.id}`,
    fromEmail: message.from?.emailAddress?.address ?? '',
    fromName: message.from?.emailAddress?.name ?? null,
    subject: message.subject ?? '',
    body,
    receivedAt: message.receivedDateTime ? new Date(message.receivedDateTime) : new Date(),
    headers,
    toEmails: [...(message.toRecipients ?? []), ...(message.ccRecipients ?? [])]
      .map((r) => r.emailAddress?.address?.toLowerCase())
      .filter((address): address is string => Boolean(address)),
  };
}

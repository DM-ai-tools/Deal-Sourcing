/**
 * The Google Sheet mirror.
 *
 * A live sheet the team can open without logging into anything: every vendor,
 * whether a message went out, whether they replied, what they said, and when
 * each of those happened.
 *
 * Two decisions worth stating because they are not obvious.
 *
 * FIRST — the sheet is a VIEW, never a source of truth. It is rewritten in full
 * on every sync and nothing is read back. Two writable copies of one pipeline is
 * how a status gets silently reverted: someone edits a cell, a sync overwrites
 * it, and nobody can say which version was right. Statuses are changed in the
 * dashboard; the sheet shows them.
 *
 * SECOND — no googleapis dependency. Service-account auth is a signed JWT
 * exchanged for a token, which is about forty lines with node:crypto, against a
 * package that pulls in a hundred-odd transitive dependencies for the same
 * result. Fewer moving parts in the deploy is worth more here than the
 * convenience.
 */
import { createSign } from 'node:crypto';

export interface SheetRow {
  title: string;
  url: string;
  location: string | null;
  datePosted: string | null;
  askingPrice: number | null;
  grossRevenue: number | null;
  cashFlow: number | null;
  ebitda: number | null;
  brokerName: string | null;
  brokerPhone: string | null;
  status: string;
  messageSent: boolean;
  sentAt: Date | null;
  responded: boolean;
  respondedAt: Date | null;
  responseNote: string | null;
  firstSeenAt: Date;
}

interface ServiceAccount {
  client_email: string;
  private_key: string;
}

// Sheets to build the document, Drive to create and share it. A sheet the
// client cannot open is not a deliverable, and sharing lives in the Drive API.
const SCOPE = 'https://www.googleapis.com/auth/spreadsheets https://www.googleapis.com/auth/drive';

/** Column order. Changing this changes the sheet, so it lives in one place. */
const HEADERS = [
  'Listing',
  'Link',
  'Location',
  'Date Listed',
  'Asking Price',
  'Gross Revenue',
  'Cash Flow (SDE)',
  'EBITDA',
  'Broker',
  'Broker Phone',
  'Message Sent',
  'Sent At',
  'Responded',
  'Responded At',
  'Their Response',
  'Status',
  'First Seen',
];

function parseCredentials(raw: string): ServiceAccount {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('Google credentials are not valid JSON. Paste the whole service-account key file.');
  }
  const account = parsed as Partial<ServiceAccount>;
  if (!account.client_email || !account.private_key) {
    throw new Error(
      'That JSON has no client_email/private_key. It should be a service-account key, ' +
        'not an OAuth client or an API key.',
    );
  }
  return { client_email: account.client_email, private_key: account.private_key.replace(/\\n/g, '\n') };
}

const b64url = (input: Buffer | string) =>
  Buffer.from(input).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

/**
 * Service-account JWT, exchanged for an access token.
 *
 * Tokens last an hour; this asks for a fresh one per sync rather than caching.
 * A sync runs at most once a minute, so the extra round trip costs nothing and
 * removes a whole class of "why is it suddenly 401" from the system.
 */
async function accessToken(account: ServiceAccount): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = b64url(
    JSON.stringify({
      iss: account.client_email,
      scope: SCOPE,
      aud: 'https://oauth2.googleapis.com/token',
      iat: now,
      exp: now + 3600,
    }),
  );

  const signer = createSign('RSA-SHA256');
  signer.update(`${header}.${claims}`);
  const signature = b64url(signer.sign(account.private_key));

  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: `${header}.${claims}.${signature}`,
    }),
  });

  const payload = (await response.json().catch(() => ({}))) as {
    access_token?: string;
    error_description?: string;
    error?: string;
  };

  if (!payload.access_token) {
    throw new Error(
      `Google refused the credentials: ${payload.error_description ?? payload.error ?? response.status}`,
    );
  }
  return payload.access_token;
}

const money = (value: number | null) => (value == null ? '' : value);
const when = (value: Date | null) =>
  value ? new Date(value).toISOString().slice(0, 16).replace('T', ' ') : '';

function toCells(row: SheetRow): (string | number)[] {
  return [
    row.title,
    row.url,
    row.location ?? '',
    row.datePosted ?? '',
    money(row.askingPrice),
    money(row.grossRevenue),
    money(row.cashFlow),
    // Blank, not zero. "Not Disclosed" is what BizBuySell shows on most
    // listings, and a 0 here would read as a business with no earnings.
    money(row.ebitda),
    row.brokerName ?? '',
    row.brokerPhone ?? '',
    row.messageSent ? 'YES' : 'NO',
    when(row.sentAt),
    row.responded ? 'YES' : 'NO',
    when(row.respondedAt),
    row.responseNote ?? '',
    row.status,
    when(row.firstSeenAt),
  ];
}

async function call(
  token: string,
  path: string,
  init: { method: string; body?: unknown },
): Promise<unknown> {
  const url = path
    ? `https://sheets.googleapis.com/v4/spreadsheets/${path}`
    : 'https://sheets.googleapis.com/v4/spreadsheets';
  const response = await fetch(url, {
    method: init.method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    ...(init.body ? { body: JSON.stringify(init.body) } : {}),
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    const hint =
      response.status === 403
        ? ' — share the sheet with the service-account email as an Editor.'
        : response.status === 404
          ? ' — check the sheet ID.'
          : '';
    throw new Error(`Sheets API ${response.status}${hint} ${detail.slice(0, 200)}`);
  }
  return response.json().catch(() => ({}));
}

export interface SyncResult {
  ok: boolean;
  rows: number;
  error?: string;
}

/**
 * Rewrite the sheet from the given rows.
 *
 * Clear-then-write rather than an incremental diff. The whole dataset is a few
 * hundred rows, so a full rewrite costs one extra call and removes every
 * question about stale rows, deleted listings and drifting row numbers.
 */
export async function syncToSheet(
  credentialsJson: string,
  sheetId: string,
  rows: SheetRow[],
): Promise<SyncResult> {
  try {
    const token = await accessToken(parseCredentials(credentialsJson));

    await call(token, `${sheetId}/values/A:Z:clear`, { method: 'POST' });

    const values = [HEADERS, ...rows.map(toCells)];
    await call(token, `${sheetId}/values/A1?valueInputOption=RAW`, {
      method: 'PUT',
      body: { range: 'A1', majorDimension: 'ROWS', values },
    });

    // Bold header, frozen top row, and conditional colour so the two questions
    // that matter — did we message them, did they answer — are readable at a
    // glance rather than by reading a column of YES/NO.
    await call(token, `${sheetId}:batchUpdate`, {
      method: 'POST',
      body: {
        requests: [
          {
            repeatCell: {
              range: { sheetId: 0, startRowIndex: 0, endRowIndex: 1 },
              cell: {
                userEnteredFormat: {
                  textFormat: { bold: true },
                  backgroundColor: { red: 0.92, green: 0.94, blue: 0.96 },
                },
              },
              fields: 'userEnteredFormat(textFormat,backgroundColor)',
            },
          },
          {
            updateSheetProperties: {
              properties: { sheetId: 0, gridProperties: { frozenRowCount: 1 } },
              fields: 'gridProperties.frozenRowCount',
            },
          },
          conditionalColour(0, 10, 'YES', { red: 1, green: 0.95, blue: 0.78 }), // sent — amber
          conditionalColour(1, 12, 'YES', { red: 0.79, green: 0.94, blue: 0.8 }), // replied — green
        ],
      },
    });

    return { ok: true, rows: rows.length };
  } catch (err) {
    return { ok: false, rows: 0, error: (err as Error).message.slice(0, 300) };
  }
}

function conditionalColour(
  index: number,
  column: number,
  match: string,
  colour: { red: number; green: number; blue: number },
) {
  return {
    addConditionalFormatRule: {
      index,
      rule: {
        ranges: [{ sheetId: 0, startRowIndex: 1, startColumnIndex: column, endColumnIndex: column + 1 }],
        booleanRule: {
          condition: { type: 'TEXT_EQ', values: [{ userEnteredValue: match }] },
          format: { backgroundColor: colour },
        },
      },
    },
  };
}

/** Confirm credentials and access before a run depends on them. */
export async function testSheet(credentialsJson: string, sheetId: string): Promise<SyncResult> {
  try {
    const token = await accessToken(parseCredentials(credentialsJson));
    const meta = (await call(token, `${sheetId}?fields=properties.title`, { method: 'GET' })) as {
      properties?: { title?: string };
    };
    return { ok: true, rows: 0, error: `Connected to "${meta.properties?.title ?? sheetId}"` };
  } catch (err) {
    return { ok: false, rows: 0, error: (err as Error).message.slice(0, 300) };
  }
}


/** A spreadsheet the system made, and where to find it. */
export interface CreatedSheet {
  sheetId: string;
  url: string;
  sharedWith: string[];
  warning?: string;
}

/**
 * Create the Google Sheet, fill it, and make it openable.
 *
 * The alternative was a person opening sheets.new, pasting a formula into A1
 * and hand-colouring two conditional rules. That is fine for the operator and
 * wrong for a client deliverable — it puts a manual step between "the system
 * found 615 businesses" and "here is the link", and manual steps are where
 * client-facing things get forgotten or done differently each time.
 *
 * Ownership is the wrinkle worth knowing about: a service account creating a
 * file owns it, and service accounts have no Drive UI. So the file is shared
 * immediately — with named people as editors, and optionally with anyone who
 * has the link as a reader, because a sheet only its creator can open is worse
 * than no sheet at all.
 */
export async function createSheet(
  credentialsJson: string,
  options: { title: string; shareWith?: string[]; anyoneWithLink?: boolean },
): Promise<CreatedSheet> {
  const account = parseCredentials(credentialsJson);
  const token = await accessToken(account);

  const created = (await call(token, '', {
    method: 'POST',
    body: {
      properties: { title: options.title },
      sheets: [{ properties: { title: 'Deal Flow', gridProperties: { frozenRowCount: 1 } } }],
    },
  })) as { spreadsheetId?: string; spreadsheetUrl?: string };

  const sheetId = created.spreadsheetId;
  if (!sheetId) throw new Error('Google created no spreadsheet id.');

  const sharedWith: string[] = [];
  let warning: string | undefined;

  const share = async (body: Record<string, unknown>, label: string) => {
    const response = await fetch(
      `https://www.googleapis.com/drive/v3/files/${sheetId}/permissions?sendNotificationEmail=false`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      },
    );
    if (response.ok) {
      sharedWith.push(label);
      return;
    }
    // A sheet that exists but cannot be opened is the failure worth naming, so
    // this reports rather than throws — the document is already created and
    // losing the id here would strand it.
    const detail = await response.text().catch(() => '');
    warning =
      `Created, but sharing with ${label} failed (${response.status}). ` +
      `Enable the Drive API for this service account. ${detail.slice(0, 140)}`;
  };

  for (const email of options.shareWith ?? []) {
    if (email.trim()) await share({ type: 'user', role: 'writer', emailAddress: email.trim() }, email.trim());
  }
  if (options.anyoneWithLink) {
    await share({ type: 'anyone', role: 'reader' }, 'anyone with the link');
  }

  return {
    sheetId,
    url: created.spreadsheetUrl ?? `https://docs.google.com/spreadsheets/d/${sheetId}/edit`,
    sharedWith,
    warning,
  };
}

export { HEADERS as SHEET_HEADERS };

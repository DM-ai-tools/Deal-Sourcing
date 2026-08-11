/**
 * Why did creating a spreadsheet return 403?
 *
 * "The caller does not have permission" is Google's least useful error — it
 * covers an API that is switched off, a service account with no Drive storage,
 * and a key that is fine but scoped wrong. Guessing between them wastes an
 * afternoon, so ask each question separately.
 *
 *   1. Does the key mint a token at all?          (is the JSON valid)
 *   2. Is the Drive API on, and what storage does the account have?
 *   3. Is the Sheets API on?
 *   4. What exactly does create say, in full, untruncated?
 */
import { readFileSync } from 'node:fs';
import { createSign } from 'node:crypto';

const SCOPE = 'https://www.googleapis.com/auth/spreadsheets https://www.googleapis.com/auth/drive';

function base64url(input: Buffer | string): string {
  return Buffer.from(input).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function token(account: { client_email: string; private_key: string }): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = base64url(
    JSON.stringify({
      iss: account.client_email,
      scope: SCOPE,
      aud: 'https://oauth2.googleapis.com/token',
      exp: now + 3600,
      iat: now,
    }),
  );
  const signer = createSign('RSA-SHA256');
  signer.update(`${header}.${claims}`);
  const signature = base64url(signer.sign(account.private_key.replace(/\\n/g, '\n')));

  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: `${header}.${claims}.${signature}`,
    }),
  });
  const payload = (await response.json()) as { access_token?: string; error_description?: string };
  if (!payload.access_token) throw new Error(payload.error_description ?? 'no token');
  return payload.access_token;
}

async function show(label: string, url: string, accessToken: string, init?: RequestInit) {
  const response = await fetch(url, {
    ...init,
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
  });
  const body = await response.text();
  console.log(`\n  ${label}`);
  console.log(`    HTTP ${response.status}`);
  console.log(`    ${body.replace(/\s+/g, ' ').slice(0, 600)}`);
  return response.status;
}

async function main() {
  const account = JSON.parse(readFileSync(process.env.GOOGLE_KEY_FILE!, 'utf8'));
  console.log(`\n  service account: ${account.client_email}`);
  console.log(`  project        : ${account.project_id}`);

  const accessToken = await token(account);
  console.log('  token          : minted OK — the key itself is valid');

  await show('DRIVE about (is the Drive API on? what storage?)',
    'https://www.googleapis.com/drive/v3/about?fields=user,storageQuota', accessToken);

  await show('SHEETS create (the failing call, in full)',
    'https://sheets.googleapis.com/v4/spreadsheets', accessToken,
    { method: 'POST', body: JSON.stringify({ properties: { title: 'permission probe' } }) });

  console.log();
}

main().catch((err) => {
  console.error('probe failed:', err?.message ?? err);
  process.exit(1);
});

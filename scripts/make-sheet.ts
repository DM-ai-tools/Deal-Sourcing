/**
 * Create the client's Google Sheet now, without waiting for a deploy.
 *
 * The same createSheet() and syncToSheet() the dashboard button calls, driven
 * from here so the sheet exists today: a live armed run is mid-send and
 * deploying would kill it, but a client deliverable does not have to queue
 * behind that.
 *
 * Rows come from the deployed API rather than the database, because this
 * machine cannot reach production Postgres. Same data, same shape, same code
 * writing it — only the source of the objects differs.
 *
 *   GOOGLE_KEY_FILE=key.json SHARE_WITH=you@example.com npx tsx scripts/make-sheet.ts
 */
import { readFileSync } from 'node:fs';
import { createSheet, syncToSheet, type SheetRow } from '../src/lib/sheets.js';

const BASE = process.env.BASE_URL ?? 'https://deal-sourcing-production-a033.up.railway.app';

interface ApiListing {
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
  contactedAt: string | null;
  respondedAt: string | null;
  responseNote: string | null;
  status: string;
  firstSeenAt: string;
  outreach?: { status: string; sentAt: string | null }[];
}

async function main() {
  const keyFile = process.env.GOOGLE_KEY_FILE;
  if (!keyFile) throw new Error('Set GOOGLE_KEY_FILE to the service-account json path.');
  const credentials = readFileSync(keyFile, 'utf8');

  const shareWith = (process.env.SHARE_WITH ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  const title = process.env.SHEET_TITLE ?? 'BizBuySell Deal Flow';

  console.log('\n  reading the tracker…');
  const payload = (await fetch(`${BASE}/api/listings?limit=2000`).then((r) => r.json())) as {
    listings?: ApiListing[];
  };
  const listings = payload.listings ?? [];
  console.log(`  ${listings.length} listings`);

  const rows: SheetRow[] = listings.map((l) => {
    const sent = (l.outreach ?? []).find((o) => o.status === 'sent');
    return {
      title: l.title,
      url: l.url,
      location: l.location,
      datePosted: l.datePosted,
      askingPrice: l.askingPrice,
      grossRevenue: l.grossRevenue,
      cashFlow: l.cashFlow,
      ebitda: l.ebitda,
      brokerName: l.brokerName,
      brokerPhone: l.brokerPhone,
      messageSent: Boolean(sent),
      sentAt: sent?.sentAt ? new Date(sent.sentAt) : l.contactedAt ? new Date(l.contactedAt) : null,
      responded: Boolean(l.respondedAt),
      respondedAt: l.respondedAt ? new Date(l.respondedAt) : null,
      responseNote: l.responseNote,
      status: l.status,
      firstSeenAt: new Date(l.firstSeenAt),
    };
  });

  console.log('  creating the sheet…');
  const created = await createSheet(credentials, { title, shareWith, anyoneWithLink: true });
  console.log(`  id: ${created.sheetId}`);
  if (created.warning) console.log(`  WARNING: ${created.warning}`);

  console.log('  writing rows and colouring…');
  const sync = await syncToSheet(credentials, created.sheetId, rows);
  if (!sync.ok) throw new Error(`Created but could not fill: ${sync.error}`);

  console.log(`\n  SHEET READY — ${sync.rows} rows`);
  console.log(`  ${created.url}`);
  console.log(`  shared with: ${created.sharedWith.join(', ') || 'nobody'}\n`);
}

main().catch((err) => {
  console.error('failed:', err?.message ?? err);
  process.exit(1);
});

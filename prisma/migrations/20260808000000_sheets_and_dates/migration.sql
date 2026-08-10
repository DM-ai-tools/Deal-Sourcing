-- Listing dates, broker responses, and the Google Sheet mirror.
--
-- All additive and nullable, so the existing 46 listings keep working and no
-- backfill is needed. datePosted keeps BizBuySell's own wording ("2 days ago")
-- alongside a parsed date, because a relative phrase is still useful to read
-- even when it cannot sort.

ALTER TABLE "Listing" ADD COLUMN IF NOT EXISTS "datePosted" TEXT;
ALTER TABLE "Listing" ADD COLUMN IF NOT EXISTS "datePostedAt" TIMESTAMP(3);
ALTER TABLE "Listing" ADD COLUMN IF NOT EXISTS "respondedAt" TIMESTAMP(3);
ALTER TABLE "Listing" ADD COLUMN IF NOT EXISTS "responseNote" TEXT;

-- The sheet is a VIEW of the database, rewritten on every sync. Editing it does
-- not feed back, on purpose: two writable copies of one pipeline is how a status
-- silently reverts.
ALTER TABLE "Settings" ADD COLUMN IF NOT EXISTS "sheetsEnabled" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Settings" ADD COLUMN IF NOT EXISTS "sheetId" TEXT;
ALTER TABLE "Settings" ADD COLUMN IF NOT EXISTS "googleCredentials" TEXT;
ALTER TABLE "Settings" ADD COLUMN IF NOT EXISTS "sheetsLastSyncedAt" TIMESTAMP(3);
ALTER TABLE "Settings" ADD COLUMN IF NOT EXISTS "sheetsLastError" TEXT;

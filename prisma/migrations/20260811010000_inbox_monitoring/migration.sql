-- Inbox monitoring: a broker's reply reaches the tracker without anyone typing it.
--
-- Until now the only route from "a broker answered" to "the tracker knows" was a
-- person reading the inbox and clicking Log reply. That works in a demo and
-- fails in practice — the whole point of contacting seventy businesses is that
-- nobody is watching seventy conversations.
--
-- Read-only against the mailbox by design. The monitor opens folders read-only,
-- never deletes, never marks seen, and tracks position by UID, so its worst
-- failure is reading a message twice.

ALTER TABLE "Settings" ADD COLUMN IF NOT EXISTS "inboxEnabled" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Settings" ADD COLUMN IF NOT EXISTS "inboxHost" TEXT;
ALTER TABLE "Settings" ADD COLUMN IF NOT EXISTS "inboxPort" INTEGER NOT NULL DEFAULT 993;
ALTER TABLE "Settings" ADD COLUMN IF NOT EXISTS "inboxUser" TEXT;
ALTER TABLE "Settings" ADD COLUMN IF NOT EXISTS "inboxPassword" TEXT;
ALTER TABLE "Settings" ADD COLUMN IF NOT EXISTS "inboxLastUid" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "Settings" ADD COLUMN IF NOT EXISTS "inboxLastCheckedAt" TIMESTAMP(3);
ALTER TABLE "Settings" ADD COLUMN IF NOT EXISTS "inboxLastError" TEXT;

-- Every message read is stored, matched or not. An unmatched reply is the
-- interesting case: a broker answered and the system could not tell which
-- listing they meant. That has to be a row someone can act on, not a silence.
CREATE TABLE IF NOT EXISTS "Reply" (
  "id"          TEXT NOT NULL,
  "listingId"   TEXT,
  "messageId"   TEXT NOT NULL,
  "uid"         INTEGER,
  "fromEmail"   TEXT NOT NULL,
  "fromName"    TEXT,
  "subject"     TEXT,
  "snippet"     TEXT,
  "body"        TEXT,
  "matchedBy"   TEXT NOT NULL DEFAULT 'none',
  "isAutoReply" BOOLEAN NOT NULL DEFAULT false,
  "isBounce"    BOOLEAN NOT NULL DEFAULT false,
  "receivedAt"  TIMESTAMP(3) NOT NULL,
  "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "Reply_pkey" PRIMARY KEY ("id")
);

-- The idempotency guard: re-reading a message updates rather than duplicates.
CREATE UNIQUE INDEX IF NOT EXISTS "Reply_messageId_key" ON "Reply"("messageId");
CREATE INDEX IF NOT EXISTS "Reply_listingId_idx" ON "Reply"("listingId");
CREATE INDEX IF NOT EXISTS "Reply_receivedAt_idx" ON "Reply"("receivedAt");

-- SetNull, not Cascade: if a listing is ever removed, the reply is still
-- evidence that a human being wrote to us and deserves to survive it.
DO $$
BEGIN
  ALTER TABLE "Reply" ADD CONSTRAINT "Reply_listingId_fkey"
    FOREIGN KEY ("listingId") REFERENCES "Listing"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

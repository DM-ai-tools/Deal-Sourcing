-- Reading the mailbox through Microsoft Graph, because IMAP cannot work here.
--
-- hyperboards.com is on Exchange Online, and Microsoft disabled basic
-- authentication for IMAP across the service. A live probe with the correct
-- password returns "AUTHENTICATE failed / authenticationFailed: true" — the
-- server saying "not this way", not "wrong secret". No password will fix it.
--
-- Graph with client credentials suits a daemon: nobody is present to approve a
-- login, the app refreshes its own token, and the permission needed is the
-- APPLICATION permission Mail.Read — read-only, which is all this feature is
-- ever allowed to do.

ALTER TABLE "Settings" ADD COLUMN IF NOT EXISTS "inboxProvider" TEXT NOT NULL DEFAULT 'graph';
ALTER TABLE "Settings" ADD COLUMN IF NOT EXISTS "graphTenantId" TEXT;
ALTER TABLE "Settings" ADD COLUMN IF NOT EXISTS "graphClientId" TEXT;
ALTER TABLE "Settings" ADD COLUMN IF NOT EXISTS "graphClientSecret" TEXT;

-- Graph has no UID, so the position marker is a timestamp. It advances per
-- message rather than per poll, so a poll that dies halfway resumes from the
-- last message actually handled instead of skipping to the newest.
ALTER TABLE "Settings" ADD COLUMN IF NOT EXISTS "inboxWatermark" TIMESTAMP(3);

-- Only ingest mail that was actually addressed to us.
--
-- The monitored mailbox is not necessarily dedicated to this system. The one in
-- use, tools1.dotmappers@gmail.com, holds 1,559 messages of ordinary business
-- correspondence — clients, invoices, newsletters — and broker replies arrive
-- there only because deals@hyperboards.com forwards them.
--
-- Without a filter, all of that would be read, stored in the deal database with
-- sender, subject and body, and displayed on a Replies screen. That is somebody
-- else's mail sitting in a deal tracker, and it is a privacy problem before it
-- is a noise problem.
--
-- A forwarded reply is still addressed to the buyer's address, so that is the
-- discriminator. Left null, everything is read — the right default for a mailbox
-- that really is dedicated to this.

ALTER TABLE "Settings" ADD COLUMN IF NOT EXISTS "inboxFilterTo" TEXT;

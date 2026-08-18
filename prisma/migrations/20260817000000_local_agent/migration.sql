-- Sending from a machine outside this server.
--
-- BizBuySell refuses this host's IP outright — search pages and listing pages
-- both — while the operator's own connection reaches the site normally: 50
-- listings in 24 seconds, measured the same hour the server got a bot wall.
--
-- So the server keeps what it is good at (discovery, the queue, the tracker,
-- the sheet) and hands sending to a local agent over the API. agentEnabled
-- stops the server dialling out at all when set, because two senders working
-- one queue is the failure this system cannot tolerate.
--
-- agentToken exists because those endpoints hand out real listings and record
-- real sends, and this dashboard has no login of its own.

ALTER TABLE "Settings" ADD COLUMN IF NOT EXISTS "agentEnabled" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Settings" ADD COLUMN IF NOT EXISTS "agentToken" TEXT;
ALTER TABLE "Settings" ADD COLUMN IF NOT EXISTS "agentLastSeenAt" TIMESTAMP(3);

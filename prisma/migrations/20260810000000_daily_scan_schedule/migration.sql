-- One scan per day, unattended.
--
-- Additive and defaulted, so the existing Settings row picks these up without a
-- backfill. `dailyScanEnabled` defaults to true deliberately: the point of the
-- system is to notice a listing the day it appears, and a scheduler that ships
-- switched off is a scheduler nobody turns on.
--
-- 14:00 UTC is mid-morning across the US business day, so an enquiry reaches a
-- broker at their desk rather than at three in the morning. Sending is still
-- gated separately by sendingEnabled — this controls WHEN the system looks, not
-- whether it is allowed to write to anyone.

ALTER TABLE "Settings" ADD COLUMN IF NOT EXISTS "dailyScanEnabled" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "Settings" ADD COLUMN IF NOT EXISTS "scanHourUtc" INTEGER NOT NULL DEFAULT 14;
ALTER TABLE "Settings" ADD COLUMN IF NOT EXISTS "lastScheduledAt" TIMESTAMP(3);

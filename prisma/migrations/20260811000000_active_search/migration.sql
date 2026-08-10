-- Which saved search is actually live.
--
-- The scheduler and the arming switch were picking a search by timestamp, and
-- both guesses were wrong in turn: "oldest" ran a buy-box the operator had
-- replaced, and "most recently updated" ran a fifty-state duplicate that turned
-- twelve search URLs into six hundred, crawled for three hours, and contacted
-- nobody. Which buy-box is live is a decision someone makes, not something to
-- infer from a column.
--
-- Nullable, and the code falls back to the most recently updated search when it
-- is unset, so nothing breaks before anyone chooses.

ALTER TABLE "Settings" ADD COLUMN IF NOT EXISTS "activeSearchId" TEXT;

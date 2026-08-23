-- Keep Akamai's cookies across restarts.
--
-- The Chrome profile lives in the container temp dir, which Railway wipes on
-- every deploy, crash and scale event. The browser therefore launched with an
-- empty cookie jar several times a day, and Akamai met a client that had never
-- visited, carried no _abck, and immediately requested a filtered search page.
-- That is exactly the profile of a scraper, and it is the one we presented on
-- every cold start.
--
-- Stored in Postgres rather than on a mounted Volume: a Volume is a dashboard
-- setting somebody has to remember to reattach, and this has to keep working
-- with nobody maintaining it.
ALTER TABLE "Settings" ADD COLUMN IF NOT EXISTS "browserCookies" JSONB;
ALTER TABLE "Settings" ADD COLUMN IF NOT EXISTS "browserCookiesAt" TIMESTAMP(3);

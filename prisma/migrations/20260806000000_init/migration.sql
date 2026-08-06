-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateTable
CREATE TABLE "Search" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "states" JSONB NOT NULL DEFAULT '[]',
    "industries" JSONB NOT NULL DEFAULT '[]',
    "cashFlowMin" INTEGER,
    "cashFlowMax" INTEGER,
    "revenueMin" INTEGER,
    "revenueMax" INTEGER,
    "askingPriceMin" INTEGER,
    "askingPriceMax" INTEGER,
    "excludeAuctions" BOOLEAN NOT NULL DEFAULT true,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Search_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Run" (
    "id" TEXT NOT NULL,
    "searchId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "dryRun" BOOLEAN NOT NULL DEFAULT true,
    "transport" TEXT NOT NULL DEFAULT 'firecrawl',
    "pagesRead" INTEGER NOT NULL DEFAULT 0,
    "listingsFound" INTEGER NOT NULL DEFAULT 0,
    "listingsNew" INTEGER NOT NULL DEFAULT 0,
    "messagesSent" INTEGER NOT NULL DEFAULT 0,
    "messagesFailed" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "Run_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RunEvent" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "level" TEXT NOT NULL DEFAULT 'info',
    "message" TEXT NOT NULL,
    "detail" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RunEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Listing" (
    "id" TEXT NOT NULL,
    "listingId" TEXT NOT NULL,
    "searchId" TEXT,
    "title" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "location" TEXT,
    "askingPrice" INTEGER,
    "grossRevenue" INTEGER,
    "cashFlow" INTEGER,
    "ebitda" INTEGER,
    "established" TEXT,
    "brokerName" TEXT,
    "brokerPhone" TEXT,
    "isAuction" BOOLEAN NOT NULL DEFAULT false,
    "status" TEXT NOT NULL DEFAULT 'new',
    "notes" TEXT,
    "raw" JSONB,
    "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "contactedAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Listing_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Outreach" (
    "id" TEXT NOT NULL,
    "listingId" TEXT NOT NULL,
    "runId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'prepared',
    "messageBody" TEXT NOT NULL,
    "fullName" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "phone" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT,
    "screenshot" TEXT,
    "confirmation" TEXT,
    "preparedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sentAt" TIMESTAMP(3),

    CONSTRAINT "Outreach_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Settings" (
    "id" INTEGER NOT NULL DEFAULT 1,
    "fullName" TEXT NOT NULL DEFAULT '',
    "email" TEXT NOT NULL DEFAULT '',
    "phone" TEXT NOT NULL DEFAULT '',
    "messageTemplate" TEXT NOT NULL DEFAULT '',
    "sendingEnabled" BOOLEAN NOT NULL DEFAULT false,
    "dailyCap" INTEGER NOT NULL DEFAULT 40,
    "minDelaySeconds" INTEGER NOT NULL DEFAULT 45,
    "maxDelaySeconds" INTEGER NOT NULL DEFAULT 120,
    "transport" TEXT NOT NULL DEFAULT 'firecrawl',
    "bizbuysellEmail" TEXT,
    "bizbuysellPassword" TEXT,
    "proxyServer" TEXT,
    "proxyUsername" TEXT,
    "proxyPassword" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Settings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Run_status_idx" ON "Run"("status");

-- CreateIndex
CREATE INDEX "Run_startedAt_idx" ON "Run"("startedAt");

-- CreateIndex
CREATE INDEX "RunEvent_runId_createdAt_idx" ON "RunEvent"("runId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "Listing_listingId_key" ON "Listing"("listingId");

-- CreateIndex
CREATE INDEX "Listing_status_idx" ON "Listing"("status");

-- CreateIndex
CREATE INDEX "Listing_searchId_idx" ON "Listing"("searchId");

-- CreateIndex
CREATE UNIQUE INDEX "Outreach_listingId_key" ON "Outreach"("listingId");

-- CreateIndex
CREATE INDEX "Outreach_status_idx" ON "Outreach"("status");

-- AddForeignKey
ALTER TABLE "Run" ADD CONSTRAINT "Run_searchId_fkey" FOREIGN KEY ("searchId") REFERENCES "Search"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RunEvent" ADD CONSTRAINT "RunEvent_runId_fkey" FOREIGN KEY ("runId") REFERENCES "Run"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Listing" ADD CONSTRAINT "Listing_searchId_fkey" FOREIGN KEY ("searchId") REFERENCES "Search"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Outreach" ADD CONSTRAINT "Outreach_listingId_fkey" FOREIGN KEY ("listingId") REFERENCES "Listing"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Outreach" ADD CONSTRAINT "Outreach_runId_fkey" FOREIGN KEY ("runId") REFERENCES "Run"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- Preferences are independent from consent; existing consent is still required.
ALTER TABLE "Subject" ADD COLUMN "statisticsEnabled" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN "statisticsRevision" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "ServerRecord" ADD COLUMN "statisticsEnabled" BOOLEAN NOT NULL DEFAULT true;
-- Preserve history, but the production lobby does not collect or contribute to totals.
UPDATE "ServerRecord" SET "statisticsEnabled" = false WHERE "id" = 'ssu_lobby';

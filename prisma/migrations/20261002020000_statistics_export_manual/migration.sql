BEGIN;
SELECT pg_advisory_xact_lock(1346458451,1347374153);
-- Preserve cumulative history and mark unknown legacy timestamps as NULL.
ALTER TABLE "ActivityTotal" ADD COLUMN "firstCollectedAt" TIMESTAMP(3), ADD COLUMN "lastCollectedAt" TIMESTAMP(3);
CREATE TABLE "ActivityDaily" (
 "epoch" UUID NOT NULL, "serverId" TEXT NOT NULL, "date" DATE NOT NULL,
 "playSeconds" BIGINT NOT NULL DEFAULT 0, "blocksBroken" BIGINT NOT NULL DEFAULT 0,
 "blocksPlaced" BIGINT NOT NULL DEFAULT 0, "damageTakenMilli" BIGINT NOT NULL DEFAULT 0,
 "deaths" BIGINT NOT NULL DEFAULT 0, "mobKills" BIGINT NOT NULL DEFAULT 0,
 "playerKills" BIGINT NOT NULL DEFAULT 0, "distanceCm" BIGINT NOT NULL DEFAULT 0,
 "firstCollectedAt" TIMESTAMP(3) NOT NULL, "lastCollectedAt" TIMESTAMP(3) NOT NULL,
 CONSTRAINT "ActivityDaily_pkey" PRIMARY KEY ("epoch","serverId","date"),
 CONSTRAINT "ActivityDaily_epoch_fkey" FOREIGN KEY ("epoch") REFERENCES "ActivityGeneration"("epoch") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "ActivityDaily_date_serverId_idx" ON "ActivityDaily"("date","serverId");
CREATE TABLE "StatisticsHistory" ("id" TEXT NOT NULL DEFAULT 'main', "availableFrom" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, CONSTRAINT "StatisticsHistory_pkey" PRIMARY KEY ("id"));
INSERT INTO "StatisticsHistory" ("id") VALUES ('main');
CREATE TABLE "ManualSettings" ("id" TEXT NOT NULL DEFAULT 'main', "notionUrl" TEXT, "embedUrl" TEXT, "title" TEXT NOT NULL DEFAULT '매뉴얼', "revision" INTEGER NOT NULL DEFAULT 1, "updatedAt" TIMESTAMP(3) NOT NULL, CONSTRAINT "ManualSettings_pkey" PRIMARY KEY ("id"));
-- Collection is now exclusively an administrator server setting. Personal
-- preferences are retired; consent remains an independent mandatory gate.
WITH changed AS (
 UPDATE "MinecraftIdentity" AS m SET "telemetryEpoch"=gen_random_uuid(), "policyVersion"=m."policyVersion"+1, "policyFingerprint"='', "updatedAt"=CURRENT_TIMESTAMP
 FROM "Subject" AS s WHERE m."subjectId"=s."id" AND NOT s."statisticsEnabled"
 RETURNING m."uuid",m."policyVersion"
) INSERT INTO "PolicyEvent" ("minecraftUuid","policyVersion") SELECT "uuid","policyVersion" FROM changed;
UPDATE "Subject" SET "statisticsEnabled"=true, "statisticsRevision"="statisticsRevision"+1 WHERE NOT "statisticsEnabled";

CREATE TABLE "ServiceCredential" ("id" UUID NOT NULL, "serviceId" TEXT NOT NULL, "audience" TEXT NOT NULL, "tokenHash" TEXT NOT NULL, "scopes" TEXT[] NOT NULL, "serverIds" TEXT[] NOT NULL, "expiresAt" TIMESTAMP(3) NOT NULL, "revokedAt" TIMESTAMP(3), "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, CONSTRAINT "ServiceCredential_pkey" PRIMARY KEY ("id"));
CREATE UNIQUE INDEX "ServiceCredential_tokenHash_key" ON "ServiceCredential"("tokenHash");
CREATE INDEX "ServiceCredential_serviceId_createdAt_idx" ON "ServiceCredential"("serviceId","createdAt");

COMMIT;

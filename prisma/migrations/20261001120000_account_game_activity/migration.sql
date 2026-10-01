ALTER TABLE "Subject" ADD COLUMN "admissionYear" VARCHAR(2);
ALTER TABLE "MinecraftIdentity" ADD COLUMN "telemetryEpoch" UUID NOT NULL DEFAULT gen_random_uuid();
ALTER TABLE "DiscordIdentity" ADD COLUMN "eraseWhenRevoked" BOOLEAN NOT NULL DEFAULT false;
CREATE TABLE "PlayerPresence" (
 "minecraftUuid" UUID NOT NULL PRIMARY KEY,
 "serverId" TEXT NOT NULL,
 "observedAt" TIMESTAMP(3) NOT NULL,
 "expiresAt" TIMESTAMP(3) NOT NULL
);
CREATE INDEX "PlayerPresence_expiresAt_idx" ON "PlayerPresence"("expiresAt");
CREATE TABLE "ActivityGeneration" (
 "epoch" UUID NOT NULL PRIMARY KEY,
 "subjectId" UUID NOT NULL REFERENCES "Subject"("id") ON DELETE CASCADE ON UPDATE CASCADE,
 "minecraftUuid" UUID NOT NULL,
 "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "ActivityGeneration_subjectId_idx" ON "ActivityGeneration"("subjectId");
CREATE TABLE "ActivityTotal" (
 "epoch" UUID NOT NULL REFERENCES "ActivityGeneration"("epoch") ON DELETE CASCADE ON UPDATE CASCADE,
 "serverId" TEXT NOT NULL,
 "playSeconds" BIGINT NOT NULL DEFAULT 0,
 "blocksBroken" BIGINT NOT NULL DEFAULT 0,
 "blocksPlaced" BIGINT NOT NULL DEFAULT 0,
 "damageTakenMilli" BIGINT NOT NULL DEFAULT 0,
 "deaths" BIGINT NOT NULL DEFAULT 0,
 "mobKills" BIGINT NOT NULL DEFAULT 0,
 PRIMARY KEY("epoch","serverId")
);
CREATE TABLE "ActivityBatch" (
 "id" UUID NOT NULL PRIMARY KEY,
 "digest" TEXT NOT NULL,
 "received" INTEGER NOT NULL,
 "ignored" INTEGER NOT NULL,
 "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
ALTER TABLE "ConsentReceipt" DROP CONSTRAINT "ConsentReceipt_source_check";
ALTER TABLE "ConsentReceipt" ADD CONSTRAINT "ConsentReceipt_source_check" CHECK ("source" IN ('portal_login','minecraft_link','discord_link','privacy_renewal'));
ALTER TABLE "Subject" ADD CONSTRAINT "Subject_admissionYear_check" CHECK ("admissionYear" IS NULL OR "admissionYear" ~ '^[0-9]{2}$');
ALTER TABLE "ActivityTotal" ADD CONSTRAINT "ActivityTotal_nonnegative_check" CHECK ("playSeconds">=0 AND "blocksBroken">=0 AND "blocksPlaced">=0 AND "damageTakenMilli">=0 AND "deaths">=0 AND "mobKills">=0);
ALTER TABLE "ActivityBatch" ADD CONSTRAINT "ActivityBatch_counts_check" CHECK ("received">=0 AND "ignored">=0 AND "received"+"ignored">0);

ALTER TABLE "ActivityTotal" ADD COLUMN "playerKills" BIGINT NOT NULL DEFAULT 0, ADD COLUMN "distanceCm" BIGINT NOT NULL DEFAULT 0;
ALTER TABLE "ActivityTotal" ADD CONSTRAINT "ActivityTotal_playerKills_check" CHECK ("playerKills" >= 0), ADD CONSTRAINT "ActivityTotal_distanceCm_check" CHECK ("distanceCm" >= 0);

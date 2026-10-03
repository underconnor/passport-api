BEGIN;

-- Acquire the policy writer lock before reading rows or allocating event IDs.
SELECT pg_advisory_xact_lock(1346458451, 1347374153);

ALTER TABLE "ServerRecord" DROP CONSTRAINT "ServerRecord_accessMode_check";

-- Admission only expands. Preserve telemetry epochs and collected history so
-- valid batches queued before this change remain accepted after deployment.
WITH converted AS (
  UPDATE "ServerRecord"
  SET "accessMode" = 'members',
      "updatedAt" = GREATEST(CURRENT_TIMESTAMP, "updatedAt" + INTERVAL '1 millisecond')
  WHERE "accessMode" = 'roster'
  RETURNING "id"
), invalidated AS (
  UPDATE "MinecraftIdentity"
  SET "policyVersion" = "policyVersion" + 1,
      "policyFingerprint" = '',
      "updatedAt" = CURRENT_TIMESTAMP
  WHERE "subjectId" IS NOT NULL AND EXISTS (SELECT 1 FROM converted)
  RETURNING "uuid", "policyVersion"
)
INSERT INTO "PolicyEvent" ("minecraftUuid", "policyVersion")
SELECT "uuid", "policyVersion" FROM invalidated ORDER BY "uuid";

ALTER TABLE "ServerRecord" ALTER COLUMN "accessMode" SET DEFAULT 'members';
ALTER TABLE "ServerRecord" ADD CONSTRAINT "ServerRecord_accessMode_check"
  CHECK ("accessMode" IN ('members', 'selected', 'university'));

-- Older API images explicitly INSERT/UPDATE roster. Normalize only that legacy
-- value at the database boundary; the new public request schema rejects it.
CREATE FUNCTION "passport_server_access_mode_compatibility"() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."accessMode" = 'roster' THEN
    NEW."accessMode" := 'members';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "ServerRecord_accessMode_compatibility"
  BEFORE INSERT OR UPDATE OF "accessMode" ON "ServerRecord"
  FOR EACH ROW EXECUTE FUNCTION "passport_server_access_mode_compatibility"();

COMMIT;

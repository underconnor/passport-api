BEGIN;

-- Preserve immutable IDs and every existing permission/statistics reference.
-- Only the new administrator-editable command field is backfilled.
ALTER TABLE "ServerRecord" ADD COLUMN "commandName" TEXT;
UPDATE "ServerRecord" SET "commandName" = "id";
ALTER TABLE "ServerRecord" ALTER COLUMN "commandName" SET NOT NULL;
CREATE UNIQUE INDEX "ServerRecord_commandName_key" ON "ServerRecord"("commandName");
ALTER TABLE "ServerRecord" ADD CONSTRAINT "ServerRecord_commandName_check"
  CHECK (char_length("commandName") BETWEEN 1 AND 64 AND "commandName" !~ '[^a-z0-9가-힣_-]');

-- Older API images do not know this column. Keep their INSERT/seed path valid
-- during rolling deployment and rollback; never repair explicit UPDATEs.
CREATE FUNCTION "passport_server_command_name_default"() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."commandName" IS NULL THEN
    NEW."commandName" := NEW."id";
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "ServerRecord_commandName_default"
  BEFORE INSERT ON "ServerRecord"
  FOR EACH ROW EXECUTE FUNCTION "passport_server_command_name_default"();

COMMIT;

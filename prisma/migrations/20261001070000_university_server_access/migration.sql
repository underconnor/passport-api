BEGIN;

ALTER TABLE "ServerRecord" DROP CONSTRAINT "ServerRecord_accessMode_check";
ALTER TABLE "ServerRecord" ADD CONSTRAINT "ServerRecord_accessMode_check"
  CHECK ("accessMode" IN ('roster', 'members', 'selected', 'university'));

COMMIT;

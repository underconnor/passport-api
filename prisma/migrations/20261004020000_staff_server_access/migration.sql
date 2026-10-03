BEGIN;
SELECT pg_advisory_xact_lock(1346458451, 1347374153);
ALTER TABLE "ServerRecord" DROP CONSTRAINT "ServerRecord_accessMode_check";
ALTER TABLE "ServerRecord" ADD CONSTRAINT "ServerRecord_accessMode_check"
  CHECK ("accessMode" IN ('members', 'selected', 'university', 'staff'));
COMMIT;

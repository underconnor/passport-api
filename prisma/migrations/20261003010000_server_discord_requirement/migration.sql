-- Existing servers and older API inserts retain unrestricted Discord access.
ALTER TABLE "ServerRecord" ADD COLUMN "discordRequirement" TEXT NOT NULL DEFAULT 'any';
ALTER TABLE "ServerRecord" ADD CONSTRAINT "ServerRecord_discordRequirement_check"
  CHECK ("discordRequirement" IN ('any', 'linked', 'unlinked'));

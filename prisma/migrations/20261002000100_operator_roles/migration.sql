ALTER TABLE "Administrator" ADD COLUMN "role" TEXT NOT NULL DEFAULT 'viewer', ADD COLUMN "revokedAt" TIMESTAMP(3);
-- Preserve the authority of existing bootstrap administrators; new records default to read-only.
UPDATE "Administrator" SET "role" = 'owner';
ALTER TABLE "Administrator" ADD CONSTRAINT "Administrator_role_check" CHECK ("role" IN ('owner', 'operator', 'viewer'));
CREATE TABLE "OperatorInvitation" (
  "id" UUID NOT NULL,
  "subjectId" UUID NOT NULL,
  "issuerSubjectId" UUID NOT NULL,
  "role" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'pending',
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "acceptedAt" TIMESTAMP(3),
  "revokedAt" TIMESTAMP(3),
  CONSTRAINT "OperatorInvitation_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "OperatorInvitation_subjectId_fkey" FOREIGN KEY ("subjectId") REFERENCES "Subject"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "OperatorInvitation_issuerSubjectId_fkey" FOREIGN KEY ("issuerSubjectId") REFERENCES "Subject"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "OperatorInvitation_role_check" CHECK ("role" IN ('owner', 'operator', 'viewer')),
  CONSTRAINT "OperatorInvitation_status_check" CHECK ("status" IN ('pending', 'accepted', 'revoked')),
  CONSTRAINT "OperatorInvitation_distinct_people_check" CHECK ("subjectId" <> "issuerSubjectId")
);
CREATE INDEX "OperatorInvitation_subjectId_status_idx" ON "OperatorInvitation"("subjectId", "status");
CREATE INDEX "OperatorInvitation_issuerSubjectId_status_idx" ON "OperatorInvitation"("issuerSubjectId", "status");
CREATE UNIQUE INDEX "OperatorInvitation_one_pending_target" ON "OperatorInvitation"("subjectId") WHERE "status" = 'pending';

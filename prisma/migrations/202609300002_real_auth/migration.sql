-- AlterTable
ALTER TABLE "Subject" ADD COLUMN     "academicStatus" TEXT NOT NULL DEFAULT 'UNKNOWN',
ADD COLUMN     "accessSuspended" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "department" TEXT NOT NULL DEFAULT '',
ADD COLUMN     "scopeLimit" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "scopeRestricted" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "universityVerifiedAt" TIMESTAMP(3),
ADD COLUMN     "universityVerifiedUntil" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "WebSession" ADD COLUMN     "mfaVerifiedUntil" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "AuditEvent" ADD COLUMN     "actorSubjectId" UUID,
ADD COLUMN     "details" JSONB;

-- CreateTable
CREATE TABLE "UniversityAuthRequest" (
    "id" UUID NOT NULL,
    "stateHash" TEXT NOT NULL,
    "webSessionId" UUID NOT NULL,
    "returnContext" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "UniversityAuthRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ConsumedUniversityToken" (
    "tokenHash" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ConsumedUniversityToken_pkey" PRIMARY KEY ("tokenHash")
);

-- CreateTable
CREATE TABLE "Administrator" (
    "subjectId" UUID NOT NULL,
    "totpSecret" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "lastTotpStep" BIGINT NOT NULL DEFAULT -1,
    "failedAttempts" INTEGER NOT NULL DEFAULT 0,
    "lockedUntil" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Administrator_pkey" PRIMARY KEY ("subjectId")
);

-- CreateTable
CREATE TABLE "RosterSnapshot" (
    "id" TEXT NOT NULL,
    "sourceKey" TEXT NOT NULL,
    "digest" TEXT NOT NULL,
    "fetchedAt" TIMESTAMP(3) NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "entryCount" INTEGER NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RosterSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RosterMembership" (
    "studentKey" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "roleLabel" TEXT NOT NULL,
    "serverIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "snapshotId" TEXT NOT NULL,

    CONSTRAINT "RosterMembership_pkey" PRIMARY KEY ("studentKey")
);

-- CreateIndex
CREATE UNIQUE INDEX "UniversityAuthRequest_stateHash_key" ON "UniversityAuthRequest"("stateHash");

-- CreateIndex
CREATE INDEX "UniversityAuthRequest_expiresAt_idx" ON "UniversityAuthRequest"("expiresAt");

-- CreateIndex
CREATE INDEX "ConsumedUniversityToken_expiresAt_idx" ON "ConsumedUniversityToken"("expiresAt");

-- AddForeignKey
ALTER TABLE "UniversityAuthRequest" ADD CONSTRAINT "UniversityAuthRequest_webSessionId_fkey" FOREIGN KEY ("webSessionId") REFERENCES "WebSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Administrator" ADD CONSTRAINT "Administrator_subjectId_fkey" FOREIGN KEY ("subjectId") REFERENCES "Subject"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RosterMembership" ADD CONSTRAINT "RosterMembership_snapshotId_fkey" FOREIGN KEY ("snapshotId") REFERENCES "RosterSnapshot"("id") ON DELETE CASCADE ON UPDATE CASCADE;


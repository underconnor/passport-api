-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateTable
CREATE TABLE "Subject" (
    "id" UUID NOT NULL,
    "universityKey" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "identityProvider" TEXT NOT NULL,
    "membershipStatus" TEXT NOT NULL DEFAULT 'inactive',
    "roleLabel" TEXT NOT NULL DEFAULT '',
    "verifiedUntil" TIMESTAMP(3) NOT NULL,
    "allowedServerIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "discordId" TEXT,
    "discordUpdatedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Subject_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WebSession" (
    "id" UUID NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "subjectId" UUID,
    "audienceHost" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WebSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MinecraftIdentity" (
    "uuid" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "subjectId" UUID,
    "policyVersion" INTEGER NOT NULL DEFAULT 1,
    "policyFingerprint" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MinecraftIdentity_pkey" PRIMARY KEY ("uuid")
);

-- CreateTable
CREATE TABLE "LinkSession" (
    "id" UUID NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "minecraftUuid" UUID NOT NULL,
    "minecraftName" TEXT NOT NULL,
    "gameSessionHash" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "subjectId" UUID,
    "webSessionId" UUID,
    "webConfirmedAt" TIMESTAMP(3),
    "gameConfirmedAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "LinkSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PolicyEvent" (
    "id" BIGSERIAL NOT NULL,
    "minecraftUuid" UUID NOT NULL,
    "policyVersion" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PolicyEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditEvent" (
    "id" UUID NOT NULL,
    "action" TEXT NOT NULL,
    "subjectId" UUID,
    "objectId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Subject_universityKey_key" ON "Subject"("universityKey");

-- CreateIndex
CREATE UNIQUE INDEX "WebSession_tokenHash_key" ON "WebSession"("tokenHash");

-- CreateIndex
CREATE INDEX "WebSession_expiresAt_idx" ON "WebSession"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "MinecraftIdentity_subjectId_key" ON "MinecraftIdentity"("subjectId");

-- CreateIndex
CREATE UNIQUE INDEX "LinkSession_tokenHash_key" ON "LinkSession"("tokenHash");

-- CreateIndex
CREATE INDEX "LinkSession_minecraftUuid_status_idx" ON "LinkSession"("minecraftUuid", "status");

-- CreateIndex
CREATE INDEX "LinkSession_expiresAt_idx" ON "LinkSession"("expiresAt");

-- AddForeignKey
ALTER TABLE "WebSession" ADD CONSTRAINT "WebSession_subjectId_fkey" FOREIGN KEY ("subjectId") REFERENCES "Subject"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MinecraftIdentity" ADD CONSTRAINT "MinecraftIdentity_subjectId_fkey" FOREIGN KEY ("subjectId") REFERENCES "Subject"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LinkSession" ADD CONSTRAINT "LinkSession_subjectId_fkey" FOREIGN KEY ("subjectId") REFERENCES "Subject"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LinkSession" ADD CONSTRAINT "LinkSession_webSessionId_fkey" FOREIGN KEY ("webSessionId") REFERENCES "WebSession"("id") ON DELETE SET NULL ON UPDATE CASCADE;


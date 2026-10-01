CREATE TABLE "DiscordIdentity" (
  "discordUserId" TEXT NOT NULL PRIMARY KEY, "guildId" TEXT NOT NULL,
  "username" TEXT NOT NULL, "displayName" TEXT NOT NULL, "subjectId" UUID,
  "verifiedAt" TIMESTAMP(3) NOT NULL, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "DiscordIdentity_subjectId_fkey" FOREIGN KEY ("subjectId") REFERENCES "Subject"("id") ON DELETE SET NULL ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "DiscordIdentity_subjectId_key" ON "DiscordIdentity"("subjectId");
CREATE TABLE "DiscordLinkSession" (
  "id" UUID NOT NULL PRIMARY KEY, "tokenHash" TEXT NOT NULL, "interactionHash" TEXT NOT NULL,
  "discordUserId" TEXT NOT NULL, "guildId" TEXT NOT NULL, "username" TEXT NOT NULL, "displayName" TEXT NOT NULL,
  "subjectId" UUID, "status" TEXT NOT NULL DEFAULT 'pending', "expiresAt" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "completedAt" TIMESTAMP(3),
  CONSTRAINT "DiscordLinkSession_subjectId_fkey" FOREIGN KEY ("subjectId") REFERENCES "Subject"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT "DiscordLinkSession_status_check" CHECK ("status" IN ('pending','linked','cancelled'))
);
CREATE UNIQUE INDEX "DiscordLinkSession_tokenHash_key" ON "DiscordLinkSession"("tokenHash");
CREATE UNIQUE INDEX "DiscordLinkSession_interactionHash_key" ON "DiscordLinkSession"("interactionHash");
CREATE INDEX "DiscordLinkSession_discordUserId_guildId_status_idx" ON "DiscordLinkSession"("discordUserId","guildId","status");
CREATE INDEX "DiscordLinkSession_expiresAt_idx" ON "DiscordLinkSession"("expiresAt");
CREATE TABLE "DiscordRoleState" (
  "id" UUID NOT NULL PRIMARY KEY, "discordUserId" TEXT NOT NULL, "guildId" TEXT NOT NULL, "roleId" TEXT NOT NULL,
  "desired" BOOLEAN NOT NULL, "version" BIGINT NOT NULL DEFAULT 1, "validUntil" TIMESTAMP(3),
  "appliedDesired" BOOLEAN, "appliedVersion" BIGINT, "appliedAt" TIMESTAMP(3), "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "attempts" INTEGER NOT NULL DEFAULT 0, "lastError" TEXT, "leaseHash" TEXT, "leaseUntil" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "DiscordRoleState_discordUserId_fkey" FOREIGN KEY ("discordUserId") REFERENCES "DiscordIdentity"("discordUserId") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "DiscordRoleState_lastError_check" CHECK ("lastError" IS NULL OR "lastError" IN ('retry','member_absent','configuration_error'))
);
CREATE UNIQUE INDEX "DiscordRoleState_discordUserId_guildId_roleId_key" ON "DiscordRoleState"("discordUserId","guildId","roleId");
CREATE INDEX "DiscordRoleState_nextAttemptAt_leaseUntil_idx" ON "DiscordRoleState"("nextAttemptAt","leaseUntil");
CREATE INDEX "DiscordRoleState_desired_validUntil_idx" ON "DiscordRoleState"("desired","validUntil");
ALTER TABLE "ConsentReceipt" DROP CONSTRAINT "ConsentReceipt_source_check";
ALTER TABLE "ConsentReceipt" ADD CONSTRAINT "ConsentReceipt_source_check" CHECK ("source" IN ('portal_login','minecraft_link','discord_link'));

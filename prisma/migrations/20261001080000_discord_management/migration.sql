BEGIN;
ALTER TABLE "DiscordRoleState" ADD COLUMN "kind" TEXT NOT NULL DEFAULT 'verification', ADD COLUMN "semester" TEXT;
ALTER TABLE "DiscordRoleState" ADD CONSTRAINT "DiscordRoleState_kind_check" CHECK (
  ("kind" IN ('verification','member') AND "semester" IS NULL) OR ("kind"='semester' AND "semester" ~ '^[0-9]{2}-[12]$'));
CREATE TABLE "DiscordGuildSettings" (
 "guildId" TEXT PRIMARY KEY, "verificationRoleId" TEXT NOT NULL, "memberRoleId" TEXT, "currentSemester" TEXT,
 "nicknameEnabled" BOOLEAN NOT NULL DEFAULT false, "revision" BIGINT NOT NULL DEFAULT 1,
 "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL,
 CONSTRAINT "DiscordGuildSettings_semester_check" CHECK ("currentSemester" IS NULL OR "currentSemester" ~ '^[0-9]{2}-[12]$'),
 CONSTRAINT "DiscordGuildSettings_revision_check" CHECK ("revision">0)
);
CREATE TABLE "DiscordSemesterRole" (
 "guildId" TEXT NOT NULL, "semester" TEXT NOT NULL, "roleId" TEXT NOT NULL,
 PRIMARY KEY ("guildId","semester"),
 CONSTRAINT "DiscordSemesterRole_guildId_fkey" FOREIGN KEY ("guildId") REFERENCES "DiscordGuildSettings"("guildId") ON DELETE CASCADE ON UPDATE CASCADE,
 CONSTRAINT "DiscordSemesterRole_semester_check" CHECK ("semester" ~ '^[0-9]{2}-[12]$')
);
CREATE UNIQUE INDEX "DiscordSemesterRole_guildId_roleId_key" ON "DiscordSemesterRole"("guildId","roleId");
CREATE TABLE "MembershipSemester" (
 "subjectId" UUID NOT NULL, "guildId" TEXT NOT NULL, "semester" TEXT NOT NULL, "recordedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 PRIMARY KEY ("subjectId","guildId","semester"),
 CONSTRAINT "MembershipSemester_subjectId_fkey" FOREIGN KEY ("subjectId") REFERENCES "Subject"("id") ON DELETE CASCADE ON UPDATE CASCADE,
 CONSTRAINT "MembershipSemester_semester_check" CHECK ("semester" ~ '^[0-9]{2}-[12]$')
);
CREATE TABLE "DiscordNicknameState" (
 "id" UUID PRIMARY KEY, "discordUserId" TEXT NOT NULL, "guildId" TEXT NOT NULL, "nickname" TEXT, "version" BIGINT NOT NULL DEFAULT 1, "validUntil" TIMESTAMP(3),
 "appliedNickname" TEXT, "appliedVersion" BIGINT, "appliedAt" TIMESTAMP(3), "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 "attempts" INTEGER NOT NULL DEFAULT 0, "lastError" TEXT, "leaseHash" TEXT, "leaseUntil" TIMESTAMP(3),
 "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL,
 CONSTRAINT "DiscordNicknameState_discordUserId_fkey" FOREIGN KEY ("discordUserId") REFERENCES "DiscordIdentity"("discordUserId") ON DELETE CASCADE ON UPDATE CASCADE,
 CONSTRAINT "DiscordNicknameState_nickname_check" CHECK ("nickname" IS NULL OR char_length("nickname") BETWEEN 1 AND 32),
 CONSTRAINT "DiscordNicknameState_lastError_check" CHECK ("lastError" IS NULL OR "lastError" IN ('retry','member_absent','configuration_error','not_manageable'))
);
CREATE UNIQUE INDEX "DiscordNicknameState_discordUserId_guildId_key" ON "DiscordNicknameState"("discordUserId","guildId");
CREATE INDEX "DiscordNicknameState_nextAttemptAt_leaseUntil_idx" ON "DiscordNicknameState"("nextAttemptAt","leaseUntil");
COMMIT;

CREATE TABLE "ServerRecord" (
  "id" TEXT NOT NULL,
  "label" TEXT NOT NULL,
  "sensitive" BOOLEAN NOT NULL DEFAULT false,
  "enabled" BOOLEAN NOT NULL DEFAULT false,
  "accessMode" TEXT NOT NULL DEFAULT 'roster',
  "allowedSubjectIds" UUID[] NOT NULL DEFAULT ARRAY[]::UUID[],
  "paperSeenAt" TIMESTAMP(3),
  "proxySeenAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ServerRecord_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ServerRecord_accessMode_check" CHECK ("accessMode" IN ('roster', 'members', 'selected'))
);

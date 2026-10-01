ALTER TABLE "UniversityAuthRequest" ADD COLUMN "consentVersion" TEXT, ADD COLUMN "consentAcceptedAt" TIMESTAMP(3);
CREATE TABLE "ConsentReceipt" (
  "id" UUID NOT NULL,
  "subjectId" UUID NOT NULL,
  "version" TEXT NOT NULL,
  "source" TEXT NOT NULL,
  "contextId" UUID NOT NULL,
  "acceptedAt" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ConsentReceipt_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ConsentReceipt_source_check" CHECK ("source" IN ('portal_login', 'minecraft_link')),
  CONSTRAINT "ConsentReceipt_subjectId_fkey" FOREIGN KEY ("subjectId") REFERENCES "Subject"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "ConsentReceipt_subjectId_version_source_contextId_key" ON "ConsentReceipt"("subjectId", "version", "source", "contextId");
CREATE INDEX "ConsentReceipt_subjectId_version_acceptedAt_idx" ON "ConsentReceipt"("subjectId", "version", "acceptedAt");

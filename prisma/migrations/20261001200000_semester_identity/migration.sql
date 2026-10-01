ALTER TABLE "Subject" ADD COLUMN "studentIdCiphertext" TEXT;
ALTER TABLE "Subject" ADD COLUMN "universityExpiryPolicyVersion" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "Subject" ADD CONSTRAINT "Subject_studentIdCiphertext_check" CHECK ("studentIdCiphertext" IS NULL OR "studentIdCiphertext" ~ '^[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{11,14}$');
ALTER TABLE "Subject" ADD CONSTRAINT "Subject_universityExpiryPolicyVersion_check" CHECK ("universityExpiryPolicyVersion" >= 0);

-- CreateTable
CREATE TABLE "EmailTriage" (
    "gmailMessageId" TEXT NOT NULL PRIMARY KEY,
    "gmailThreadId" TEXT NOT NULL,
    "fromEmail" TEXT NOT NULL,
    "fromName" TEXT,
    "subject" TEXT,
    "receivedAt" DATETIME NOT NULL,
    "category" TEXT NOT NULL,
    "confidence" REAL NOT NULL,
    "entitiesJson" TEXT,
    "needsHumanReview" BOOLEAN NOT NULL DEFAULT true,
    "reviewReason" TEXT,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "gmailWriteEnabled" BOOLEAN NOT NULL,
    "externalWriteEnabled" BOOLEAN NOT NULL,
    "classifierModel" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateIndex
CREATE INDEX "EmailTriage_gmailThreadId_idx" ON "EmailTriage"("gmailThreadId");

-- CreateIndex
CREATE INDEX "EmailTriage_category_idx" ON "EmailTriage"("category");

-- CreateIndex
CREATE INDEX "EmailTriage_status_idx" ON "EmailTriage"("status");

-- CreateIndex
CREATE INDEX "EmailTriage_receivedAt_idx" ON "EmailTriage"("receivedAt");

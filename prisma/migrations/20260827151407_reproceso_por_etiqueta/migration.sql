-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_EmailTriage" (
    "gmailMessageId" TEXT NOT NULL PRIMARY KEY,
    "gmailThreadId" TEXT NOT NULL,
    "fromEmail" TEXT NOT NULL,
    "fromName" TEXT,
    "subject" TEXT,
    "receivedAt" DATETIME NOT NULL,
    "category" TEXT NOT NULL,
    "categoriaBase" TEXT,
    "confidence" REAL NOT NULL,
    "entitiesJson" TEXT,
    "needsHumanReview" BOOLEAN NOT NULL DEFAULT true,
    "reviewReason" TEXT,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "gmailWriteEnabled" BOOLEAN NOT NULL,
    "externalWriteEnabled" BOOLEAN NOT NULL,
    "classifierModel" TEXT,
    "reprocesoHuella" TEXT,
    "reprocesoIntentos" INTEGER NOT NULL DEFAULT 0,
    "reprocesadoEn" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);
INSERT INTO "new_EmailTriage" ("categoriaBase", "category", "classifierModel", "confidence", "createdAt", "entitiesJson", "externalWriteEnabled", "fromEmail", "fromName", "gmailMessageId", "gmailThreadId", "gmailWriteEnabled", "needsHumanReview", "receivedAt", "reviewReason", "status", "subject", "updatedAt") SELECT "categoriaBase", "category", "classifierModel", "confidence", "createdAt", "entitiesJson", "externalWriteEnabled", "fromEmail", "fromName", "gmailMessageId", "gmailThreadId", "gmailWriteEnabled", "needsHumanReview", "receivedAt", "reviewReason", "status", "subject", "updatedAt" FROM "EmailTriage";
DROP TABLE "EmailTriage";
ALTER TABLE "new_EmailTriage" RENAME TO "EmailTriage";
CREATE INDEX "EmailTriage_gmailThreadId_idx" ON "EmailTriage"("gmailThreadId");
CREATE INDEX "EmailTriage_category_idx" ON "EmailTriage"("category");
CREATE INDEX "EmailTriage_status_idx" ON "EmailTriage"("status");
CREATE INDEX "EmailTriage_receivedAt_idx" ON "EmailTriage"("receivedAt");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

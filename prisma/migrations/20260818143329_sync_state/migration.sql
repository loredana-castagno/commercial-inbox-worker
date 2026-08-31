-- CreateTable
CREATE TABLE "SyncState" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT DEFAULT 1,
    "historyId" TEXT,
    "lastMessageDate" DATETIME,
    "lastRunAt" DATETIME,
    "updatedAt" DATETIME NOT NULL
);

-- AlterTable
ALTER TABLE "Bot" ADD COLUMN     "authMode" TEXT NOT NULL DEFAULT 'login';

-- AlterTable
ALTER TABLE "Turn" ADD COLUMN     "attempts" INTEGER NOT NULL DEFAULT 0;

-- CreateIndex
CREATE INDEX "Message_turnId_idx" ON "Message"("turnId");

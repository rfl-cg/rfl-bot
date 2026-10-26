-- CreateEnum
CREATE TYPE "MemberRole" AS ENUM ('OWNER', 'ADMIN', 'MEMBER');

-- CreateEnum
CREATE TYPE "BotStatus" AS ENUM ('IDLE', 'WORKING', 'PAUSED');

-- CreateEnum
CREATE TYPE "Channel" AS ENUM ('WEB', 'WHATSAPP', 'TELEGRAM', 'BOT');

-- CreateEnum
CREATE TYPE "MessageRole" AS ENUM ('USER', 'BOT', 'SYSTEM', 'TOOL');

-- CreateEnum
CREATE TYPE "TurnStatus" AS ENUM ('QUEUED', 'RUNNING', 'WAITING_APPROVAL', 'DONE', 'FAILED', 'CANCELED');

-- CreateEnum
CREATE TYPE "MemoryKind" AS ENUM ('FACT', 'PREFERENCE', 'NOTE');

-- CreateEnum
CREATE TYPE "MailboxStatus" AS ENUM ('PENDING', 'DELIVERED', 'ANSWERED', 'FAILED');

-- CreateEnum
CREATE TYPE "ApprovalStatus" AS ENUM ('PENDING', 'APPROVED', 'DENIED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "IntegrationType" AS ENUM ('MCP', 'COMPOSIO');

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "emailVerified" BOOLEAN NOT NULL DEFAULT false,
    "image" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Workspace" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Workspace_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Member" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "role" "MemberRole" NOT NULL DEFAULT 'MEMBER',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Member_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Bot" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "avatarUrl" TEXT,
    "instructions" TEXT NOT NULL DEFAULT '',
    "provider" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "effort" TEXT,
    "settings" JSONB NOT NULL DEFAULT '{}',
    "status" "BotStatus" NOT NULL DEFAULT 'IDLE',
    "sandboxId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Bot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Conversation" (
    "id" TEXT NOT NULL,
    "botId" TEXT NOT NULL,
    "channel" "Channel" NOT NULL,
    "externalChatId" TEXT,
    "title" TEXT,
    "lastMessageAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Conversation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Message" (
    "id" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "role" "MessageRole" NOT NULL,
    "content" JSONB NOT NULL,
    "authorUserId" TEXT,
    "authorBotId" TEXT,
    "turnId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Message_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Turn" (
    "id" TEXT NOT NULL,
    "botId" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "routineId" TEXT,
    "status" "TurnStatus" NOT NULL DEFAULT 'QUEUED',
    "provider" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "inputTokens" INTEGER NOT NULL DEFAULT 0,
    "outputTokens" INTEGER NOT NULL DEFAULT 0,
    "costUsd" DECIMAL(12,6) NOT NULL DEFAULT 0,
    "error" TEXT,
    "queuedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" TIMESTAMP(3),
    "endedAt" TIMESTAMP(3),

    CONSTRAINT "Turn_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Event" (
    "id" BIGSERIAL NOT NULL,
    "turnId" TEXT NOT NULL,
    "seq" INTEGER NOT NULL,
    "type" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Event_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProviderSession" (
    "id" TEXT NOT NULL,
    "botId" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "nativeSessionId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProviderSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Memory" (
    "id" TEXT NOT NULL,
    "botId" TEXT NOT NULL,
    "kind" "MemoryKind" NOT NULL DEFAULT 'FACT',
    "content" TEXT NOT NULL,
    "source" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Memory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Routine" (
    "id" TEXT NOT NULL,
    "botId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "cron" TEXT,
    "timezone" TEXT NOT NULL DEFAULT 'America/Sao_Paulo',
    "prompt" TEXT NOT NULL,
    "webhookToken" TEXT,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "lastRunAt" TIMESTAMP(3),
    "nextRunAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Routine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Mailbox" (
    "id" TEXT NOT NULL,
    "fromBotId" TEXT NOT NULL,
    "toBotId" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "status" "MailboxStatus" NOT NULL DEFAULT 'PENDING',
    "turnId" TEXT,
    "replyToId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Mailbox_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Approval" (
    "id" TEXT NOT NULL,
    "turnId" TEXT NOT NULL,
    "tool" TEXT NOT NULL,
    "args" JSONB NOT NULL,
    "summary" TEXT NOT NULL,
    "status" "ApprovalStatus" NOT NULL DEFAULT 'PENDING',
    "decidedByUserId" TEXT,
    "decidedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Approval_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ChannelBinding" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "channel" "Channel" NOT NULL,
    "externalId" TEXT NOT NULL,
    "botId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ChannelBinding_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Integration" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "botId" TEXT,
    "type" "IntegrationType" NOT NULL,
    "name" TEXT NOT NULL,
    "config" JSONB NOT NULL DEFAULT '{}',
    "secretId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Integration_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Secret" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "ciphertext" BYTEA NOT NULL,
    "last4" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Secret_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Skill" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "description" TEXT,
    "files" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Skill_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE UNIQUE INDEX "Workspace_slug_key" ON "Workspace"("slug");

-- CreateIndex
CREATE INDEX "Member_userId_idx" ON "Member"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "Member_workspaceId_userId_key" ON "Member"("workspaceId", "userId");

-- CreateIndex
CREATE UNIQUE INDEX "Bot_workspaceId_name_key" ON "Bot"("workspaceId", "name");

-- CreateIndex
CREATE INDEX "Conversation_botId_updatedAt_idx" ON "Conversation"("botId", "updatedAt");

-- CreateIndex
CREATE UNIQUE INDEX "Conversation_botId_channel_externalChatId_key" ON "Conversation"("botId", "channel", "externalChatId");

-- CreateIndex
CREATE INDEX "Message_conversationId_createdAt_idx" ON "Message"("conversationId", "createdAt");

-- CreateIndex
CREATE INDEX "Turn_botId_status_queuedAt_idx" ON "Turn"("botId", "status", "queuedAt");

-- CreateIndex
CREATE INDEX "Turn_conversationId_queuedAt_idx" ON "Turn"("conversationId", "queuedAt");

-- CreateIndex
CREATE UNIQUE INDEX "Event_turnId_seq_key" ON "Event"("turnId", "seq");

-- CreateIndex
CREATE UNIQUE INDEX "ProviderSession_botId_conversationId_provider_key" ON "ProviderSession"("botId", "conversationId", "provider");

-- CreateIndex
CREATE INDEX "Memory_botId_createdAt_idx" ON "Memory"("botId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "Routine_webhookToken_key" ON "Routine"("webhookToken");

-- CreateIndex
CREATE INDEX "Routine_botId_idx" ON "Routine"("botId");

-- CreateIndex
CREATE INDEX "Mailbox_toBotId_status_idx" ON "Mailbox"("toBotId", "status");

-- CreateIndex
CREATE INDEX "Approval_turnId_idx" ON "Approval"("turnId");

-- CreateIndex
CREATE INDEX "Approval_status_createdAt_idx" ON "Approval"("status", "createdAt");

-- CreateIndex
CREATE INDEX "ChannelBinding_workspaceId_idx" ON "ChannelBinding"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "ChannelBinding_channel_externalId_key" ON "ChannelBinding"("channel", "externalId");

-- CreateIndex
CREATE INDEX "Integration_workspaceId_idx" ON "Integration"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "Secret_workspaceId_name_key" ON "Secret"("workspaceId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "Skill_workspaceId_name_version_key" ON "Skill"("workspaceId", "name", "version");

-- AddForeignKey
ALTER TABLE "Member" ADD CONSTRAINT "Member_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Member" ADD CONSTRAINT "Member_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Bot" ADD CONSTRAINT "Bot_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Conversation" ADD CONSTRAINT "Conversation_botId_fkey" FOREIGN KEY ("botId") REFERENCES "Bot"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Message" ADD CONSTRAINT "Message_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Message" ADD CONSTRAINT "Message_authorBotId_fkey" FOREIGN KEY ("authorBotId") REFERENCES "Bot"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Message" ADD CONSTRAINT "Message_turnId_fkey" FOREIGN KEY ("turnId") REFERENCES "Turn"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Turn" ADD CONSTRAINT "Turn_botId_fkey" FOREIGN KEY ("botId") REFERENCES "Bot"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Turn" ADD CONSTRAINT "Turn_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Turn" ADD CONSTRAINT "Turn_routineId_fkey" FOREIGN KEY ("routineId") REFERENCES "Routine"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Event" ADD CONSTRAINT "Event_turnId_fkey" FOREIGN KEY ("turnId") REFERENCES "Turn"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProviderSession" ADD CONSTRAINT "ProviderSession_botId_fkey" FOREIGN KEY ("botId") REFERENCES "Bot"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProviderSession" ADD CONSTRAINT "ProviderSession_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Memory" ADD CONSTRAINT "Memory_botId_fkey" FOREIGN KEY ("botId") REFERENCES "Bot"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Routine" ADD CONSTRAINT "Routine_botId_fkey" FOREIGN KEY ("botId") REFERENCES "Bot"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Mailbox" ADD CONSTRAINT "Mailbox_fromBotId_fkey" FOREIGN KEY ("fromBotId") REFERENCES "Bot"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Mailbox" ADD CONSTRAINT "Mailbox_toBotId_fkey" FOREIGN KEY ("toBotId") REFERENCES "Bot"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Mailbox" ADD CONSTRAINT "Mailbox_turnId_fkey" FOREIGN KEY ("turnId") REFERENCES "Turn"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Mailbox" ADD CONSTRAINT "Mailbox_replyToId_fkey" FOREIGN KEY ("replyToId") REFERENCES "Mailbox"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Approval" ADD CONSTRAINT "Approval_turnId_fkey" FOREIGN KEY ("turnId") REFERENCES "Turn"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChannelBinding" ADD CONSTRAINT "ChannelBinding_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChannelBinding" ADD CONSTRAINT "ChannelBinding_botId_fkey" FOREIGN KEY ("botId") REFERENCES "Bot"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Integration" ADD CONSTRAINT "Integration_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Integration" ADD CONSTRAINT "Integration_botId_fkey" FOREIGN KEY ("botId") REFERENCES "Bot"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Integration" ADD CONSTRAINT "Integration_secretId_fkey" FOREIGN KEY ("secretId") REFERENCES "Secret"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Secret" ADD CONSTRAINT "Secret_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Skill" ADD CONSTRAINT "Skill_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

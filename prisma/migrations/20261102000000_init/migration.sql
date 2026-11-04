-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "TrackingStatus" AS ENUM ('REGISTERED', 'IN_TRANSIT', 'ARRIVED_AT_OFFICE', 'DELIVERED', 'RETURNING', 'RETURNED', 'UNKNOWN');

-- CreateEnum
CREATE TYPE "CrmSyncStatus" AS ENUM ('PENDING', 'SYNCED', 'FAILED');

-- CreateEnum
CREATE TYPE "NotificationType" AS ENUM ('STATUS_CHANGED', 'DELIVERED', 'STUCK', 'DAILY_REPORT', 'DEV_ALERT');

-- CreateEnum
CREATE TYPE "OutboxStatus" AS ENUM ('PENDING', 'SENT', 'FAILED');

-- CreateTable
CREATE TABLE "shipments" (
    "id" TEXT NOT NULL,
    "crmOrderId" TEXT NOT NULL,
    "trackCode" TEXT NOT NULL,
    "customerName" TEXT,
    "status" "TrackingStatus" NOT NULL DEFAULT 'REGISTERED',
    "rawStatus" TEXT,
    "lastLocation" TEXT,
    "statusChangedAt" TIMESTAMP(3),
    "lastEventAt" TIMESTAMP(3),
    "lastCheckedAt" TIMESTAMP(3),
    "nextCheckAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "pollErrorCount" INTEGER NOT NULL DEFAULT 0,
    "deliveredAt" TIMESTAMP(3),
    "crmSyncStatus" "CrmSyncStatus" NOT NULL DEFAULT 'SYNCED',
    "crmSyncAttempts" INTEGER NOT NULL DEFAULT 0,
    "stuckAlertSentAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "shipments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tracking_events" (
    "id" TEXT NOT NULL,
    "shipmentId" TEXT NOT NULL,
    "status" "TrackingStatus" NOT NULL,
    "rawStatus" TEXT NOT NULL,
    "location" TEXT,
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "dedupHash" TEXT NOT NULL,
    "rawPayload" JSONB NOT NULL,

    CONSTRAINT "tracking_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notification_outbox" (
    "id" TEXT NOT NULL,
    "type" "NotificationType" NOT NULL,
    "dedupKey" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "status" "OutboxStatus" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sentAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notification_outbox_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sync_state" (
    "key" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "sync_state_pkey" PRIMARY KEY ("key")
);

-- CreateIndex
CREATE UNIQUE INDEX "shipments_crmOrderId_key" ON "shipments"("crmOrderId");

-- CreateIndex
CREATE UNIQUE INDEX "shipments_trackCode_key" ON "shipments"("trackCode");

-- CreateIndex
CREATE INDEX "shipments_nextCheckAt_status_idx" ON "shipments"("nextCheckAt", "status");

-- CreateIndex
CREATE INDEX "shipments_crmSyncStatus_idx" ON "shipments"("crmSyncStatus");

-- CreateIndex
CREATE UNIQUE INDEX "tracking_events_dedupHash_key" ON "tracking_events"("dedupHash");

-- CreateIndex
CREATE INDEX "tracking_events_shipmentId_occurredAt_idx" ON "tracking_events"("shipmentId", "occurredAt");

-- CreateIndex
CREATE UNIQUE INDEX "notification_outbox_dedupKey_key" ON "notification_outbox"("dedupKey");

-- CreateIndex
CREATE INDEX "notification_outbox_status_createdAt_idx" ON "notification_outbox"("status", "createdAt");

-- AddForeignKey
ALTER TABLE "tracking_events" ADD CONSTRAINT "tracking_events_shipmentId_fkey" FOREIGN KEY ("shipmentId") REFERENCES "shipments"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Polling now runs on a fixed schedule (08:00 and 20:00 Almaty) over all active shipments,
-- so the per-shipment next-check time is no longer used.
DROP INDEX "shipments_nextCheckAt_status_idx";
ALTER TABLE "shipments" DROP COLUMN "nextCheckAt";

-- CreateEnum
CREATE TYPE "ProductionStatus" AS ENUM ('PLANNED', 'DONE', 'CANCELLED');

-- CreateEnum
CREATE TYPE "WasteReason" AS ENUM ('EXPIRED', 'UNSOLD', 'DAMAGED', 'QUALITY', 'OTHER');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "StockMovementType" ADD VALUE 'PRODUCTION';
ALTER TYPE "StockMovementType" ADD VALUE 'PRODUCTION_USE';
ALTER TYPE "StockMovementType" ADD VALUE 'WASTE';

-- AlterTable
ALTER TABLE "products" ADD COLUMN     "batch_yield" DECIMAL(10,3) NOT NULL DEFAULT 1,
ADD COLUMN     "made_in_house" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "shelf_life_hours" INTEGER;

-- CreateTable
CREATE TABLE "production_batches" (
    "id" UUID NOT NULL,
    "batch_no" VARCHAR(40) NOT NULL,
    "store_id" UUID NOT NULL,
    "product_id" UUID NOT NULL,
    "status" "ProductionStatus" NOT NULL DEFAULT 'PLANNED',
    "planned_qty" DECIMAL(14,3) NOT NULL,
    "produced_qty" DECIMAL(14,3),
    "unit_cost" DECIMAL(14,6),
    "total_cost" DECIMAL(14,2),
    "ingredients" JSONB,
    "expires_at" TIMESTAMP(3),
    "note" VARCHAR(200),
    "created_by_id" UUID,
    "completed_by_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" TIMESTAMP(3),

    CONSTRAINT "production_batches_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "waste_entries" (
    "id" UUID NOT NULL,
    "store_id" UUID NOT NULL,
    "product_id" UUID NOT NULL,
    "quantity" DECIMAL(14,3) NOT NULL,
    "unit_cost" DECIMAL(14,6) NOT NULL,
    "reason" "WasteReason" NOT NULL,
    "note" VARCHAR(200),
    "user_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "waste_entries_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "production_batches_batch_no_key" ON "production_batches"("batch_no");

-- CreateIndex
CREATE INDEX "production_batches_store_id_created_at_idx" ON "production_batches"("store_id", "created_at");

-- CreateIndex
CREATE INDEX "production_batches_store_id_product_id_completed_at_idx" ON "production_batches"("store_id", "product_id", "completed_at");

-- CreateIndex
CREATE INDEX "waste_entries_store_id_created_at_idx" ON "waste_entries"("store_id", "created_at");

-- AddForeignKey
ALTER TABLE "production_batches" ADD CONSTRAINT "production_batches_store_id_fkey" FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "production_batches" ADD CONSTRAINT "production_batches_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "waste_entries" ADD CONSTRAINT "waste_entries_store_id_fkey" FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "waste_entries" ADD CONSTRAINT "waste_entries_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


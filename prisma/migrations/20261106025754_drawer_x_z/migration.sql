-- CreateEnum
CREATE TYPE "CashMoveType" AS ENUM ('PAY_IN', 'PAY_OUT');

-- AlterEnum
ALTER TYPE "ApprovalAction" ADD VALUE 'CASH_OUT';

-- AlterTable
ALTER TABLE "approvals" ADD COLUMN     "max_amount" DECIMAL(14,2);

-- AlterTable
ALTER TABLE "stores" ADD COLUMN     "cash_out_needs_approval" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "z_seq" INTEGER NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "cash_movements" (
    "id" UUID NOT NULL,
    "shift_id" UUID NOT NULL,
    "store_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "type" "CashMoveType" NOT NULL,
    "currency" VARCHAR(3) NOT NULL DEFAULT 'USD',
    "amount" DECIMAL(14,2) NOT NULL,
    "reason" VARCHAR(200) NOT NULL,
    "approved_by_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "cash_movements_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "z_reports" (
    "id" UUID NOT NULL,
    "store_id" UUID NOT NULL,
    "z_no" INTEGER NOT NULL,
    "business_day" DATE NOT NULL,
    "from_at" TIMESTAMP(3) NOT NULL,
    "to_at" TIMESTAMP(3) NOT NULL,
    "data" JSONB NOT NULL,
    "created_by_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "z_reports_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "cash_movements_shift_id_idx" ON "cash_movements"("shift_id");

-- CreateIndex
CREATE INDEX "cash_movements_store_id_created_at_idx" ON "cash_movements"("store_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "z_reports_store_id_business_day_key" ON "z_reports"("store_id", "business_day");

-- CreateIndex
CREATE UNIQUE INDEX "z_reports_store_id_z_no_key" ON "z_reports"("store_id", "z_no");

-- AddForeignKey
ALTER TABLE "cash_movements" ADD CONSTRAINT "cash_movements_shift_id_fkey" FOREIGN KEY ("shift_id") REFERENCES "shifts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


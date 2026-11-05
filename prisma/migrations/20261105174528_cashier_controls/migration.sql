-- CreateEnum
CREATE TYPE "ApprovalAction" AS ENUM ('DISCOUNT', 'REFUND', 'VOID');

-- AlterTable
ALTER TABLE "stores" ADD COLUMN     "cashier_max_discount_percent" DECIMAL(5,2) NOT NULL DEFAULT 10,
ADD COLUMN     "refund_needs_approval" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "void_needs_approval" BOOLEAN NOT NULL DEFAULT true;

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "approval_pin_hash" TEXT;

-- CreateTable
CREATE TABLE "approvals" (
    "id" UUID NOT NULL,
    "store_id" UUID NOT NULL,
    "action" "ApprovalAction" NOT NULL,
    "max_percent" DECIMAL(5,2),
    "sale_id" UUID,
    "manager_id" UUID NOT NULL,
    "requested_by_id" UUID NOT NULL,
    "reason" VARCHAR(200),
    "expires_at" TIMESTAMP(3) NOT NULL,
    "used_at" TIMESTAMP(3),
    "used_for" VARCHAR(64),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "approvals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_logs" (
    "id" BIGSERIAL NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "store_id" UUID,
    "user_id" UUID,
    "user_name" VARCHAR(150),
    "action" VARCHAR(50) NOT NULL,
    "entity_type" VARCHAR(30),
    "entity_id" VARCHAR(64),
    "summary" VARCHAR(300) NOT NULL,
    "details" JSONB,
    "approved_by_id" UUID,
    "approved_by_name" VARCHAR(150),
    "ip" VARCHAR(64),

    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "approvals_store_id_created_at_idx" ON "approvals"("store_id", "created_at");

-- CreateIndex
CREATE INDEX "audit_logs_created_at_idx" ON "audit_logs"("created_at");

-- CreateIndex
CREATE INDEX "audit_logs_store_id_created_at_idx" ON "audit_logs"("store_id", "created_at");

-- CreateIndex
CREATE INDEX "audit_logs_action_created_at_idx" ON "audit_logs"("action", "created_at");

-- CreateIndex
CREATE INDEX "audit_logs_user_id_created_at_idx" ON "audit_logs"("user_id", "created_at");


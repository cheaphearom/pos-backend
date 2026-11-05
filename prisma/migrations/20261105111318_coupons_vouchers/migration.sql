-- CreateEnum
CREATE TYPE "CouponType" AS ENUM ('PERCENT', 'AMOUNT');

-- CreateEnum
CREATE TYPE "VoucherStatus" AS ENUM ('INACTIVE', 'ACTIVE', 'USED', 'VOID');

-- AlterEnum
ALTER TYPE "PaymentMethod" ADD VALUE 'VOUCHER';

-- AlterTable
ALTER TABLE "sales" ADD COLUMN     "coupon_code_id" UUID,
ADD COLUMN     "coupon_discount" DECIMAL(14,2) NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "coupon_campaigns" (
    "id" UUID NOT NULL,
    "name" VARCHAR(100) NOT NULL,
    "type" "CouponType" NOT NULL,
    "value" DECIMAL(14,2) NOT NULL,
    "min_spend" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "max_discount" DECIMAL(14,2),
    "store_ids" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "starts_at" TIMESTAMP(3),
    "ends_at" TIMESTAMP(3),
    "usage_limit" INTEGER,
    "per_customer_limit" INTEGER,
    "members_only" BOOLEAN NOT NULL DEFAULT false,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "used_count" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "coupon_campaigns_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "coupon_codes" (
    "id" UUID NOT NULL,
    "campaign_id" UUID NOT NULL,
    "code" VARCHAR(40) NOT NULL,
    "max_uses" INTEGER,
    "used_count" INTEGER NOT NULL DEFAULT 0,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "coupon_codes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "coupon_redemptions" (
    "id" BIGSERIAL NOT NULL,
    "code_id" UUID NOT NULL,
    "campaign_id" UUID NOT NULL,
    "sale_id" UUID NOT NULL,
    "customer_id" UUID,
    "store_id" UUID NOT NULL,
    "discount" DECIMAL(14,2) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "coupon_redemptions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "voucher_batches" (
    "id" UUID NOT NULL,
    "name" VARCHAR(100) NOT NULL,
    "value" DECIMAL(14,2) NOT NULL,
    "sold" BOOLEAN NOT NULL DEFAULT true,
    "expires_at" TIMESTAMP(3),
    "count" INTEGER NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "voucher_batches_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "vouchers" (
    "id" UUID NOT NULL,
    "batch_id" UUID NOT NULL,
    "code" VARCHAR(40) NOT NULL,
    "value" DECIMAL(14,2) NOT NULL,
    "balance" DECIMAL(14,2) NOT NULL,
    "status" "VoucherStatus" NOT NULL DEFAULT 'INACTIVE',
    "expires_at" TIMESTAMP(3),
    "sold_at" TIMESTAMP(3),
    "sold_store_id" UUID,
    "sold_method" "PaymentMethod",
    "sold_shift_id" UUID,
    "sold_by_id" UUID,
    "note" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "vouchers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "voucher_uses" (
    "id" BIGSERIAL NOT NULL,
    "voucher_id" UUID NOT NULL,
    "sale_id" UUID NOT NULL,
    "store_id" UUID NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "voucher_uses_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "coupon_codes_code_key" ON "coupon_codes"("code");

-- CreateIndex
CREATE INDEX "coupon_codes_campaign_id_idx" ON "coupon_codes"("campaign_id");

-- CreateIndex
CREATE UNIQUE INDEX "coupon_redemptions_sale_id_key" ON "coupon_redemptions"("sale_id");

-- CreateIndex
CREATE INDEX "coupon_redemptions_campaign_id_created_at_idx" ON "coupon_redemptions"("campaign_id", "created_at");

-- CreateIndex
CREATE INDEX "coupon_redemptions_customer_id_campaign_id_idx" ON "coupon_redemptions"("customer_id", "campaign_id");

-- CreateIndex
CREATE UNIQUE INDEX "vouchers_code_key" ON "vouchers"("code");

-- CreateIndex
CREATE INDEX "vouchers_batch_id_idx" ON "vouchers"("batch_id");

-- CreateIndex
CREATE INDEX "vouchers_status_idx" ON "vouchers"("status");

-- CreateIndex
CREATE INDEX "voucher_uses_voucher_id_idx" ON "voucher_uses"("voucher_id");

-- CreateIndex
CREATE INDEX "voucher_uses_sale_id_idx" ON "voucher_uses"("sale_id");

-- AddForeignKey
ALTER TABLE "coupon_codes" ADD CONSTRAINT "coupon_codes_campaign_id_fkey" FOREIGN KEY ("campaign_id") REFERENCES "coupon_campaigns"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "coupon_redemptions" ADD CONSTRAINT "coupon_redemptions_code_id_fkey" FOREIGN KEY ("code_id") REFERENCES "coupon_codes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "coupon_redemptions" ADD CONSTRAINT "coupon_redemptions_campaign_id_fkey" FOREIGN KEY ("campaign_id") REFERENCES "coupon_campaigns"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vouchers" ADD CONSTRAINT "vouchers_batch_id_fkey" FOREIGN KEY ("batch_id") REFERENCES "voucher_batches"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "voucher_uses" ADD CONSTRAINT "voucher_uses_voucher_id_fkey" FOREIGN KEY ("voucher_id") REFERENCES "vouchers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

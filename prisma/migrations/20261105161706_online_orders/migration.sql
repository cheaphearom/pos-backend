-- CreateEnum
CREATE TYPE "OnlineOrderStatus" AS ENUM ('PENDING_PAYMENT', 'PAY_AT_COUNTER', 'PAID', 'CANCELLED', 'EXPIRED', 'FAILED');

-- AlterTable
ALTER TABLE "products" ADD COLUMN     "online_available" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "stores" ADD COLUMN     "online_ordering" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "online_orders" (
    "id" UUID NOT NULL,
    "token" VARCHAR(48) NOT NULL,
    "store_id" UUID NOT NULL,
    "status" "OnlineOrderStatus" NOT NULL,
    "order_type" "OrderType" NOT NULL,
    "table_no" VARCHAR(20),
    "customer_name" VARCHAR(80) NOT NULL,
    "phone" VARCHAR(30),
    "note" VARCHAR(200),
    "items" JSONB NOT NULL,
    "coupon_code" VARCHAR(40),
    "total" DECIMAL(14,2) NOT NULL,
    "khqr_md5" VARCHAR(32),
    "sale_id" UUID,
    "error" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "paid_at" TIMESTAMP(3),

    CONSTRAINT "online_orders_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "online_orders_token_key" ON "online_orders"("token");

-- CreateIndex
CREATE UNIQUE INDEX "online_orders_sale_id_key" ON "online_orders"("sale_id");

-- CreateIndex
CREATE INDEX "online_orders_store_id_status_created_at_idx" ON "online_orders"("store_id", "status", "created_at");


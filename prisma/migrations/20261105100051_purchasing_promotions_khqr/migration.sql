-- CreateEnum
CREATE TYPE "PurchaseOrderStatus" AS ENUM ('DRAFT', 'ORDERED', 'PARTIALLY_RECEIVED', 'RECEIVED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "PromotionType" AS ENUM ('PERCENT_OFF', 'AMOUNT_OFF', 'BUY_X_GET_Y');

-- CreateEnum
CREATE TYPE "KhqrStatus" AS ENUM ('PENDING', 'PAID', 'EXPIRED');

-- AlterTable
ALTER TABLE "sale_items" ADD COLUMN     "promo_discount" DECIMAL(14,2) NOT NULL DEFAULT 0,
ADD COLUMN     "promotion_id" UUID;

-- AlterTable
ALTER TABLE "stores" ADD COLUMN     "khqr_account_id" VARCHAR(32),
ADD COLUMN     "khqr_bank" VARCHAR(32),
ADD COLUMN     "khqr_city" VARCHAR(15),
ADD COLUMN     "khqr_merchant_id" VARCHAR(32),
ADD COLUMN     "khqr_merchant_name" VARCHAR(25);

-- CreateTable
CREATE TABLE "suppliers" (
    "id" UUID NOT NULL,
    "code" VARCHAR(30) NOT NULL,
    "name" VARCHAR(150) NOT NULL,
    "contact_name" VARCHAR(150),
    "phone" VARCHAR(30),
    "email" VARCHAR(150),
    "address" TEXT,
    "tax_id" VARCHAR(50),
    "payment_terms_days" INTEGER NOT NULL DEFAULT 0,
    "note" TEXT,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "suppliers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "purchase_orders" (
    "id" UUID NOT NULL,
    "po_no" VARCHAR(40) NOT NULL,
    "supplier_id" UUID NOT NULL,
    "store_id" UUID NOT NULL,
    "status" "PurchaseOrderStatus" NOT NULL DEFAULT 'DRAFT',
    "expected_at" TIMESTAMP(3),
    "note" TEXT,
    "subtotal" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "created_by_id" UUID,
    "ordered_at" TIMESTAMP(3),
    "received_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "purchase_orders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "purchase_order_items" (
    "id" UUID NOT NULL,
    "purchase_order_id" UUID NOT NULL,
    "line_no" INTEGER NOT NULL,
    "product_id" UUID NOT NULL,
    "quantity" DECIMAL(14,3) NOT NULL,
    "unit_cost" DECIMAL(14,2) NOT NULL,
    "received_qty" DECIMAL(14,3) NOT NULL DEFAULT 0,

    CONSTRAINT "purchase_order_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "goods_receipts" (
    "id" UUID NOT NULL,
    "purchase_order_id" UUID NOT NULL,
    "reference" VARCHAR(100),
    "note" TEXT,
    "user_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "goods_receipts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "goods_receipt_items" (
    "id" UUID NOT NULL,
    "goods_receipt_id" UUID NOT NULL,
    "purchase_order_item_id" UUID NOT NULL,
    "quantity" DECIMAL(14,3) NOT NULL,
    "unit_cost" DECIMAL(14,2) NOT NULL,

    CONSTRAINT "goods_receipt_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "promotions" (
    "id" UUID NOT NULL,
    "name" VARCHAR(100) NOT NULL,
    "description" TEXT,
    "type" "PromotionType" NOT NULL,
    "value" DECIMAL(14,4) NOT NULL DEFAULT 0,
    "buy_qty" INTEGER,
    "get_qty" INTEGER,
    "all_products" BOOLEAN NOT NULL DEFAULT false,
    "product_ids" TEXT[],
    "category_ids" TEXT[],
    "store_ids" TEXT[],
    "starts_at" TIMESTAMP(3),
    "ends_at" TIMESTAMP(3),
    "days_of_week" INTEGER[],
    "start_minute" INTEGER,
    "end_minute" INTEGER,
    "priority" INTEGER NOT NULL DEFAULT 0,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "promotions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "khqr_payments" (
    "id" UUID NOT NULL,
    "md5" VARCHAR(32) NOT NULL,
    "store_id" UUID NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,
    "currency" VARCHAR(3) NOT NULL,
    "bill_number" VARCHAR(25) NOT NULL,
    "qr" TEXT NOT NULL,
    "status" "KhqrStatus" NOT NULL DEFAULT 'PENDING',
    "expires_at" TIMESTAMP(3) NOT NULL,
    "paid_at" TIMESTAMP(3),
    "transaction_hash" VARCHAR(100),
    "from_account" VARCHAR(100),
    "confirmed_by_id" UUID,
    "last_checked_at" TIMESTAMP(3),
    "sale_id" UUID,
    "created_by_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "khqr_payments_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "suppliers_code_key" ON "suppliers"("code");

-- CreateIndex
CREATE INDEX "suppliers_name_idx" ON "suppliers"("name");

-- CreateIndex
CREATE UNIQUE INDEX "purchase_orders_po_no_key" ON "purchase_orders"("po_no");

-- CreateIndex
CREATE INDEX "purchase_orders_store_id_created_at_idx" ON "purchase_orders"("store_id", "created_at");

-- CreateIndex
CREATE INDEX "purchase_orders_supplier_id_created_at_idx" ON "purchase_orders"("supplier_id", "created_at");

-- CreateIndex
CREATE INDEX "purchase_orders_status_idx" ON "purchase_orders"("status");

-- CreateIndex
CREATE INDEX "purchase_order_items_purchase_order_id_idx" ON "purchase_order_items"("purchase_order_id");

-- CreateIndex
CREATE INDEX "goods_receipts_purchase_order_id_idx" ON "goods_receipts"("purchase_order_id");

-- CreateIndex
CREATE INDEX "promotions_is_active_idx" ON "promotions"("is_active");

-- CreateIndex
CREATE UNIQUE INDEX "khqr_payments_md5_key" ON "khqr_payments"("md5");

-- CreateIndex
CREATE UNIQUE INDEX "khqr_payments_sale_id_key" ON "khqr_payments"("sale_id");

-- CreateIndex
CREATE INDEX "khqr_payments_store_id_created_at_idx" ON "khqr_payments"("store_id", "created_at");

-- CreateIndex
CREATE INDEX "sale_items_promotion_id_idx" ON "sale_items"("promotion_id");

-- AddForeignKey
ALTER TABLE "sale_items" ADD CONSTRAINT "sale_items_promotion_id_fkey" FOREIGN KEY ("promotion_id") REFERENCES "promotions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_orders" ADD CONSTRAINT "purchase_orders_supplier_id_fkey" FOREIGN KEY ("supplier_id") REFERENCES "suppliers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_orders" ADD CONSTRAINT "purchase_orders_store_id_fkey" FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_order_items" ADD CONSTRAINT "purchase_order_items_purchase_order_id_fkey" FOREIGN KEY ("purchase_order_id") REFERENCES "purchase_orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_order_items" ADD CONSTRAINT "purchase_order_items_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "goods_receipts" ADD CONSTRAINT "goods_receipts_purchase_order_id_fkey" FOREIGN KEY ("purchase_order_id") REFERENCES "purchase_orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "goods_receipt_items" ADD CONSTRAINT "goods_receipt_items_goods_receipt_id_fkey" FOREIGN KEY ("goods_receipt_id") REFERENCES "goods_receipts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "goods_receipt_items" ADD CONSTRAINT "goods_receipt_items_purchase_order_item_id_fkey" FOREIGN KEY ("purchase_order_item_id") REFERENCES "purchase_order_items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "khqr_payments" ADD CONSTRAINT "khqr_payments_store_id_fkey" FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

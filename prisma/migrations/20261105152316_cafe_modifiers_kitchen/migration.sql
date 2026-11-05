-- CreateEnum
CREATE TYPE "OrderType" AS ENUM ('RETAIL', 'TAKEAWAY', 'DINE_IN', 'PICKUP', 'DELIVERY');

-- CreateEnum
CREATE TYPE "KitchenStatus" AS ENUM ('NONE', 'NEW', 'PREPARING', 'READY', 'COMPLETED', 'CANCELLED');

-- AlterTable
ALTER TABLE "products" ADD COLUMN     "image_url" TEXT;

-- AlterTable
ALTER TABLE "sale_items" ADD COLUMN     "modifiers" JSONB,
ADD COLUMN     "note" VARCHAR(200);

-- AlterTable
ALTER TABLE "sales" ADD COLUMN     "completed_at" TIMESTAMP(3),
ADD COLUMN     "kitchen_started_at" TIMESTAMP(3),
ADD COLUMN     "kitchen_status" "KitchenStatus" NOT NULL DEFAULT 'NONE',
ADD COLUMN     "order_type" "OrderType" NOT NULL DEFAULT 'RETAIL',
ADD COLUMN     "queue_no" VARCHAR(10),
ADD COLUMN     "ready_at" TIMESTAMP(3),
ADD COLUMN     "table_no" VARCHAR(20);

-- AlterTable
ALTER TABLE "stores" ADD COLUMN     "has_kitchen" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "modifier_groups" (
    "id" UUID NOT NULL,
    "name" VARCHAR(60) NOT NULL,
    "min_select" INTEGER NOT NULL DEFAULT 0,
    "max_select" INTEGER NOT NULL DEFAULT 1,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "modifier_groups_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "modifier_options" (
    "id" UUID NOT NULL,
    "group_id" UUID NOT NULL,
    "name" VARCHAR(60) NOT NULL,
    "price_delta" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "is_default" BOOLEAN NOT NULL DEFAULT false,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "is_active" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "modifier_options_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "product_modifier_groups" (
    "product_id" UUID NOT NULL,
    "group_id" UUID NOT NULL,
    "sort_order" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "product_modifier_groups_pkey" PRIMARY KEY ("product_id","group_id")
);

-- CreateTable
CREATE TABLE "store_day_counters" (
    "store_id" UUID NOT NULL,
    "day" DATE NOT NULL,
    "seq" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "store_day_counters_pkey" PRIMARY KEY ("store_id","day")
);

-- CreateIndex
CREATE INDEX "modifier_options_group_id_idx" ON "modifier_options"("group_id");

-- CreateIndex
CREATE INDEX "product_modifier_groups_group_id_idx" ON "product_modifier_groups"("group_id");

-- CreateIndex
CREATE INDEX "sales_store_id_kitchen_status_idx" ON "sales"("store_id", "kitchen_status");

-- AddForeignKey
ALTER TABLE "modifier_options" ADD CONSTRAINT "modifier_options_group_id_fkey" FOREIGN KEY ("group_id") REFERENCES "modifier_groups"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_modifier_groups" ADD CONSTRAINT "product_modifier_groups_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_modifier_groups" ADD CONSTRAINT "product_modifier_groups_group_id_fkey" FOREIGN KEY ("group_id") REFERENCES "modifier_groups"("id") ON DELETE CASCADE ON UPDATE CASCADE;

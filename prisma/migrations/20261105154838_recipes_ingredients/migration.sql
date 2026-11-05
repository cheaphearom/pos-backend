-- CreateEnum
CREATE TYPE "RecipeEffectType" AS ENUM ('SCALE', 'REPLACE', 'ADD');

-- AlterEnum
ALTER TYPE "StockMovementType" ADD VALUE 'RECIPE';

-- AlterTable
ALTER TABLE "goods_receipt_items" ALTER COLUMN "unit_cost" SET DATA TYPE DECIMAL(14,6);

-- AlterTable
ALTER TABLE "products" ADD COLUMN     "is_ingredient" BOOLEAN NOT NULL DEFAULT false,
ALTER COLUMN "cost_price" SET DATA TYPE DECIMAL(14,6);

-- AlterTable
ALTER TABLE "purchase_order_items" ALTER COLUMN "unit_cost" SET DATA TYPE DECIMAL(14,6);

-- AlterTable
ALTER TABLE "sale_items" ALTER COLUMN "cost_price" SET DATA TYPE DECIMAL(14,6);

-- CreateTable
CREATE TABLE "recipe_items" (
    "id" UUID NOT NULL,
    "product_id" UUID NOT NULL,
    "ingredient_id" UUID NOT NULL,
    "quantity" DECIMAL(14,4) NOT NULL,

    CONSTRAINT "recipe_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "modifier_effects" (
    "id" UUID NOT NULL,
    "option_id" UUID NOT NULL,
    "type" "RecipeEffectType" NOT NULL,
    "ingredient_id" UUID,
    "replace_with_id" UUID,
    "quantity" DECIMAL(14,4),
    "percent" DECIMAL(7,2),

    CONSTRAINT "modifier_effects_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "recipe_items_product_id_ingredient_id_key" ON "recipe_items"("product_id", "ingredient_id");

-- CreateIndex
CREATE INDEX "modifier_effects_option_id_idx" ON "modifier_effects"("option_id");

-- AddForeignKey
ALTER TABLE "recipe_items" ADD CONSTRAINT "recipe_items_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recipe_items" ADD CONSTRAINT "recipe_items_ingredient_id_fkey" FOREIGN KEY ("ingredient_id") REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "modifier_effects" ADD CONSTRAINT "modifier_effects_option_id_fkey" FOREIGN KEY ("option_id") REFERENCES "modifier_options"("id") ON DELETE CASCADE ON UPDATE CASCADE;


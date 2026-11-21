-- CreateTable
CREATE TABLE "price_changes" (
    "id" BIGSERIAL NOT NULL,
    "product_id" UUID NOT NULL,
    "store_id" UUID,
    "option_id" UUID,
    "size_name" VARCHAR(60),
    "old_price" DECIMAL(14,2),
    "new_price" DECIMAL(14,2) NOT NULL,
    "source" VARCHAR(30) NOT NULL,
    "user_id" UUID,
    "user_name" VARCHAR(150),
    "note" VARCHAR(200),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "price_changes_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "price_changes_product_id_created_at_idx" ON "price_changes"("product_id", "created_at");

-- CreateIndex
CREATE INDEX "price_changes_created_at_idx" ON "price_changes"("created_at");

-- AddForeignKey
ALTER TABLE "price_changes" ADD CONSTRAINT "price_changes_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "price_changes" ADD CONSTRAINT "price_changes_store_id_fkey" FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE CASCADE ON UPDATE CASCADE;


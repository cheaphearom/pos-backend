-- Options per product and store (sizes with their own price, which BROWN options a drink offers).
CREATE TABLE "product_options" (
    "id" UUID NOT NULL,
    "product_id" UUID NOT NULL,
    "option_id" UUID NOT NULL,
    "store_id" UUID NOT NULL,
    "price_delta" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "is_default" BOOLEAN NOT NULL DEFAULT false,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "product_options_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "product_options_product_id_option_id_store_id_key" ON "product_options"("product_id", "option_id", "store_id");
CREATE INDEX "product_options_store_id_product_id_idx" ON "product_options"("store_id", "product_id");
ALTER TABLE "product_options" ADD CONSTRAINT "product_options_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "product_options" ADD CONSTRAINT "product_options_option_id_fkey" FOREIGN KEY ("option_id") REFERENCES "modifier_options"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "product_options" ADD CONSTRAINT "product_options_store_id_fkey" FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE CASCADE ON UPDATE CASCADE;

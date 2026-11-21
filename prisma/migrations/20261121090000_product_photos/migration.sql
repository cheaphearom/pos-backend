-- CreateTable
CREATE TABLE "product_photos" (
    "product_id" UUID NOT NULL,
    "mime_type" VARCHAR(40) NOT NULL,
    "image" BYTEA NOT NULL,
    "size_bytes" INTEGER NOT NULL,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "product_photos_pkey" PRIMARY KEY ("product_id")
);

-- AddForeignKey
ALTER TABLE "product_photos" ADD CONSTRAINT "product_photos_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE CASCADE ON UPDATE CASCADE;


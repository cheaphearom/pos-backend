-- Pictures for the customer display, uploaded in the admin portal.
CREATE TABLE "display_slides" (
    "id" UUID NOT NULL,
    "store_id" UUID,
    "title" VARCHAR(120) NOT NULL,
    "mime_type" VARCHAR(40) NOT NULL,
    "image" BYTEA NOT NULL,
    "size_bytes" INTEGER NOT NULL,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "starts_at" TIMESTAMP(3),
    "ends_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "display_slides_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "display_slides_store_id_is_active_idx" ON "display_slides"("store_id", "is_active");
ALTER TABLE "display_slides" ADD CONSTRAINT "display_slides_store_id_fkey" FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Products per store: a store sells only the products listed for it (inventory.is_listed).
ALTER TABLE "inventory" ADD COLUMN "is_listed" BOOLEAN NOT NULL DEFAULT true;
CREATE INDEX "inventory_store_id_is_listed_idx" ON "inventory"("store_id", "is_listed");

-- Keep everything as it was: every existing product stays for sale in every existing store.
INSERT INTO "inventory" ("id", "store_id", "product_id", "updated_at")
SELECT gen_random_uuid(), s."id", p."id", CURRENT_TIMESTAMP
FROM "stores" s CROSS JOIN "products" p
ON CONFLICT ("store_id", "product_id") DO NOTHING;

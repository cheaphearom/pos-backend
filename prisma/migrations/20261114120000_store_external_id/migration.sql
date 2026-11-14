-- The store's id in the BROWN system (idoutlet). IF NOT EXISTS: some databases already have it from add-store-external-id.sql.
ALTER TABLE "stores" ADD COLUMN IF NOT EXISTS "external_id" VARCHAR(50);
CREATE UNIQUE INDEX IF NOT EXISTS "stores_external_id_key" ON "stores"("external_id");

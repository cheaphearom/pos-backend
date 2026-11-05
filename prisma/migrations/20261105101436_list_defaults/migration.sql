-- AlterTable
ALTER TABLE "api_keys" ALTER COLUMN "scopes" SET DEFAULT ARRAY[]::TEXT[];

-- AlterTable
ALTER TABLE "promotions" ALTER COLUMN "product_ids" SET DEFAULT ARRAY[]::TEXT[],
ALTER COLUMN "category_ids" SET DEFAULT ARRAY[]::TEXT[],
ALTER COLUMN "store_ids" SET DEFAULT ARRAY[]::TEXT[],
ALTER COLUMN "days_of_week" SET DEFAULT ARRAY[]::INTEGER[];

-- AlterTable
ALTER TABLE "webhook_endpoints" ALTER COLUMN "events" SET DEFAULT ARRAY[]::TEXT[];

-- Rows created before the defaults existed may hold NULL instead of an empty list.
UPDATE "promotions" SET "product_ids" = '{}' WHERE "product_ids" IS NULL;
UPDATE "promotions" SET "category_ids" = '{}' WHERE "category_ids" IS NULL;
UPDATE "promotions" SET "store_ids" = '{}' WHERE "store_ids" IS NULL;
UPDATE "promotions" SET "days_of_week" = '{}' WHERE "days_of_week" IS NULL;
UPDATE "api_keys" SET "scopes" = '{}' WHERE "scopes" IS NULL;
UPDATE "webhook_endpoints" SET "events" = '{}' WHERE "events" IS NULL;

-- AlterTable
ALTER TABLE "payments" ADD COLUMN     "currency" VARCHAR(3) NOT NULL DEFAULT 'USD',
ADD COLUMN     "rate" DECIMAL(12,4),
ADD COLUMN     "tendered" DECIMAL(16,2);

-- AlterTable
ALTER TABLE "sales" ADD COLUMN     "change_khr" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "change_usd" DECIMAL(14,2) NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "shifts" ADD COLUMN     "closing_khr" INTEGER,
ADD COLUMN     "expected_khr" INTEGER,
ADD COLUMN     "opening_khr" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "stores" ADD COLUMN     "khr_rate" INTEGER;


-- Change given before dual currency was all in dollars.
UPDATE "sales" SET "change_usd" = "change_due" WHERE "change_due" <> 0;

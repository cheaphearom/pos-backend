-- AlterTable
ALTER TABLE "customers" ADD COLUMN     "app_joined_at" TIMESTAMP(3),
ADD COLUMN     "app_last_seen_at" TIMESTAMP(3),
ADD COLUMN     "app_token_version" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "online_orders" ADD COLUMN     "customer_id" UUID,
ADD COLUMN     "redeem_points" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "wallet_card_id" UUID;

-- CreateTable
CREATE TABLE "member_otps" (
    "id" UUID NOT NULL,
    "phone" VARCHAR(30) NOT NULL,
    "code_hash" TEXT NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "used_at" TIMESTAMP(3),
    "ip" VARCHAR(64),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "member_otps_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "member_otps_phone_created_at_idx" ON "member_otps"("phone", "created_at");

-- CreateIndex
CREATE INDEX "online_orders_customer_id_created_at_idx" ON "online_orders"("customer_id", "created_at");

-- AddForeignKey
ALTER TABLE "online_orders" ADD CONSTRAINT "online_orders_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- Store phone numbers in one format (digits only, +855 → 0) so members can log in with their phone.
-- Rows that would clash with another customer are left as they are.
WITH x AS (
  SELECT id, regexp_replace(phone, '[^0-9]', '', 'g') AS d FROM customers WHERE phone IS NOT NULL
), n AS (
  SELECT id, CASE WHEN d LIKE '855%' AND length(d) >= 11 THEN '0' || substr(d, 4) ELSE d END AS np FROM x
)
UPDATE customers c SET phone = n.np
  FROM n
 WHERE c.id = n.id AND c.phone <> n.np AND n.np <> ''
   AND NOT EXISTS (SELECT 1 FROM customers o WHERE o.phone = n.np)
   AND (SELECT count(*) FROM n n2 WHERE n2.np = n.np) = 1;

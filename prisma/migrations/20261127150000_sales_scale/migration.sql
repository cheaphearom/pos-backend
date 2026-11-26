-- Faster at many stores / many sales:
-- 1. Receipt search ("contains") uses a trigram index instead of reading every sale.
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE INDEX IF NOT EXISTS "sales_receipt_no_trgm_idx" ON "sales" USING gin ("receipt_no" gin_trgm_ops);

-- 2. Last sale of each product per store, kept by checkout (Slow movers no longer searches all history).
ALTER TABLE "inventory" ADD COLUMN "last_sold_at" TIMESTAMP(3);
UPDATE "inventory" i SET "last_sold_at" = x.at
  FROM (SELECT s.store_id, si.product_id, max(s.created_at) AS at
          FROM sale_items si JOIN sales s ON s.id = si.sale_id
         WHERE s.status <> 'VOIDED'
         GROUP BY 1, 2) x
 WHERE i.store_id = x.store_id AND i.product_id = x.product_id;

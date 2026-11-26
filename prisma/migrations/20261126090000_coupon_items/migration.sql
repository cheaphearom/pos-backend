-- Coupons for some products or categories only (empty = every item)
ALTER TABLE "coupon_campaigns" ADD COLUMN "product_ids" TEXT[] DEFAULT ARRAY[]::TEXT[];
ALTER TABLE "coupon_campaigns" ADD COLUMN "category_ids" TEXT[] DEFAULT ARRAY[]::TEXT[];

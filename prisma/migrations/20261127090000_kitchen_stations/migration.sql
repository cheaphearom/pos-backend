-- Kitchen tickets per station (Bar, Kitchen…) by category; empty = one kitchen ticket with every item
ALTER TABLE "stores" ADD COLUMN "kitchen_stations" JSONB NOT NULL DEFAULT '[]';

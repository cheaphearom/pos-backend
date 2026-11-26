-- ADMIN role: all stores, store manager rights plus the owner areas a super admin ticks
ALTER TYPE "Role" ADD VALUE IF NOT EXISTS 'ADMIN' AFTER 'SUPER_ADMIN';
ALTER TABLE "users" ADD COLUMN "permissions" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];

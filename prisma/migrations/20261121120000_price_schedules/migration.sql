-- CreateEnum
CREATE TYPE "PriceScheduleStatus" AS ENUM ('PENDING', 'RUNNING', 'DONE', 'FAILED', 'CANCELLED');

-- CreateTable
CREATE TABLE "price_schedules" (
    "id" UUID NOT NULL,
    "run_at" TIMESTAMP(3) NOT NULL,
    "status" "PriceScheduleStatus" NOT NULL DEFAULT 'PENDING',
    "request" JSONB NOT NULL,
    "label" VARCHAR(200) NOT NULL,
    "product_count" INTEGER NOT NULL,
    "created_by_id" UUID NOT NULL,
    "created_by_name" VARCHAR(150) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "started_at" TIMESTAMP(3),
    "applied_at" TIMESTAMP(3),
    "result" JSONB,
    "error" VARCHAR(500),
    "cancelled_by" VARCHAR(150),

    CONSTRAINT "price_schedules_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "price_schedules_status_run_at_idx" ON "price_schedules"("status", "run_at");


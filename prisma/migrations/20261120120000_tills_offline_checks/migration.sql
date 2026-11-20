-- AlterEnum
ALTER TYPE "ApprovalAction" ADD VALUE 'DISCARD_OFFLINE';

-- AlterTable
ALTER TABLE "sales" ADD COLUMN     "offline_seq" INTEGER,
ADD COLUMN     "till_id" UUID;

-- CreateTable
CREATE TABLE "tills" (
    "id" UUID NOT NULL,
    "code" VARCHAR(8) NOT NULL,
    "store_id" UUID NOT NULL,
    "last_user_id" UUID,
    "last_user_name" VARCHAR(150),
    "last_seen_at" TIMESTAMP(3) NOT NULL,
    "issued_seq" INTEGER NOT NULL DEFAULT 0,
    "waiting_seqs" INTEGER[] DEFAULT ARRAY[]::INTEGER[],
    "waiting_total" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "counter_back_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tills_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "offline_discards" (
    "id" UUID NOT NULL,
    "till_id" UUID NOT NULL,
    "store_id" UUID NOT NULL,
    "offline_seq" INTEGER,
    "client_ref" VARCHAR(64) NOT NULL,
    "receipt_no" VARCHAR(40) NOT NULL,
    "total" DECIMAL(14,2) NOT NULL,
    "reason" VARCHAR(200) NOT NULL,
    "user_id" UUID NOT NULL,
    "approved_by_id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "offline_discards_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "tills_store_id_last_seen_at_idx" ON "tills"("store_id", "last_seen_at");

-- CreateIndex
CREATE UNIQUE INDEX "offline_discards_client_ref_key" ON "offline_discards"("client_ref");

-- CreateIndex
CREATE INDEX "offline_discards_store_id_created_at_idx" ON "offline_discards"("store_id", "created_at");

-- CreateIndex
CREATE INDEX "sales_till_id_offline_seq_idx" ON "sales"("till_id", "offline_seq");

-- AddForeignKey
ALTER TABLE "tills" ADD CONSTRAINT "tills_store_id_fkey" FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "offline_discards" ADD CONSTRAINT "offline_discards_till_id_fkey" FOREIGN KEY ("till_id") REFERENCES "tills"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


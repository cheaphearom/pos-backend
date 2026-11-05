-- CreateEnum
CREATE TYPE "WalletCardStatus" AS ENUM ('INACTIVE', 'ACTIVE', 'BLOCKED', 'CLOSED');

-- CreateEnum
CREATE TYPE "WalletTxType" AS ENUM ('TOPUP', 'PAYMENT', 'REFUND', 'ADJUST', 'TRANSFER_IN', 'TRANSFER_OUT');

-- AlterEnum
ALTER TYPE "PaymentMethod" ADD VALUE 'WALLET';

-- CreateTable
CREATE TABLE "wallet_cards" (
    "id" UUID NOT NULL,
    "card_number" VARCHAR(19) NOT NULL,
    "serial_number" VARCHAR(20) NOT NULL,
    "customer_id" UUID,
    "status" "WalletCardStatus" NOT NULL DEFAULT 'INACTIVE',
    "balance" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "pin_hash" TEXT,
    "pin_failures" INTEGER NOT NULL DEFAULT 0,
    "note" TEXT,
    "issued_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "activated_at" TIMESTAMP(3),
    "last_used_at" TIMESTAMP(3),
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "wallet_cards_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "wallet_transactions" (
    "id" BIGSERIAL NOT NULL,
    "card_id" UUID NOT NULL,
    "type" "WalletTxType" NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,
    "balance_after" DECIMAL(14,2) NOT NULL,
    "method" "PaymentMethod",
    "reference" VARCHAR(100),
    "client_ref" VARCHAR(64),
    "sale_id" UUID,
    "store_id" UUID,
    "shift_id" UUID,
    "user_id" UUID,
    "note" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "wallet_transactions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "wallet_cards_card_number_key" ON "wallet_cards"("card_number");

-- CreateIndex
CREATE UNIQUE INDEX "wallet_cards_serial_number_key" ON "wallet_cards"("serial_number");

-- CreateIndex
CREATE INDEX "wallet_cards_customer_id_idx" ON "wallet_cards"("customer_id");

-- CreateIndex
CREATE INDEX "wallet_cards_status_idx" ON "wallet_cards"("status");

-- CreateIndex
CREATE UNIQUE INDEX "wallet_transactions_client_ref_key" ON "wallet_transactions"("client_ref");

-- CreateIndex
CREATE INDEX "wallet_transactions_card_id_created_at_idx" ON "wallet_transactions"("card_id", "created_at");

-- CreateIndex
CREATE INDEX "wallet_transactions_store_id_created_at_idx" ON "wallet_transactions"("store_id", "created_at");

-- CreateIndex
CREATE INDEX "wallet_transactions_shift_id_idx" ON "wallet_transactions"("shift_id");

-- AddForeignKey
ALTER TABLE "wallet_cards" ADD CONSTRAINT "wallet_cards_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "wallet_transactions" ADD CONSTRAINT "wallet_transactions_card_id_fkey" FOREIGN KEY ("card_id") REFERENCES "wallet_cards"("id") ON DELETE CASCADE ON UPDATE CASCADE;

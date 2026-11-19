-- Printing after each sale: automatic printing and which slips (customer receipt, cashier copy, kitchen ticket).
ALTER TABLE "stores" ADD COLUMN "print_auto" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN "print_customer" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN "print_cashier_copy" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN "print_kitchen" BOOLEAN NOT NULL DEFAULT false;

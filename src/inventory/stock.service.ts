import { BadRequestException, Injectable } from '@nestjs/common';
import { Prisma, StockMovementType } from '@prisma/client';
import { config } from '../config';

export interface MovementInput {
  storeId: string;
  productId: string;
  /** Positive = stock in, negative = stock out */
  delta: Prisma.Decimal | number | string;
  type: StockMovementType;
  referenceType?: string;
  referenceId?: string;
  note?: string;
  userId?: string | null;
  /** Default: ALLOW_NEGATIVE_STOCK setting */
  allowNegative?: boolean;
}

export interface MovementResult {
  storeId: string;
  productId: string;
  balanceAfter: Prisma.Decimal;
  /** true when this movement pushed stock to or below the reorder level */
  becameLow: boolean;
}

/**
 * The ONLY place that changes stock. Must be called inside a transaction.
 * Uses one atomic UPDATE so two cashiers selling the last item at the same time
 * can never both succeed (the row is locked and the check is done in SQL).
 */
@Injectable()
export class StockService {
  async apply(tx: Prisma.TransactionClient, m: MovementInput): Promise<MovementResult> {
    const delta = new Prisma.Decimal(m.delta);
    if (delta.isZero()) throw new BadRequestException('Stock change cannot be zero');
    const allowNegative = m.allowNegative ?? config.allowNegativeStock;

    // Make sure the inventory row exists (first time this product is stocked in this store).
    await tx.$executeRaw`
      INSERT INTO inventory (id, store_id, product_id, quantity, updated_at)
      VALUES (gen_random_uuid(), ${m.storeId}::uuid, ${m.productId}::uuid, 0, now())
      ON CONFLICT (store_id, product_id) DO NOTHING`;

    const rows = await tx.$queryRaw<{ quantity: Prisma.Decimal; reorder_level: Prisma.Decimal }[]>`
      UPDATE inventory
         SET quantity = quantity + ${delta}::numeric, updated_at = now()
       WHERE store_id = ${m.storeId}::uuid AND product_id = ${m.productId}::uuid
         AND (${allowNegative}::boolean OR ${delta}::numeric >= 0 OR quantity + ${delta}::numeric >= 0)
       RETURNING quantity, reorder_level`;

    if (!rows.length) {
      const product = await tx.product.findUnique({ where: { id: m.productId }, select: { name: true, sku: true } });
      const inv = await tx.inventory.findUnique({
        where: { storeId_productId: { storeId: m.storeId, productId: m.productId } },
        select: { quantity: true },
      });
      throw new BadRequestException(
        `Not enough stock for ${product?.name ?? m.productId} (${product?.sku}): available ${inv?.quantity ?? 0}, needed ${delta.abs()}`,
      );
    }

    const balanceAfter = new Prisma.Decimal(rows[0].quantity);
    const reorder = new Prisma.Decimal(rows[0].reorder_level);
    await tx.stockMovement.create({
      data: {
        storeId: m.storeId,
        productId: m.productId,
        type: m.type,
        quantity: delta,
        balanceAfter,
        referenceType: m.referenceType,
        referenceId: m.referenceId,
        note: m.note,
        userId: m.userId ?? null,
      },
    });
    const before = balanceAfter.minus(delta);
    return {
      storeId: m.storeId,
      productId: m.productId,
      balanceAfter,
      becameLow: reorder.gt(0) && balanceAfter.lte(reorder) && before.gt(reorder),
    };
  }
}

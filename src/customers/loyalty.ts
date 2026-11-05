import { BadRequestException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { config } from '../config';

/** Points earned for an amount paid (rounded down). */
export function pointsForAmount(amount: Prisma.Decimal): number {
  return amount.mul(config.loyaltyEarnRate).floor().toNumber();
}

/** Money value of points when redeemed. */
export function valueOfPoints(points: number): Prisma.Decimal {
  return new Prisma.Decimal(points).mul(config.loyaltyPointValue).toDecimalPlaces(2, Prisma.Decimal.ROUND_DOWN);
}

/** Change a customer's points balance atomically and record it. Fails if the balance would go negative. */
export async function changePoints(
  tx: Prisma.TransactionClient,
  customerId: string,
  points: number,
  type: 'EARN' | 'REDEEM' | 'REVERSE' | 'RETURN' | 'ADJUST',
  saleId?: string,
  note?: string,
): Promise<number> {
  if (points === 0) return (await tx.customer.findUniqueOrThrow({ where: { id: customerId } })).points;
  const rows = await tx.$queryRaw<{ points: number }[]>`
    UPDATE customers SET points = points + ${points}::int, updated_at = now()
     WHERE id = ${customerId}::uuid AND points + ${points}::int >= 0
     RETURNING points`;
  if (!rows.length) {
    const c = await tx.customer.findUniqueOrThrow({ where: { id: customerId }, select: { points: true } });
    throw new BadRequestException(`Customer has only ${c.points} points`);
  }
  await tx.loyaltyTransaction.create({
    data: { customerId, type, points, balanceAfter: rows[0].points, saleId, note },
  });
  return rows[0].points;
}

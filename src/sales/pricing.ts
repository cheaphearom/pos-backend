import { Prisma } from '@prisma/client';

const D = (v: Prisma.Decimal.Value) => new Prisma.Decimal(v);
const r2 = (d: Prisma.Decimal) => d.toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP);

export interface PriceLineInput {
  unitPrice: Prisma.Decimal.Value;
  quantity: Prisma.Decimal.Value;
  /** Discount amount for this line */
  discount?: Prisma.Decimal.Value;
  taxable: boolean;
}

export interface PricedLine {
  gross: Prisma.Decimal; // qty * price
  discount: Prisma.Decimal; // line discount + share of sale discount
  net: Prisma.Decimal; // gross - discount
  taxRate: Prisma.Decimal;
  tax: Prisma.Decimal;
  total: Prisma.Decimal; // net + tax
}

export interface PricedSale {
  lines: PricedLine[];
  subtotal: Prisma.Decimal;
  discountTotal: Prisma.Decimal;
  taxTotal: Prisma.Decimal;
  total: Prisma.Decimal;
}

export class PricingError extends Error {}

/**
 * Pure price calculation (no database) so it is easy to test.
 * - Line discounts are applied first.
 * - A sale-level discount (amount or percent) is shared across lines in proportion
 *   to their value, so tax stays correct. The last line takes any rounding remainder.
 * - Tax is added on top of the discounted amount (tax-exclusive prices).
 */
export function priceSale(
  inputs: PriceLineInput[],
  taxRate: Prisma.Decimal.Value,
  saleDiscount: { amount?: Prisma.Decimal.Value; percent?: Prisma.Decimal.Value } = {},
): PricedSale {
  if (!inputs.length) throw new PricingError('A sale needs at least one item');
  const rate = D(taxRate);

  const afterLine = inputs.map((i, idx) => {
    const gross = r2(D(i.unitPrice).mul(i.quantity));
    const disc = r2(D(i.discount ?? 0));
    if (disc.isNegative() || disc.gt(gross)) throw new PricingError(`Item ${idx + 1}: discount must be between 0 and ${gross}`);
    return { gross, lineDisc: disc, value: gross.minus(disc) };
  });

  const base = afterLine.reduce((s, l) => s.plus(l.value), D(0));
  let saleDisc = D(0);
  if (saleDiscount.percent !== undefined) {
    const pct = D(saleDiscount.percent);
    if (pct.isNegative() || pct.gt(100)) throw new PricingError('Discount percent must be between 0 and 100');
    saleDisc = r2(base.mul(pct).div(100));
  }
  if (saleDiscount.amount !== undefined) saleDisc = saleDisc.plus(r2(D(saleDiscount.amount)));
  if (saleDisc.isNegative() || saleDisc.gt(base)) throw new PricingError(`Sale discount must be between 0 and ${base}`);

  // Share the sale discount across lines by value.
  let remaining = saleDisc;
  const lastWithValue = afterLine.map((l) => l.value.gt(0)).lastIndexOf(true);
  const lines: PricedLine[] = afterLine.map((l, idx) => {
    let share = D(0);
    if (saleDisc.gt(0) && l.value.gt(0)) {
      share = idx === lastWithValue ? remaining : r2(saleDisc.mul(l.value).div(base));
      if (share.gt(l.value)) share = l.value;
      remaining = remaining.minus(share);
    }
    const net = l.value.minus(share);
    const lineRate = inputs[idx].taxable ? rate : D(0);
    const tax = r2(net.mul(lineRate));
    return { gross: l.gross, discount: l.lineDisc.plus(share), net, taxRate: lineRate, tax, total: net.plus(tax) };
  });

  const sum = (k: keyof PricedLine) => lines.reduce((s, l) => s.plus(l[k]), D(0));
  return { lines, subtotal: sum('gross'), discountTotal: sum('discount'), taxTotal: sum('tax'), total: sum('total') };
}

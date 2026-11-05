/**
 * Coupon discount. PURE (no imports): used by the API and, through a Vite alias, by the POS,
 * so the total on screen is exactly what the server charges.
 *
 * `base` = the sale value after line discounts and promotions, before tax.
 * Returns the discount amount in currency units, or an error message.
 */
export interface CouponRule {
  name: string;
  type: 'PERCENT' | 'AMOUNT';
  value: number | string;
  minSpend: number | string;
  maxDiscount?: number | string | null;
}

const cents = (v: number | string) => Math.round(Number(v) * 100);
const divRound = (a: number, b: number) => Math.floor((2 * a + b) / (2 * b));

export function couponDiscount(rule: CouponRule, base: number): { discount: number; error?: string } {
  const b = cents(base);
  const min = cents(rule.minSpend ?? 0);
  if (b < min) return { discount: 0, error: `Spend at least ${(min / 100).toFixed(2)} to use this coupon` };
  let d: number;
  if (rule.type === 'PERCENT') {
    d = divRound(b * Math.round(Number(rule.value) * 100), 10000);
    if (rule.maxDiscount != null && rule.maxDiscount !== '') d = Math.min(d, cents(rule.maxDiscount));
  } else {
    d = cents(rule.value);
  }
  return { discount: Math.min(d, b) / 100 };
}

export const describeCoupon = (r: Pick<CouponRule, 'type' | 'value' | 'minSpend' | 'maxDiscount'>) =>
  (r.type === 'PERCENT' ? `${Number(r.value)}% off` : `${Number(r.value).toFixed(2)} off`) +
  (Number(r.minSpend) > 0 ? ` when you spend ${Number(r.minSpend).toFixed(2)}` : '') +
  (r.type === 'PERCENT' && r.maxDiscount != null && r.maxDiscount !== '' ? ` (max ${Number(r.maxDiscount).toFixed(2)})` : '');

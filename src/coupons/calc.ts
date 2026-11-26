// Copyright (c) 2026 Chea Phearom. All rights reserved.
// Proprietary and confidential: see the LICENSE file.
/*
 * SHARED WITH THE FRONTEND: pos-frontend keeps an identical copy in src/shared/coupons.ts.
 * Change both files together (pos-frontend: `npm run check:shared`), otherwise offline till totals
 * will not match the server.
 */
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
  /** Only these products and categories (with their sub-categories). Both empty = every item. */
  productIds?: string[] | null;
  categoryIds?: string[] | null;
}

/** One sale line for a coupon: `net` = its value after line discounts and promotions, before tax. */
export interface CouponLine {
  productId: string;
  categoryId?: string | null;
  net: number | string;
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

/** True when the coupon is only for some products or categories. */
export const couponLimited = (r: Pick<CouponRule, 'productIds' | 'categoryIds'>) => !!(r.productIds?.length || r.categoryIds?.length);

/** The line can use the coupon (always, when the coupon is for every item). */
export const couponFits = (r: Pick<CouponRule, 'productIds' | 'categoryIds'>, l: Pick<CouponLine, 'productId' | 'categoryId'>) =>
  !couponLimited(r) || !!r.productIds?.includes(l.productId) || (!!l.categoryId && !!r.categoryIds?.includes(l.categoryId));

/**
 * Coupon on a sale's lines. A coupon for some products or categories counts only those lines, for the minimum
 * spend too; `categoryIds` must already include the sub-categories.
 */
export function couponForLines(rule: CouponRule, lines: CouponLine[]): { discount: number; base: number; error?: string } {
  const fit = lines.filter((l) => couponFits(rule, l));
  const base = fit.reduce((t, l) => t + cents(l.net), 0) / 100;
  if (couponLimited(rule) && !fit.length) return { discount: 0, base: 0, error: 'None of the items in this sale can use this coupon' };
  const r = couponDiscount(rule, base);
  if (r.error && couponLimited(rule)) {
    return { discount: 0, base, error: `Spend at least ${(cents(rule.minSpend ?? 0) / 100).toFixed(2)} on the coupon's items to use this coupon` };
  }
  return { ...r, base };
}

export const describeCoupon = (r: Pick<CouponRule, 'type' | 'value' | 'minSpend' | 'maxDiscount' | 'productIds' | 'categoryIds'>) =>
  (r.type === 'PERCENT' ? `${Number(r.value)}% off` : `${Number(r.value).toFixed(2)} off`) +
  (Number(r.minSpend) > 0 ? ` when you spend ${Number(r.minSpend).toFixed(2)}` : '') +
  (r.type === 'PERCENT' && r.maxDiscount != null && r.maxDiscount !== '' ? ` (max ${Number(r.maxDiscount).toFixed(2)})` : '') +
  (couponLimited(r) ? ' · selected items only' : '');

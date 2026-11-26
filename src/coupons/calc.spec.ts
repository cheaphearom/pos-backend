// Copyright (c) 2026 Chea Phearom. All rights reserved.
// Proprietary and confidential: see the LICENSE file.
import { couponDiscount, couponForLines, describeCoupon } from './calc';

describe('coupon discount', () => {
  it('percent with cap and minimum spend', () => {
    const r = { name: 'x', type: 'PERCENT' as const, value: 10, minSpend: 20, maxDiscount: 3 };
    expect(couponDiscount(r, 19.99).error).toMatch(/at least 20.00/);
    expect(couponDiscount(r, 25).discount).toBe(2.5);
    expect(couponDiscount(r, 100).discount).toBe(3);
  });
  it('amount never more than the sale', () => {
    expect(couponDiscount({ name: 'x', type: 'AMOUNT', value: 5, minSpend: 0 }, 3.2).discount).toBe(3.2);
    expect(couponDiscount({ name: 'x', type: 'AMOUNT', value: 5, minSpend: 0 }, 12).discount).toBe(5);
  });
  it('rounds half up in cents', () => {
    expect(couponDiscount({ name: 'x', type: 'PERCENT', value: 15, minSpend: 0 }, 3.3).discount).toBe(0.5); // 0.495
  });

  describe('for some products or categories', () => {
    const lines = [
      { productId: 'latte', categoryId: 'coffee', net: 3 },
      { productId: 'croissant', categoryId: 'bakery', net: 1.5 },
      { productId: 'water', categoryId: null, net: 0.5 },
    ];
    const rule = { name: 'x', type: 'PERCENT' as const, value: 50, minSpend: 0 };
    it('every item when no products or categories are chosen', () => {
      expect(couponForLines(rule, lines)).toEqual({ discount: 2.5, base: 5 });
    });
    it('only the chosen categories', () => {
      expect(couponForLines({ ...rule, categoryIds: ['coffee'] }, lines)).toEqual({ discount: 1.5, base: 3 });
    });
    it('chosen products and categories together', () => {
      expect(couponForLines({ ...rule, categoryIds: ['coffee'], productIds: ['water'] }, lines)).toEqual({ discount: 1.75, base: 3.5 });
    });
    it('an amount off never more than the chosen items', () => {
      expect(couponForLines({ ...rule, type: 'AMOUNT', value: 5, productIds: ['croissant'] }, lines).discount).toBe(1.5);
    });
    it('minimum spend counts only the chosen items', () => {
      const r = couponForLines({ ...rule, minSpend: 4, categoryIds: ['coffee'] }, lines);
      expect(r.discount).toBe(0);
      expect(r.error).toMatch(/at least 4.00 on the coupon's items/);
    });
    it('none of the items fit', () => {
      expect(couponForLines({ ...rule, productIds: ['tea'] }, lines).error).toMatch(/None of the items/);
    });
    it('describes the limit', () => {
      expect(describeCoupon({ ...rule, categoryIds: ['coffee'] })).toBe('50% off · selected items only');
    });
  });
});

import { couponDiscount } from './calc';

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
});

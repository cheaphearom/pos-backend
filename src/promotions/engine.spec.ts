import { applyPromotions, isPromoActive, PromoRule } from './engine';

const base: PromoRule = {
  id: 'p1', name: 'Promo', type: 'PERCENT_OFF', value: 10, allProducts: false, productIds: ['a'], categoryIds: [],
  storeIds: [], daysOfWeek: [], priority: 0, isActive: true,
};
const TZ = 'Asia/Phnom_Penh'; // UTC+7
const at = new Date('2026-11-06T05:30:00Z'); // Friday 12:30 local
const line = (productId: string, price: number, quantity: number, categoryId: string | null = null) => ({ productId, price, quantity, categoryId });

describe('promotion engine', () => {
  it('percent off a product', () => {
    const r = applyPromotions([line('a', 2.5, 3), line('b', 1, 1)], [base], 's1', at, TZ);
    expect(r[0]).toEqual({ promotionId: 'p1', name: 'Promo', discount: 0.75 });
    expect(r[1].discount).toBe(0);
  });

  it('amount off each unit, never more than the price', () => {
    const r = applyPromotions([line('a', 0.3, 2)], [{ ...base, type: 'AMOUNT_OFF', value: 0.5 }], 's1', at, TZ);
    expect(r[0].discount).toBe(0.6);
  });

  it('buy 2 get 1 across lines of the same product', () => {
    const rule: PromoRule = { ...base, type: 'BUY_X_GET_Y', buyQty: 2, getQty: 1 };
    expect(applyPromotions([line('a', 1, 2), line('a', 1, 5)], [rule], 's1', at, TZ).reduce((s, x) => s + x.discount, 0)).toBe(2); // 7 units -> 2 free
    expect(applyPromotions([line('a', 1, 2)], [rule], 's1', at, TZ)[0].discount).toBe(0);
  });

  it('matches by category and all products', () => {
    expect(applyPromotions([line('x', 10, 1, 'cat')], [{ ...base, productIds: [], categoryIds: ['cat'] }], 's1', at, TZ)[0].discount).toBe(1);
    expect(applyPromotions([line('x', 10, 1)], [{ ...base, productIds: [], allProducts: true }], 's1', at, TZ)[0].discount).toBe(1);
  });

  it('picks the biggest saving, one promotion per line', () => {
    const r = applyPromotions([line('a', 10, 1)], [base, { ...base, id: 'p2', name: 'Big', value: 25 }], 's1', at, TZ);
    expect(r[0]).toEqual({ promotionId: 'p2', name: 'Big', discount: 2.5 });
  });

  it('respects stores, dates, weekdays and happy hours (store time zone)', () => {
    expect(isPromoActive({ ...base, storeIds: ['s2'] }, 's1', at, TZ)).toBe(false);
    expect(isPromoActive({ ...base, endsAt: '2026-11-06T05:00:00Z' }, 's1', at, TZ)).toBe(false);
    expect(isPromoActive({ ...base, startsAt: '2026-11-07T00:00:00Z' }, 's1', at, TZ)).toBe(false);
    expect(isPromoActive({ ...base, daysOfWeek: [5] }, 's1', at, TZ)).toBe(true); // Friday
    expect(isPromoActive({ ...base, daysOfWeek: [0, 6] }, 's1', at, TZ)).toBe(false);
    expect(isPromoActive({ ...base, startMinute: 12 * 60, endMinute: 13 * 60 }, 's1', at, TZ)).toBe(true); // 12:30 local
    expect(isPromoActive({ ...base, startMinute: 14 * 60, endMinute: 16 * 60 }, 's1', at, TZ)).toBe(false);
    expect(isPromoActive({ ...base, startMinute: 22 * 60, endMinute: 2 * 60 }, 's1', new Date('2026-11-06T16:30:00Z'), TZ)).toBe(true); // 23:30 local, wraps
    expect(isPromoActive({ ...base, isActive: false }, 's1', at, TZ)).toBe(false);
  });

  it('handles fractional quantities (kg)', () => {
    expect(applyPromotions([line('a', 4.99, 0.755)], [base], 's1', at, TZ)[0].discount).toBe(0.38); // 3.77 * 10%
    // buy X get Y counts only whole units
    expect(applyPromotions([line('a', 2, 2.9)], [{ ...base, type: 'BUY_X_GET_Y', buyQty: 1, getQty: 1 }], 's1', at, TZ)[0].discount).toBe(2);
  });
});

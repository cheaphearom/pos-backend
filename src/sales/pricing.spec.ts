import { priceSale, PricingError } from './pricing';

const s = (d: { toFixed: (n: number) => string }) => d.toFixed(2);

describe('priceSale', () => {
  it('adds tax on taxable lines only', () => {
    const r = priceSale(
      [
        { unitPrice: '2.50', quantity: 2, taxable: true }, // 5.00 -> tax 0.50
        { unitPrice: '3.00', quantity: 1, taxable: false }, // 3.00 -> no tax
      ],
      '0.10',
    );
    expect(s(r.subtotal)).toBe('8.00');
    expect(s(r.taxTotal)).toBe('0.50');
    expect(s(r.total)).toBe('8.50');
  });

  it('applies line discounts before tax', () => {
    const r = priceSale([{ unitPrice: 10, quantity: 1, discount: 2, taxable: true }], 0.1);
    expect(s(r.lines[0].net)).toBe('8.00');
    expect(s(r.taxTotal)).toBe('0.80');
    expect(s(r.total)).toBe('8.80');
  });

  it('spreads a sale discount across lines and keeps the exact sum', () => {
    const r = priceSale(
      [
        { unitPrice: '1.00', quantity: 1, taxable: true },
        { unitPrice: '1.00', quantity: 1, taxable: true },
        { unitPrice: '1.00', quantity: 1, taxable: true },
      ],
      0,
      { amount: '1.00' },
    );
    expect(r.lines.map((l) => s(l.discount))).toEqual(['0.33', '0.33', '0.34']);
    expect(s(r.discountTotal)).toBe('1.00');
    expect(s(r.total)).toBe('2.00');
  });

  it('supports a percent discount', () => {
    const r = priceSale([{ unitPrice: 20, quantity: 1, taxable: false }], 0, { percent: 10 });
    expect(s(r.total)).toBe('18.00');
  });

  it('handles fractional quantities (sold by weight)', () => {
    const r = priceSale([{ unitPrice: '4.99', quantity: '0.755', taxable: false }], 0);
    expect(s(r.total)).toBe('3.77');
  });

  it('rejects discounts larger than the price', () => {
    expect(() => priceSale([{ unitPrice: 5, quantity: 1, discount: 6, taxable: true }], 0)).toThrow(PricingError);
    expect(() => priceSale([{ unitPrice: 5, quantity: 1, taxable: true }], 0, { amount: 6 })).toThrow(PricingError);
  });

  it('rejects an empty sale', () => {
    expect(() => priceSale([], 0)).toThrow(PricingError);
  });
});

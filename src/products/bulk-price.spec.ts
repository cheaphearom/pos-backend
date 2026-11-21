// Copyright (c) 2026 Chea Phearom. All rights reserved.
// Proprietary and confidential: see the LICENSE file.
import { changePrice, roundTo } from './products.service';

describe('bulk price change', () => {
  it('percent, amount and set', () => {
    expect(changePrice(2.3, { type: 'PERCENT', value: 10 })).toBe(2.53);
    expect(changePrice(2.3, { type: 'PERCENT', value: -10 })).toBe(2.07);
    expect(changePrice(1.8, { type: 'AMOUNT', value: 0.25 })).toBe(2.05);
    expect(changePrice(1.8, { type: 'AMOUNT', value: -0.3 })).toBe(1.5);
    expect(changePrice(9.99, { type: 'SET', value: 1.5 })).toBe(1.5);
  });

  it('rounds to the nearest step', () => {
    expect(changePrice(2.3, { type: 'PERCENT', value: 10 }, 0.05)).toBe(2.55);
    expect(roundTo(2.53, 0.1)).toBe(2.5);
    expect(roundTo(2.63, 0.25)).toBe(2.75);
    expect(roundTo(2.6249, 0.25)).toBe(2.5);
    expect(roundTo(1.25)).toBe(1.25);
  });
});

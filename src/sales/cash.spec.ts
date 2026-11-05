import { khrToUsd, splitChange, usdToKhr, usdToKhrUp } from './cash';

describe('dual currency cash', () => {
  it('converts riel to dollars to the cent', () => {
    expect(khrToUsd(12000, 4100)).toBe(2.93);
    expect(khrToUsd(4100, 4100)).toBe(1);
  });
  it('asks riel rounded up to 100 so the customer never pays less', () => {
    expect(usdToKhrUp(2.77, 4100)).toBe(11400); // 11357 → 11400
    expect(usdToKhrUp(1, 4100)).toBe(4100);
    expect(khrToUsd(usdToKhrUp(2.77, 4100), 4100)).toBeGreaterThanOrEqual(2.77);
  });
  it('rounds riel to the nearest 100', () => {
    expect(usdToKhr(0.16, 4100)).toBe(700); // 656
    expect(usdToKhr(0.01, 4100)).toBe(0); // 41
  });
  it('gives change in whole dollars plus riel', () => {
    expect(splitChange(7.23, 4100)).toEqual({ usd: 7, khr: 900 }); // 0.23 × 4100 = 943
    expect(splitChange(7.23, 4100, 'KHR')).toEqual({ usd: 0, khr: 29600 });
    expect(splitChange(7.23, 4100, 'USD')).toEqual({ usd: 7.23, khr: 0 });
    expect(splitChange(5, 4100)).toEqual({ usd: 5, khr: 0 });
    expect(splitChange(0.5, null)).toEqual({ usd: 0.5, khr: 0 });
    expect(splitChange(0, 4100)).toEqual({ usd: 0, khr: 0 });
  });
});

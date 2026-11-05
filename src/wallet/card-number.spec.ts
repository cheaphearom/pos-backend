import { isValidCardNumber, luhnDigit, newCardNumber, newSerial, sameSerial } from './card-number';

describe('wallet card numbers', () => {
  it('Luhn matches known numbers', () => {
    expect(luhnDigit('7992739871')).toBe('3'); // classic example 79927398713
    expect(isValidCardNumber('4539578763621486')).toBe(true);
    expect(isValidCardNumber('4539578763621487')).toBe(false);
  });
  it('generates valid 16-digit numbers with the prefix', () => {
    for (let i = 0; i < 200; i++) {
      const n = newCardNumber('8899');
      expect(n).toHaveLength(16);
      expect(n.startsWith('8899')).toBe(true);
      expect(isValidCardNumber(n)).toBe(true);
    }
  });
  it('serials are readable and compared loosely', () => {
    expect(newSerial()).toMatch(/^[A-HJKMNP-Z2-9]{5}-[A-HJKMNP-Z2-9]{5}$/);
    expect(sameSerial('abcde-fghjk', 'ABCDE FGHJK')).toBe(true);
  });
});

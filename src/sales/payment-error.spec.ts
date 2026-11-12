import { PAYMENT_ERROR } from './sales.service';

describe('payment_failed vs sale_failed', () => {
  it.each([
    'Wrong PIN (4 tries left)', 'Wallet balance is 3.44, not enough for 5.39', 'This KHQR has not been paid yet',
    'Voucher balance is 4.61, not enough for 5.39', 'Payment 0.1 is less than amount due 0.39', 'This card needs its PIN',
    'Riel cash must be in steps of 100', 'The exchange rate is now 4100 riel per dollar; enter the riel again',
  ])('payment: %s', (m) => expect(PAYMENT_ERROR.test(m)).toBe(true));

  it.each([
    'A manager PIN is needed for this discount', 'Not enough stock for Latte (SKU-1): available 0, needed 1',
    'This coupon code has already been used', 'This online order was already paid or cancelled', 'Choose Size for Latte',
  ])('not payment: %s', (m) => expect(PAYMENT_ERROR.test(m)).toBe(false));
});

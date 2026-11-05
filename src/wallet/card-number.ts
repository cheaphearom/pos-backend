import { randomInt } from 'crypto';

/** Luhn check digit (the same check bank cards use, so typos are caught). */
export function luhnDigit(body: string): string {
  let sum = 0;
  for (let i = 0; i < body.length; i++) {
    let d = Number(body[body.length - 1 - i]);
    if (i % 2 === 0) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
  }
  return String((10 - (sum % 10)) % 10);
}

export const isValidCardNumber = (n: string) => /^\d{12,19}$/.test(n) && luhnDigit(n.slice(0, -1)) === n.slice(-1);

/** 16-digit card number: prefix + random digits + Luhn check digit. */
export function newCardNumber(prefix: string): string {
  let body = prefix;
  while (body.length < 15) body += String(randomInt(10));
  return body + luhnDigit(body);
}

// No 0/O, 1/I/L, so serials are easy to read off a card.
const SERIAL_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export function newSerial(): string {
  let s = '';
  for (let i = 0; i < 10; i++) s += SERIAL_CHARS[randomInt(SERIAL_CHARS.length)];
  return `${s.slice(0, 5)}-${s.slice(5)}`;
}

/** Compare serials ignoring case, spaces and dashes. */
export const sameSerial = (a: string, b: string) => a.replace(/[\s-]/g, '').toUpperCase() === b.replace(/[\s-]/g, '').toUpperCase();

/** Random readable code (no 0/O/1/I/L), for coupons and vouchers. */
export function randomCode(length: number): string {
  let s = '';
  for (let i = 0; i < length; i++) s += SERIAL_CHARS[randomInt(SERIAL_CHARS.length)];
  return s;
}

/**
 * KHQR (Cambodia's national QR payment standard, by the National Bank of Cambodia / Bakong).
 * KHQR is EMVCo "merchant presented QR": a list of TAG(2) LENGTH(2) VALUE fields
 * ending with a CRC16-CCITT checksum. Field layout follows the official KHQR SDK.
 */
import { createHash } from 'crypto';

export const KHQR_CURRENCY = { USD: '840', KHR: '116' } as const;

export interface KhqrInput {
  /** Bakong account id, e.g. "myshop@aclb" (max 32) */
  accountId: string;
  /** Max 25 characters */
  merchantName: string;
  /** Max 15 characters */
  merchantCity?: string;
  /** Set for merchant accounts (tag 30); leave empty for individual accounts (tag 29) */
  merchantId?: string | null;
  /** Acquiring bank name */
  acquiringBank?: string | null;
  currency: 'USD' | 'KHR';
  /** Omit or 0 for a static QR (customer types the amount) */
  amount?: number;
  billNumber?: string;
  storeLabel?: string;
  terminalLabel?: string;
  mobileNumber?: string;
  /** Required for dynamic QR (with amount): epoch milliseconds */
  expiresAt?: number;
  createdAt?: number;
  merchantCategoryCode?: string;
}

export class KhqrError extends Error {}

const tlv = (tag: string, value: string) => {
  if (value.length > 99) throw new KhqrError(`Field ${tag} is too long`);
  return tag + String(value.length).padStart(2, '0') + value;
};

const limit = (name: string, v: string | undefined | null, max: number) => {
  if (v && v.length > max) throw new KhqrError(`${name} must be at most ${max} characters`);
};

/** CRC16-CCITT (poly 0x1021, init 0xFFFF), hex upper case, as used by EMVCo QR. */
export function crc16(input: string): string {
  let crc = 0xffff;
  for (const byte of Buffer.from(input, 'utf8')) {
    crc ^= byte << 8;
    for (let i = 0; i < 8; i++) crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
  }
  return crc.toString(16).toUpperCase().padStart(4, '0');
}

export function generateKhqr(i: KhqrInput): { qr: string; md5: string } {
  if (!i.accountId) throw new KhqrError('Bakong account id is required');
  if (!i.merchantName) throw new KhqrError('Merchant name is required');
  limit('Bakong account id', i.accountId, 32);
  limit('Merchant name', i.merchantName, 25);
  limit('Merchant city', i.merchantCity, 15);
  limit('Merchant id', i.merchantId, 32);
  limit('Acquiring bank', i.acquiringBank, 32);
  for (const [n, v] of [['Bill number', i.billNumber], ['Store label', i.storeLabel], ['Terminal label', i.terminalLabel], ['Mobile number', i.mobileNumber]] as const) limit(n, v, 25);

  const dynamic = !!i.amount && i.amount > 0;
  let account = tlv('00', i.accountId);
  const isMerchant = !!i.merchantId;
  if (isMerchant) account += tlv('01', i.merchantId!);
  if (i.acquiringBank) account += tlv('02', i.acquiringBank);

  let out = tlv('00', '01') + tlv('01', dynamic ? '12' : '11') + tlv(isMerchant ? '30' : '29', account);
  out += tlv('52', i.merchantCategoryCode ?? '5999');
  out += tlv('53', KHQR_CURRENCY[i.currency]);

  if (dynamic) {
    let amount: string;
    if (i.currency === 'KHR') {
      if (!Number.isInteger(i.amount)) throw new KhqrError('KHR amount must be a whole number');
      amount = String(i.amount);
    } else {
      amount = Number.isInteger(i.amount) ? String(i.amount) : i.amount!.toFixed(2);
      if (Math.abs(Number(amount) - i.amount!) > 1e-9) throw new KhqrError('USD amount can have at most 2 decimals');
    }
    if (amount.length > 13) throw new KhqrError('Amount is too large');
    out += tlv('54', amount);
  }

  out += tlv('58', 'KH') + tlv('59', i.merchantName) + tlv('60', i.merchantCity || 'Phnom Penh');

  let extra = '';
  if (i.billNumber) extra += tlv('01', i.billNumber);
  if (i.mobileNumber) extra += tlv('02', i.mobileNumber);
  if (i.storeLabel) extra += tlv('03', i.storeLabel);
  if (i.terminalLabel) extra += tlv('07', i.terminalLabel);
  if (extra) out += tlv('62', extra);

  if (dynamic) {
    const created = i.createdAt ?? Date.now();
    if (!i.expiresAt) throw new KhqrError('A QR with an amount needs an expiry time');
    if (i.expiresAt <= created) throw new KhqrError('Expiry must be in the future');
    out += tlv('99', tlv('00', String(created)) + tlv('01', String(i.expiresAt)));
  }

  out += '6304';
  const qr = out + crc16(out);
  return { qr, md5: createHash('md5').update(qr).digest('hex') };
}

/** Parse TLV fields (one level). Throws on malformed input. */
export function parseTlv(s: string): Record<string, string> {
  const out: Record<string, string> = {};
  let i = 0;
  while (i < s.length) {
    const tag = s.slice(i, i + 2);
    const len = Number(s.slice(i + 2, i + 4));
    if (!/^\d{2}$/.test(tag) || Number.isNaN(len) || i + 4 + len > s.length) throw new KhqrError('Malformed KHQR');
    out[tag] = s.slice(i + 4, i + 4 + len);
    i += 4 + len;
  }
  return out;
}

/** CRC is correct and the structure parses. */
export function verifyKhqr(qr: string): boolean {
  if (!/6304[0-9A-Fa-f]{4}$/.test(qr)) return false;
  if (crc16(qr.slice(0, -4)) !== qr.slice(-4).toUpperCase()) return false;
  try {
    const f = parseTlv(qr);
    return f['00'] === '01' && ('29' in f || '30' in f) && f['58'] === 'KH';
  } catch {
    return false;
  }
}

import { crc16, generateKhqr, parseTlv, verifyKhqr } from './khqr';

/** Valid KHQR strings from the official bakong-khqr SDK "valid" test suite. */
const SAMPLES = [
  '00020101021229180014jonhsmith@nbcq520459995303116540750000.05802KH5910Jonh Smith6010Phnom Penh6215021185512345678' + '9917001316257134678276304A96B',
  '00020101021229180014jonhsmith@nbcq52045999530384054031.05802KH5910Jonh Smith6010PHNOM PENH62210117INV-2021-07-65822' + '991700131625713467827630451CF',
  '00020101021230400014jonhsmith@devb01061234560208Dev Bank520459995303840540410.05802KH5910Jonh Smith6010Phnom Penh62360117INV-2021-07-65822021185512345678' + '9917001316257134678276304ED60',
];

/** Expected output of the official SDK (everything before the timestamp field), from its generate tests. */
const SDK_CASES: [string, Parameters<typeof generateKhqr>[0], string][] = [
  ['USD with bill number', { accountId: 'jonhsmith@nbcq', merchantName: 'Jonh Smith', merchantCity: 'PHNOM PENH', currency: 'USD', amount: 1, billNumber: 'INV-2021-07-65822' },
    '00020101021229180014jonhsmith@nbcq520459995303840540115802KH5910Jonh Smith6010PHNOM PENH62210117INV-2021-07-65822'],
  ['KHR with mobile', { accountId: 'jonhsmith@nbcq', merchantName: 'Jonh Smith', merchantCity: 'Phnom Penh', currency: 'KHR', amount: 50000, mobileNumber: '85512345678' },
    '00020101021229180014jonhsmith@nbcq5204599953031165405500005802KH5910Jonh Smith6010Phnom Penh6215021185512345678'],
  ['KHR with store label', { accountId: 'jonhsmith@nbcq', merchantName: 'Jonh Smith', merchantCity: 'Phnom Penh', currency: 'KHR', amount: 50000, storeLabel: 'BKK-1' },
    '00020101021229180014jonhsmith@nbcq5204599953031165405500005802KH5910Jonh Smith6010Phnom Penh62090305BKK-1'],
  ['all additional data', { accountId: 'jonhsmith@nbcq', merchantName: 'Jonh Smith', merchantCity: 'Siam Reap', currency: 'KHR', amount: 50000, billNumber: 'INV-2021-07-65822', mobileNumber: '85512345678', storeLabel: 'BKK-1', terminalLabel: '012345' },
    '00020101021229180014jonhsmith@nbcq5204599953031165405500005802KH5910Jonh Smith6009Siam Reap62550117INV-2021-07-658220211855123456780305BKK-10706012345'],
  ['individual with acquiring bank', { accountId: 'jonhsmith@nbcq', acquiringBank: 'Dev Bank', merchantName: 'Jonh Smith', merchantCity: 'Siam Reap', currency: 'KHR', amount: 50000, billNumber: 'INV-2021-07-65822', mobileNumber: '85512345678', storeLabel: 'BKK-1', terminalLabel: '012345' },
    '00020101021229300014jonhsmith@nbcq0208Dev Bank5204599953031165405500005802KH5910Jonh Smith6009Siam Reap62550117INV-2021-07-658220211855123456780305BKK-10706012345'],
  ['static QR (no amount)', { accountId: 'jonhsmith@nbcq', merchantName: 'Jonh Smith', merchantCity: 'Phnom Penh', currency: 'KHR' },
    '00020101021129180014jonhsmith@nbcq5204599953031165802KH5910Jonh Smith6010Phnom Penh6304'],
];

describe('KHQR', () => {
  it('CRC16 matches the standard test vector', () => {
    expect(crc16('123456789')).toBe('29B1');
  });

  it.each(SAMPLES)('verifies official valid sample %#', (qr) => {
    expect(verifyKhqr(qr)).toBe(true);
    expect(verifyKhqr(qr.slice(0, -1) + (qr.endsWith('0') ? '1' : '0'))).toBe(false); // tampered checksum
  });

  it('rejects junk', () => {
    for (const bad of ['63046007', 'ABC', '', '00020101021126200016coffeeklang@pras']) expect(verifyKhqr(bad)).toBe(false);
  });

  it.each(SDK_CASES)('produces exactly what the official SDK produces: %s', (_name, input, expected) => {
    const { qr } = generateKhqr({ ...input, expiresAt: Date.now() + 60_000 });
    expect(qr.slice(0, expected.length)).toBe(expected);
    expect(verifyKhqr(qr)).toBe(true);
  });

  it('merchant account uses tag 30 with merchant id and bank', () => {
    const { qr } = generateKhqr({ accountId: 'jonhsmith@devb', merchantId: '123456', acquiringBank: 'Dev Bank', merchantName: 'Jonh Smith', currency: 'USD', amount: 10, expiresAt: Date.now() + 60_000 });
    expect(qr.startsWith('00020101021230400014jonhsmith@devb01061234560208Dev Bank520459995303840540210')).toBe(true);
  });

  it('dynamic USD QR has amount, expiry and bill number', () => {
    const now = 1_767_000_000_000;
    const { qr, md5 } = generateKhqr({
      accountId: 'shop@aclb', merchantName: 'MY SHOP', merchantCity: 'Phnom Penh', currency: 'USD', amount: 4.6,
      billNumber: 'PP01-ABC', storeLabel: 'PP01', terminalLabel: 'POS', createdAt: now, expiresAt: now + 300_000,
    });
    const f = parseTlv(qr);
    expect(f['01']).toBe('12');
    expect(f['29']).toBe('0009shop@aclb');
    expect(f['53']).toBe('840');
    expect(f['54']).toBe('4.60');
    expect(parseTlv(f['62'])).toEqual({ '01': 'PP01-ABC', '03': 'PP01', '07': 'POS' });
    expect(parseTlv(f['99'])).toEqual({ '00': String(now), '01': String(now + 300_000) });
    expect(verifyKhqr(qr)).toBe(true);
    expect(md5).toMatch(/^[0-9a-f]{32}$/);
  });

  it('KHR must be whole riel; limits are enforced', () => {
    const base = { accountId: 'a@b', merchantName: 'X', currency: 'KHR' as const, expiresAt: Date.now() + 60_000 };
    expect(parseTlv(generateKhqr({ ...base, amount: 20000 }).qr)['54']).toBe('20000');
    expect(() => generateKhqr({ ...base, amount: 100.5 })).toThrow();
    expect(() => generateKhqr({ ...base, merchantName: 'A very long merchant name over 25' })).toThrow();
    expect(() => generateKhqr({ ...base, amount: 5, expiresAt: undefined })).toThrow();
  });
});

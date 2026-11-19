// Copyright (c) 2026 Chea Phearom. All rights reserved.
// Proprietary and confidential: see the LICENSE file.
import { createVerify, generateKeyPairSync } from 'crypto';
import { pemFromEnv, signQz } from './print.module';

describe('QZ Tray signing', () => {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
  it('signs with SHA-512 so the public key verifies it', () => {
    const sig = signQz('print me', privateKey);
    const v = createVerify('RSA-SHA512'); v.update('print me');
    expect(v.verify(publicKey, sig, 'base64')).toBe(true);
  });
  it('reads a PEM written on one line with \\n', () => {
    expect(pemFromEnv('-----BEGIN X-----\\nabc\\n-----END X-----')).toBe('-----BEGIN X-----\nabc\n-----END X-----');
    expect(pemFromEnv(undefined)).toBe('');
  });
});

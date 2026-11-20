// Copyright (c) 2026 Chea Phearom. All rights reserved.
// Proprietary and confidential: see the LICENSE file.
import { missingSeqs, tillCode } from './tills.module';

describe('till offline numbers', () => {
  it('finds numbers that arrived nowhere', () => {
    // 1-7 used: 1,2,4 uploaded, 5 waiting, 6 deleted with a PIN → 3 and 7 are missing
    expect(missingSeqs(7, [1, 2, 4], [5], [6])).toEqual([3, 7]);
  });
  it('nothing missing when all are accounted for', () => {
    expect(missingSeqs(3, [1, 2, 3], [], [])).toEqual([]);
    expect(missingSeqs(0, [], [], [])).toEqual([]);
  });
  it('makes a short till code from the id', () => {
    expect(tillCode('7k2fa1b3-0000-4000-8000-000000000000')).toBe('7K2F');
  });
});

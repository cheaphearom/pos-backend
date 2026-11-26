// Copyright (c) 2026 Chea Phearom. All rights reserved.
// Proprietary and confidential: see the LICENSE file.
import { changeText, parseAt } from './daily-summary';

describe('daily summary helpers', () => {
  it('reads the time to send', () => {
    expect(parseAt('22:00')).toBe(1320);
    expect(parseAt('7:30')).toBe(450);
    expect(parseAt('off')).toBeNull();
    expect(parseAt('25:00')).toBeNull();
  });
  it('describes the change vs last week', () => {
    expect(changeText(112, 100)).toBe('▲ 12%');
    expect(changeText(96.5, 100)).toBe('▼ 3.5%');
    expect(changeText(100, 100)).toBe('same');
    expect(changeText(50, 0)).toBe('new');
    expect(changeText(0, 0)).toBe('');
  });
});

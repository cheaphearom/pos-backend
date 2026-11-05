/**
 * One format for phone numbers so the same person is always found:
 * digits only, and Cambodia's +855 / 855 prefix becomes 0 ("+855 12 345 678" → "012345678").
 */
export function normalizePhone(raw: string | null | undefined): string | null {
  if (raw == null) return null;
  let d = String(raw).replace(/[^\d+]/g, '');
  if (d.startsWith('+855')) d = '0' + d.slice(4);
  else if (d.startsWith('855') && d.length >= 11) d = '0' + d.slice(3);
  d = d.replace(/\+/g, '');
  return d || null;
}

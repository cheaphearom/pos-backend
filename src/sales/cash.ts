/**
 * Dual currency cash (USD prices, cash in dollars and/or riel). Pure functions shared by the API and the POS,
 * so the till and the server always agree. Riel has no coins: amounts are rounded to 100 riel.
 */
export const KHR_STEP = 100;

export type ChangeMode = 'MIXED' | 'KHR' | 'USD';

const cents = (n: number) => Math.round(n * 100) / 100;

/** USD value of riel cash, to the cent. */
export function khrToUsd(riel: number, rate: number): number {
  return cents(riel / rate);
}

/** Riel needed to pay `usd`, rounded UP to 100 riel so the customer never pays less. */
export function usdToKhrUp(usd: number, rate: number): number {
  return Math.ceil(Math.round(usd * rate) / KHR_STEP) * KHR_STEP;
}

/** Riel value of `usd`, rounded to the nearest 100 riel (for showing totals and giving change). */
export function usdToKhr(usd: number, rate: number): number {
  return Math.round((usd * rate) / KHR_STEP) * KHR_STEP;
}

/**
 * How to give change:
 *  MIXED: whole dollars in USD, the rest in riel (the usual way in Cambodia)
 *  KHR:   everything in riel
 *  USD:   everything in dollars (cents included)
 * Without a riel rate, change is always in dollars.
 */
export function splitChange(change: number, rate: number | null | undefined, mode: ChangeMode = 'MIXED'): { usd: number; khr: number } {
  if (change <= 0) return { usd: 0, khr: 0 };
  if (!rate || mode === 'USD') return { usd: cents(change), khr: 0 };
  if (mode === 'KHR') return { usd: 0, khr: usdToKhr(change, rate) };
  const usd = Math.floor(change + 1e-9);
  return { usd, khr: usdToKhr(change - usd, rate) };
}

/** "៛11,400" */
export const formatKhr = (riel: number) => '៛' + Math.round(riel).toLocaleString('en-US');

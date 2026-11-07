/*
 * SHARED WITH THE FRONTEND: pos-frontend keeps an identical copy in src/shared/promotions.ts.
 * Change both files together (pos-frontend: `npm run check:shared`), otherwise offline till totals
 * will not match the server.
 */
/**
 * Promotion engine. PURE TypeScript with no imports, because the same file is used by
 * the API (to price sales) and by the POS in the browser (to price sales offline).
 * Works in integer cents, like the pricing code.
 *
 * Rules:
 *  - A line gets at most ONE promotion: the one that saves the customer the most
 *    (ties: higher priority, then name).
 *  - PERCENT_OFF: value % off the line.
 *  - AMOUNT_OFF: value off each unit (never below zero).
 *  - BUY_X_GET_Y: for each product, every (X+Y) whole units, Y are free.
 *  - A promotion applies when: active, store matches (empty = all), now is between
 *    startsAt and endsAt, the weekday is allowed, and the local time is inside
 *    [startMinute, endMinute) (a window like 22:00-02:00 wraps past midnight).
 */

export type PromotionKind = 'PERCENT_OFF' | 'AMOUNT_OFF' | 'BUY_X_GET_Y';

export interface PromoRule {
  id: string;
  name: string;
  type: PromotionKind;
  value: number | string;
  buyQty?: number | null;
  getQty?: number | null;
  allProducts: boolean;
  productIds: string[];
  categoryIds: string[];
  storeIds: string[];
  startsAt?: string | Date | null;
  endsAt?: string | Date | null;
  daysOfWeek: number[];
  startMinute?: number | null;
  endMinute?: number | null;
  priority: number;
  isActive: boolean;
}

export interface PromoLine {
  productId: string;
  categoryId: string | null;
  price: number | string; // unit price
  quantity: number;
}

export interface PromoResult {
  promotionId: string | null;
  name: string | null;
  /** Discount in currency units, e.g. 0.65 */
  discount: number;
}

const cents = (v: number | string) => Math.round(Number(v) * 100);
const divRound = (a: number, b: number) => Math.floor((2 * a + b) / (2 * b));
const WEEKDAYS: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

/** Weekday (0-6) and minutes after midnight in the given time zone. */
export function localTime(at: Date, timeZone: string): { day: number; minute: number } {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(at);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '0';
  return { day: WEEKDAYS[get('weekday')] ?? 0, minute: Number(get('hour')) * 60 + Number(get('minute')) };
}

export function isPromoActive(rule: PromoRule, storeId: string, at: Date, timeZone: string): boolean {
  if (!rule.isActive) return false;
  if (rule.storeIds.length && !rule.storeIds.includes(storeId)) return false;
  if (rule.startsAt && at < new Date(rule.startsAt)) return false;
  if (rule.endsAt && at >= new Date(rule.endsAt)) return false;
  const needsClock = rule.daysOfWeek.length > 0 || rule.startMinute != null || rule.endMinute != null;
  if (!needsClock) return true;
  const { day, minute } = localTime(at, timeZone);
  if (rule.daysOfWeek.length && !rule.daysOfWeek.includes(day)) return false;
  const start = rule.startMinute ?? 0;
  const end = rule.endMinute ?? 1440;
  if (start === end) return true;
  return start < end ? minute >= start && minute < end : minute >= start || minute < end;
}

const matches = (rule: PromoRule, line: PromoLine) =>
  rule.allProducts || rule.productIds.includes(line.productId) || (!!line.categoryId && rule.categoryIds.includes(line.categoryId));

export function applyPromotions(lines: PromoLine[], rules: PromoRule[], storeId: string, at: Date, timeZone: string): PromoResult[] {
  const active = rules.filter((r) => isPromoActive(r, storeId, at, timeZone));
  const best: { rule: PromoRule | null; cents: number }[] = lines.map(() => ({ rule: null, cents: 0 }));

  for (const rule of active) {
    const perLine = discountsFor(rule, lines);
    perLine.forEach((c, i) => {
      if (c <= 0) return;
      const b = best[i];
      const better =
        c > b.cents ||
        (c === b.cents && b.rule && (rule.priority > b.rule.priority || (rule.priority === b.rule.priority && rule.name < b.rule.name)));
      if (better) best[i] = { rule, cents: c };
    });
  }
  return best.map((b) => ({ promotionId: b.rule?.id ?? null, name: b.rule?.name ?? null, discount: b.cents / 100 }));
}

/** Discount in cents this rule would give each line (0 if it does not apply). */
function discountsFor(rule: PromoRule, lines: PromoLine[]): number[] {
  const out = lines.map(() => 0);
  const gross = (l: PromoLine) => divRound(cents(l.price) * Math.round(l.quantity * 1000), 1000);

  if (rule.type === 'PERCENT_OFF') {
    const pctE4 = Math.round(Number(rule.value) * 100); // 12.5% -> 1250
    lines.forEach((l, i) => {
      if (matches(rule, l)) out[i] = Math.min(gross(l), divRound(gross(l) * pctE4, 10000));
    });
  } else if (rule.type === 'AMOUNT_OFF') {
    lines.forEach((l, i) => {
      if (!matches(rule, l)) return;
      const perUnit = Math.min(cents(rule.value), cents(l.price));
      out[i] = Math.min(gross(l), divRound(perUnit * Math.round(l.quantity * 1000), 1000));
    });
  } else if (rule.type === 'BUY_X_GET_Y') {
    const x = rule.buyQty ?? 0;
    const y = rule.getQty ?? 0;
    if (x < 1 || y < 1) return out;
    // Group whole units per product across lines.
    const byProduct = new Map<string, number[]>();
    lines.forEach((l, i) => {
      if (!matches(rule, l)) return;
      byProduct.set(l.productId, [...(byProduct.get(l.productId) ?? []), i]);
    });
    for (const idx of byProduct.values()) {
      const units = idx.reduce((s, i) => s + Math.floor(lines[i].quantity + 1e-9), 0);
      let free = Math.floor(units / (x + y)) * y;
      for (const i of idx) {
        if (free <= 0) break;
        const take = Math.min(free, Math.floor(lines[i].quantity + 1e-9));
        out[i] = Math.min(gross(lines[i]), take * cents(lines[i].price));
        free -= take;
      }
    }
  }
  return out;
}

/** Short text for receipts and the POS, e.g. "Buy 2 get 1 free". */
export function describePromotion(r: Pick<PromoRule, 'type' | 'value' | 'buyQty' | 'getQty'>): string {
  if (r.type === 'PERCENT_OFF') return `${Number(r.value)}% off`;
  if (r.type === 'AMOUNT_OFF') return `${Number(r.value).toFixed(2)} off each`;
  return `Buy ${r.buyQty} get ${r.getQty} free`;
}

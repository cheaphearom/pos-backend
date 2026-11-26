// Copyright (c) 2026 Chea Phearom. All rights reserved.
// Proprietary and confidential: see the LICENSE file.
/**
 * Nightly summary on Telegram: the day's sales, profit, payments, busiest hour, best sellers, refunds / voids /
 * discounts and low stock, sent once a day at DAILY_SUMMARY_AT (REPORT_TIMEZONE).
 *
 * Every minute (and once after start, to catch up after a restart) it checks whether today's summary is due.
 * The day is claimed first in `report_sends`, so a restart or a second API container never sends it twice;
 * a failed send is tried again a few times (one try a minute).
 *
 * Configuration (deploy/.env): TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID (both needed), DAILY_SUMMARY_AT (22:00;
 * "off" = never automatically), TELEGRAM_API_URL (tests only).
 */
import { BadRequestException, forwardRef, Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { REPORT_TIMEZONE } from '../config';
import { Principal } from '../common/principal';
import { PrismaService } from '../prisma/prisma.service';
import { ReportsService } from './reports.module';

/** The summary covers every store. */
const SYSTEM: Principal = { kind: 'api_key', id: 'daily-summary', name: 'Daily summary', scopes: [], storeIds: 'ALL' };
const EVERY_MS = 60_000;
const MAX_TRIES = 5;
const KIND = 'daily';

export const summaryConfig = () => ({
  token: (process.env.TELEGRAM_BOT_TOKEN ?? '').trim(),
  chatId: (process.env.TELEGRAM_CHAT_ID ?? '').trim(),
  at: (process.env.DAILY_SUMMARY_AT ?? '22:00').trim() || '22:00',
  apiUrl: (process.env.TELEGRAM_API_URL ?? 'https://api.telegram.org').replace(/\/+$/, ''),
  timezone: REPORT_TIMEZONE,
});

const money = (v: number) => `${v < 0 ? '−' : ''}$${Math.abs(v).toFixed(2)}`;
const METHOD: Record<string, string> = { CASH: 'Cash', CARD: 'Card', KHQR: 'KHQR', WALLET: 'Wallet', VOUCHER: 'Voucher', POINTS: 'Points', OTHER: 'Other' };
const shiftDay = (day: string, n: number) => new Date(new Date(day + 'T00:00:00Z').getTime() + n * 86_400_000).toISOString().slice(0, 10);
const dayLabel = (day: string, opts: Intl.DateTimeFormatOptions) => new Date(day + 'T00:00:00Z').toLocaleDateString('en-GB', { timeZone: 'UTC', ...opts });

/** "▲ 12%" / "▼ 3.5%" / "new" vs an earlier amount; empty when there is nothing to compare. */
export function changeText(now: number, before: number): string {
  if (!before) return now ? 'new' : '';
  const pct = ((now - before) / Math.abs(before)) * 100;
  if (Math.abs(pct) < 0.05) return 'same';
  return `${pct > 0 ? '▲' : '▼'} ${Math.abs(pct).toFixed(Math.abs(pct) < 10 ? 1 : 0)}%`;
}

/** Local date (YYYY-MM-DD) and minutes since midnight in the report time zone. */
function localNow(tz: string, at = new Date()) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
    .formatToParts(at).map((x) => [x.type, x.value]));
  return { day: `${parts.year}-${parts.month}-${parts.day}`, minutes: Number(parts.hour) * 60 + Number(parts.minute) };
}

/** "22:00" → 1320; null for "off" or nonsense. */
export function parseAt(at: string): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(at.trim());
  if (!m || Number(m[1]) > 23 || Number(m[2]) > 59) return null;
  return Number(m[1]) * 60 + Number(m[2]);
}

@Injectable()
export class DailySummaryService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger('DailySummary');
  private timer?: ReturnType<typeof setInterval>;
  private busy = false;

  constructor(
    private readonly prisma: PrismaService,
    @Inject(forwardRef(() => ReportsService)) private readonly reports: ReportsService,
  ) {}

  onModuleInit() {
    if (process.env.NODE_ENV === 'test') return;
    setTimeout(() => this.tick(), 15_000).unref();
    this.timer = setInterval(() => this.tick(), EVERY_MS);
    this.timer.unref();
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  /** The message for one day (default: today in the report time zone). */
  async build(day: string): Promise<string> {
    const r = this.reports;
    const one = { from: day, to: day };
    const lastWeek = shiftDay(day, -7);
    const [sum, prev, profit, pay, top, ctl, hours, stock, stores] = await Promise.all([
      r.salesSummary(SYSTEM, { ...one, groupBy: 'store' }),
      r.salesSummary(SYSTEM, { from: lastWeek, to: lastWeek, groupBy: 'store' }),
      r.profit(SYSTEM, { ...one, groupBy: 'store' }),
      r.payments(SYSTEM, one),
      r.topProducts(SYSTEM, { ...one, limit: 3 }),
      r.control(SYSTEM, one),
      r.hours(SYSTEM, one),
      r.inventoryValue(SYSTEM),
      this.prisma.store.findMany({ select: { code: true, name: true }, orderBy: { code: 'asc' } }),
    ]);
    const weekday = dayLabel(day, { weekday: 'short' });
    const lines = [`📊 Daily summary · ${weekday} ${dayLabel(day, { day: 'numeric', month: 'short', year: 'numeric' })}`, ''];
    const t = sum.totals;
    if (!t.salesCount) {
      lines.push('No sales today.');
    } else {
      const ch = changeText(t.net, prev.totals.net);
      lines.push(`💵 Net sales: ${money(t.net)}${ch ? ` (${ch} vs last ${weekday}${prev.totals.net ? ` ${money(prev.totals.net)}` : ''})` : ''}`);
      lines.push(`🧾 ${t.salesCount} sale${t.salesCount === 1 ? '' : 's'} · average ${money(t.total / t.salesCount)}`);
      const rev = profit.data.reduce((a, x) => a + x.revenue, 0);
      const cost = profit.data.reduce((a, x) => a + x.cost, 0);
      lines.push(`📈 Gross profit: ${money(rev - cost)}${rev ? ` · margin ${(((rev - cost) / rev) * 100).toFixed(1)}%` : ''}`);
      if (pay.data.length) lines.push(`💳 Paid in: ${pay.data.filter((x) => x.amount).map((x) => `${METHOD[x.method] ?? x.method} ${money(x.amount)}`).join(' · ')}`);
      const byHour = new Map<number, number>();
      for (const h of hours.data) byHour.set(h.hour, (byHour.get(h.hour) ?? 0) + h.salesCount);
      const busy = [...byHour.entries()].sort((a, b) => b[1] - a[1])[0];
      if (busy) lines.push(`⏰ Busiest hour: ${String(busy[0]).padStart(2, '0')}:00–${String(busy[0] + 1).padStart(2, '0')}:00 (${busy[1]} sale${busy[1] === 1 ? '' : 's'})`);
      if (top.data.length) lines.push(`🏆 Top: ${top.data.map((x: any) => `${x.name} ×${Number(x.quantity) % 1 ? Number(x.quantity).toFixed(2) : Number(x.quantity)}`).join(' · ')}`);
    }
    // control
    const c = ctl.totals;
    const control: string[] = [];
    if (c.refunds) control.push(`↩️ Refunds: ${c.refunds} · ${money(c.refundAmount)}`);
    if (c.voids) control.push(`🚫 Voids: ${c.voids} · ${money(c.voidAmount)}`);
    if (c.discounts) {
      const approved = ctl.cashiers.reduce((a, w) => a + w.discountsApproved, 0);
      control.push(`🏷️ Manual discounts: ${c.discounts} · ${money(c.discountAmount)}${approved ? ` (${approved} approved by a manager)` : ''}`);
    }
    if (c.wrongPins) control.push(`🔑 Wrong manager PINs: ${c.wrongPins}`);
    lines.push('', ...(control.length ? control : ['✅ No refunds, voids or manual discounts']));
    const low = stock.reduce((a, x) => a + x.lowStock, 0);
    if (low) lines.push(`⚠️ Low stock: ${low} product${low === 1 ? '' : 's'}`);
    // per store, when there are several
    if (sum.data.length > 1 || (sum.data.length === 1 && stores.length > 1)) {
      lines.push('', 'By store');
      for (const s of sum.data) {
        const before = prev.data.find((x) => x.key === s.key)?.net ?? 0;
        const ch = changeText(s.net, before);
        const name = stores.find((x) => x.code === s.key)?.name;
        lines.push(`• ${s.key}${name ? ` ${name}` : ''}: ${money(s.net)} · ${s.salesCount} sale${s.salesCount === 1 ? '' : 's'}${ch ? ` (${ch})` : ''}`);
      }
    }
    return lines.join('\n').slice(0, 4000);
  }

  private today() {
    return localNow(summaryConfig().timezone).day;
  }

  private checkDay(date?: string) {
    if (!date) return this.today();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(date))) throw new BadRequestException('date: YYYY-MM-DD');
    return date;
  }

  /** The text for a day and whether automatic sending is set up (for the Reports page). */
  async preview(date?: string) {
    const day = this.checkDay(date);
    const cfg = summaryConfig();
    const sent = await this.prisma.reportSend.findUnique({ where: { kind_day: { kind: KIND, day: new Date(day + 'T00:00:00Z') } } });
    return {
      date: day, text: await this.build(day), configured: !!(cfg.token && cfg.chatId),
      at: parseAt(cfg.at) === null ? null : cfg.at, timezone: cfg.timezone,
      sent: sent ? { at: sent.sentAt, error: sent.error, tries: sent.tries } : null,
    };
  }

  /** Send now (button on the Reports page). Does not change when the automatic one goes. */
  async sendNow(date?: string) {
    const day = this.checkDay(date);
    const cfg = summaryConfig();
    if (!cfg.token || !cfg.chatId) throw new BadRequestException('Telegram is not set up: add TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID to the server settings (deploy/.env) and restart the API');
    await this.send(await this.build(day));
    return { sent: true, date: day };
  }

  private async send(text: string) {
    const cfg = summaryConfig();
    let res: Response;
    try {
      res = await fetch(`${cfg.apiUrl}/bot${cfg.token}/sendMessage`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ chat_id: cfg.chatId, text, disable_web_page_preview: true }),
        signal: AbortSignal.timeout(15_000),
      });
    } catch (e) {
      throw new BadRequestException(`Telegram could not be reached: ${(e as Error).name === 'TimeoutError' ? 'timed out' : 'network error'}`);
    }
    const body = (await res.json().catch(() => ({}))) as { ok?: boolean; description?: string };
    if (!res.ok || body.ok === false) throw new BadRequestException(`Telegram refused the message: ${body.description ?? `HTTP ${res.status}`}`);
  }

  /** Every minute: send today's summary once it is due. */
  async tick(now = new Date()) {
    const cfg = summaryConfig();
    const at = parseAt(cfg.at);
    if (this.busy || !cfg.token || !cfg.chatId || at === null) return;
    const local = localNow(cfg.timezone, now);
    if (local.minutes < at) return;
    this.busy = true;
    try {
      const day = new Date(local.day + 'T00:00:00Z');
      // claim the day: the first try inserts the row; later tries only while it is not sent and tries are left
      const claimed = await this.prisma.$queryRaw<{ tries: number }[]>`
        INSERT INTO report_sends (kind, day, tries) VALUES (${KIND}, ${day}::date, 1)
        ON CONFLICT (kind, day) DO UPDATE SET tries = report_sends.tries + 1
          WHERE report_sends.sent_at IS NULL AND report_sends.tries < ${MAX_TRIES}
        RETURNING tries`;
      if (!claimed.length) return;
      try {
        await this.send(await this.build(local.day));
        await this.prisma.reportSend.update({ where: { kind_day: { kind: KIND, day } }, data: { sentAt: new Date(), error: null } });
        this.log.log(`daily summary sent for ${local.day}`);
      } catch (e) {
        const msg = (e as Error).message.slice(0, 300);
        await this.prisma.reportSend.update({ where: { kind_day: { kind: KIND, day } }, data: { error: msg } });
        this.log.warn(`daily summary for ${local.day} not sent (try ${claimed[0].tries} of ${MAX_TRIES}): ${msg}`);
      }
    } catch (e) {
      this.log.error(`daily summary check failed: ${(e as Error).message}`);
    } finally {
      this.busy = false;
    }
  }
}

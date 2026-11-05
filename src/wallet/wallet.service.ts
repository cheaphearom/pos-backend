import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { PaymentMethod, Prisma, Role } from '@prisma/client';
import * as bcrypt from 'bcryptjs';
import { config } from '../config';
import { pageArgs, toPage, PageQueryDto } from '../common/pagination';
import { assertStoreAccess, Principal, userIdOf } from '../common/principal';
import { PrismaService } from '../prisma/prisma.service';
import { WebhooksService } from '../webhooks/webhooks.service';
import { isValidCardNumber, newCardNumber, newSerial, sameSerial } from './card-number';
import { ActivateCardDto, AdjustBalanceDto, CardQueryDto, CreateCardsDto, ReplaceCardDto, TopupDto } from './wallet.dto';

const D = (v: Prisma.Decimal.Value) => new Prisma.Decimal(v);
const MAX_PIN_FAILURES = 5;

const cardView = {
  id: true, cardNumber: true, serialNumber: true, status: true, balance: true, note: true,
  issuedAt: true, activatedAt: true, lastUsedAt: true, pinHash: true, pinFailures: true,
  customer: { select: { id: true, code: true, name: true, phone: true, points: true } },
} satisfies Prisma.WalletCardSelect;

type CardRow = Prisma.WalletCardGetPayload<{ select: typeof cardView }>;
/** Never send the PIN hash out. */
const publicCard = ({ pinHash, ...c }: CardRow) => ({ ...c, hasPin: !!pinHash });

@Injectable()
export class WalletService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly webhooks: WebhooksService,
  ) {}

  // ─── Cards ───

  async createCards(dto: CreateCardsDto) {
    let cards: { cardNumber: string; serialNumber: string }[];
    if (dto.cards?.length) {
      for (const c of dto.cards) {
        if (!isValidCardNumber(c.cardNumber)) throw new BadRequestException(`Card number ${c.cardNumber} fails the check digit`);
      }
      cards = dto.cards.map((c) => ({ cardNumber: c.cardNumber, serialNumber: c.serialNumber.toUpperCase() }));
    } else {
      if (!dto.count) throw new BadRequestException('Give a count or a list of cards');
      const numbers = new Set<string>();
      while (numbers.size < dto.count) numbers.add(newCardNumber(config.walletCardPrefix));
      cards = [...numbers].map((cardNumber) => ({ cardNumber, serialNumber: newSerial() }));
    }
    const res = await this.prisma.walletCard.createMany({ data: cards, skipDuplicates: true });
    return { created: res.count, skipped: cards.length - res.count, cards };
  }

  async list(q: CardQueryDto) {
    const s = q.search?.trim();
    const where: Prisma.WalletCardWhereInput = {
      status: q.status,
      customerId: q.customerId,
      ...(s && {
        OR: [
          { cardNumber: { contains: s.replace(/\s/g, '') } },
          { serialNumber: { contains: s.replace(/\s/g, '').toUpperCase() } },
          { customer: { name: { contains: s, mode: 'insensitive' } } },
          { customer: { phone: { contains: s } } },
        ],
      }),
    };
    const [rows, total] = await Promise.all([
      this.prisma.walletCard.findMany({ where, select: cardView, orderBy: { issuedAt: 'desc' }, ...pageArgs(q) }),
      this.prisma.walletCard.count({ where }),
    ]);
    return toPage(rows.map(publicCard), total, q);
  }

  /** POS: find a card by its number (scanned) or serial. */
  async lookup(code: string) {
    const c = code.replace(/\s/g, '');
    const card = await this.prisma.walletCard.findFirst({
      where: { OR: [{ cardNumber: c }, { serialNumber: c.toUpperCase() }] },
      select: cardView,
    });
    if (!card) throw new NotFoundException('Wallet card not found');
    return publicCard(card);
  }

  async get(id: string) {
    return publicCard(await this.prisma.walletCard.findUniqueOrThrow({ where: { id }, select: cardView }));
  }

  async transactions(id: string, q: PageQueryDto) {
    const where = { cardId: id };
    const [rows, total] = await Promise.all([
      this.prisma.walletTransaction.findMany({ where, orderBy: { id: 'desc' }, ...pageArgs(q) }),
      this.prisma.walletTransaction.count({ where }),
    ]);
    return toPage(rows, total, q);
  }

  /** Give an INACTIVE card to a customer (existing or new). */
  async activate(p: Principal, id: string, dto: ActivateCardDto) {
    const card = await this.prisma.walletCard.findUniqueOrThrow({ where: { id } });
    if (card.status !== 'INACTIVE') throw new BadRequestException(`Card is already ${card.status}`);
    if (!sameSerial(card.serialNumber, dto.serialNumber)) throw new BadRequestException('Serial number does not match this card');
    if (!dto.customerId && !dto.name) throw new BadRequestException('Choose a customer or enter a name');

    const updated = await this.prisma.$transaction(async (tx) => {
      let customerId = dto.customerId;
      if (!customerId) {
        const c = await tx.customer.create({ data: { name: dto.name!, phone: dto.phone || undefined, code: card.cardNumber } });
        customerId = c.id;
      }
      return tx.walletCard.update({
        where: { id },
        data: { status: 'ACTIVE', customerId, activatedAt: new Date(), pinHash: dto.pin ? await bcrypt.hash(dto.pin, 10) : null, note: card.note ?? `Activated by ${p.name}` },
        select: cardView,
      });
    });
    return publicCard(updated);
  }

  /** Add money to a card. Idempotent with clientRef. */
  async topup(p: Principal, id: string, dto: TopupDto) {
    assertStoreAccess(p, dto.storeId);
    if (dto.method === 'WALLET') throw new BadRequestException('A wallet cannot be topped up from a wallet');
    if (dto.clientRef) {
      const done = await this.prisma.walletTransaction.findUnique({ where: { clientRef: dto.clientRef } });
      if (done) return { transaction: done, card: await this.get(done.cardId) };
    }
    const userId = userIdOf(p);
    const shift = userId ? await this.prisma.shift.findFirst({ where: { storeId: dto.storeId, userId, status: 'OPEN' }, select: { id: true } }) : null;
    const result = await this.prisma.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<{ balance: Prisma.Decimal }[]>`
        UPDATE wallet_cards SET balance = balance + ${D(dto.amount)}::numeric, last_used_at = now(), updated_at = now()
         WHERE id = ${id}::uuid AND status = 'ACTIVE' RETURNING balance`;
      if (!rows.length) throw new BadRequestException(await this.whyUnusable(tx, id));
      return tx.walletTransaction.create({
        data: {
          cardId: id, type: 'TOPUP', amount: dto.amount, balanceAfter: rows[0].balance, method: dto.method, reference: dto.reference,
          clientRef: dto.clientRef, storeId: dto.storeId, shiftId: shift?.id, userId,
        },
      });
    });
    await this.webhooks.emit('wallet.topup', result);
    return { transaction: result, card: await this.get(id) };
  }

  async adjust(p: Principal, id: string, dto: AdjustBalanceDto) {
    const tx = await this.prisma.$transaction(async (t) => {
      const rows = await t.$queryRaw<{ balance: Prisma.Decimal }[]>`
        UPDATE wallet_cards SET balance = balance + ${D(dto.amount)}::numeric, updated_at = now()
         WHERE id = ${id}::uuid AND status IN ('ACTIVE', 'BLOCKED') AND balance + ${D(dto.amount)}::numeric >= 0 RETURNING balance`;
      if (!rows.length) throw new BadRequestException('Card not found, closed, or the balance would go below zero');
      return t.walletTransaction.create({ data: { cardId: id, type: 'ADJUST', amount: dto.amount, balanceAfter: rows[0].balance, userId: userIdOf(p), note: dto.reason } });
    });
    return { transaction: tx, card: await this.get(id) };
  }

  async setStatus(id: string, status: 'ACTIVE' | 'BLOCKED', reason?: string) {
    const card = await this.prisma.walletCard.findUniqueOrThrow({ where: { id } });
    if (card.status === 'CLOSED' || card.status === 'INACTIVE') throw new BadRequestException(`Card is ${card.status}`);
    return publicCard(await this.prisma.walletCard.update({ where: { id }, data: { status, pinFailures: 0, ...(reason && { note: reason }) }, select: cardView }));
  }

  /**
   * Set or remove the PIN. Cashiers may only set a PIN on a card without one
   * (e.g. when the customer asks); changing an existing PIN needs a manager.
   */
  async setPin(p: Principal, id: string, pin: string) {
    const card = await this.prisma.walletCard.findUniqueOrThrow({ where: { id } });
    if (card.pinHash && p.role === Role.CASHIER) throw new ForbiddenException('Ask a manager to change an existing PIN');
    return publicCard(await this.prisma.walletCard.update({ where: { id }, data: { pinHash: pin ? await bcrypt.hash(pin, 10) : null, pinFailures: 0 }, select: cardView }));
  }

  /** Lost or damaged card: move customer and balance to a new card, close the old one. */
  async replace(p: Principal, id: string, dto: ReplaceCardDto) {
    return this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM wallet_cards WHERE id = ${id}::uuid FOR UPDATE`;
      const old = await tx.walletCard.findUniqueOrThrow({ where: { id } });
      if (!['ACTIVE', 'BLOCKED'].includes(old.status)) throw new BadRequestException(`Card is ${old.status}`);
      const fresh = await tx.walletCard.findUnique({ where: { cardNumber: dto.newCardNumber } });
      if (!fresh || fresh.status !== 'INACTIVE') throw new BadRequestException('The new card must be an unused (inactive) card');
      if (!sameSerial(fresh.serialNumber, dto.newSerialNumber)) throw new BadRequestException('Serial number does not match the new card');
      const userId = userIdOf(p);
      await tx.walletCard.update({ where: { id }, data: { status: 'CLOSED', balance: 0, note: `Replaced by ${fresh.cardNumber}` } });
      await tx.walletCard.update({
        where: { id: fresh.id },
        data: { status: 'ACTIVE', customerId: old.customerId, balance: old.balance, pinHash: old.pinHash, activatedAt: new Date(), note: `Replaces ${old.cardNumber}` },
      });
      if (old.balance.gt(0)) {
        await tx.walletTransaction.create({ data: { cardId: old.id, type: 'TRANSFER_OUT', amount: old.balance.neg(), balanceAfter: 0, userId, note: `To ${fresh.cardNumber}` } });
        await tx.walletTransaction.create({ data: { cardId: fresh.id, type: 'TRANSFER_IN', amount: old.balance, balanceAfter: old.balance, userId, note: `From ${old.cardNumber}` } });
      }
      return publicCard(await tx.walletCard.findUniqueOrThrow({ where: { id: fresh.id }, select: cardView }));
    });
  }

  // ─── Used by sales ───

  /**
   * Check the PIN BEFORE the sale transaction, so wrong attempts are counted even
   * though the sale fails. 5 wrong PINs block the card.
   */
  async verifyForPayment(payments: { method: string; amount: number; reference?: string; pin?: string }[]) {
    for (const pay of payments.filter((x) => x.method === 'WALLET')) {
      if (!pay.reference) throw new BadRequestException('Scan the wallet card');
      const card = await this.prisma.walletCard.findUnique({ where: { cardNumber: pay.reference } });
      if (!card) throw new BadRequestException('Wallet card not found');
      if (card.status !== 'ACTIVE') throw new BadRequestException(`Wallet card is ${card.status}`);
      if (card.pinHash) {
        if (!pay.pin) throw new BadRequestException('This card needs its PIN');
        if (!(await bcrypt.compare(pay.pin, card.pinHash))) {
          const failures = card.pinFailures + 1;
          await this.prisma.walletCard.update({ where: { id: card.id }, data: { pinFailures: failures, ...(failures >= MAX_PIN_FAILURES && { status: 'BLOCKED', note: 'Blocked: too many wrong PINs' }) } });
          throw new BadRequestException(failures >= MAX_PIN_FAILURES ? 'Wrong PIN. The card is now blocked; a manager can unblock it.' : `Wrong PIN (${MAX_PIN_FAILURES - failures} tries left)`);
        }
        if (card.pinFailures) await this.prisma.walletCard.update({ where: { id: card.id }, data: { pinFailures: 0 } });
      }
    }
  }

  /** Take money off the card inside the sale transaction (atomic; never below zero). */
  async debitForSale(tx: Prisma.TransactionClient, cardNumber: string, amount: number, ctx: { saleId: string; storeId: string; shiftId?: string | null; userId: string | null; receiptNo: string }) {
    const rows = await tx.$queryRaw<{ id: string; balance: Prisma.Decimal }[]>`
      UPDATE wallet_cards SET balance = balance - ${D(amount)}::numeric, last_used_at = now(), updated_at = now()
       WHERE card_number = ${cardNumber} AND status = 'ACTIVE' AND balance >= ${D(amount)}::numeric
       RETURNING id, balance`;
    if (!rows.length) {
      const card = await tx.walletCard.findUnique({ where: { cardNumber } });
      if (!card) throw new BadRequestException('Wallet card not found');
      if (card.status !== 'ACTIVE') throw new BadRequestException(`Wallet card is ${card.status}`);
      throw new BadRequestException(`Wallet balance is ${card.balance}, not enough for ${amount}`);
    }
    await tx.walletTransaction.create({
      data: { cardId: rows[0].id, type: 'PAYMENT', amount: -amount, balanceAfter: rows[0].balance, saleId: ctx.saleId, storeId: ctx.storeId, shiftId: ctx.shiftId, userId: ctx.userId, reference: ctx.receiptNo },
    });
  }

  /** Refund money back to the card that paid (also works for blocked cards). */
  async creditRefund(tx: Prisma.TransactionClient, cardNumber: string, amount: Prisma.Decimal, ctx: { saleId: string; storeId: string; userId: string | null; reference: string }) {
    const rows = await tx.$queryRaw<{ id: string; balance: Prisma.Decimal }[]>`
      UPDATE wallet_cards SET balance = balance + ${amount}::numeric, updated_at = now()
       WHERE card_number = ${cardNumber} AND status IN ('ACTIVE', 'BLOCKED') RETURNING id, balance`;
    if (!rows.length) throw new BadRequestException('The wallet card that paid is closed; refund another way');
    await tx.walletTransaction.create({ data: { cardId: rows[0].id, type: 'REFUND', amount, balanceAfter: rows[0].balance, saleId: ctx.saleId, storeId: ctx.storeId, userId: ctx.userId, reference: ctx.reference } });
  }

  private async whyUnusable(tx: Prisma.TransactionClient, id: string) {
    const card = await tx.walletCard.findUnique({ where: { id } });
    if (!card) return 'Wallet card not found';
    return card.status === 'INACTIVE' ? 'Activate the card first' : `Wallet card is ${card.status}`;
  }
}

export const isWalletMethod = (m: PaymentMethod | string) => m === 'WALLET';

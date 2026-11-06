import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, Role } from '@prisma/client';
import { ApprovalsService, AuditService } from '../audit/audit.module';
import { changePoints, pointsForAmount, valueOfPoints } from '../customers/loyalty';
import { dateFilter } from '../common/date-range';
import { pageArgs, toPage } from '../common/pagination';
import { assertStoreAccess, Principal, storeScope, userIdOf } from '../common/principal';
import { InventoryService } from '../inventory/inventory.service';
import { MovementResult, StockService } from '../inventory/stock.service';
import { PrismaService } from '../prisma/prisma.service';
import { WebhooksService } from '../webhooks/webhooks.service';
import { priceSale, PricingError } from './pricing';
import { applyPromotions } from '../promotions/engine';
import { PromotionsService } from '../promotions/promotions.module';
import { KhqrService } from '../payments/payments.module';
import { WalletService } from '../wallet/wallet.service';
import { CouponCheck, CouponsService } from '../coupons/coupons.module';
import { VouchersService } from '../vouchers/vouchers.module';
import { RecipesService } from '../recipes/recipes.module';
import { REPORT_TIMEZONE } from '../config';
import { khrToUsd, splitChange } from './cash';
import { CreateRefundDto, CreateSaleDto, SaleQueryDto, VoidSaleDto } from './sales.dto';

const D = (v: Prisma.Decimal.Value) => new Prisma.Decimal(v);
const ZERO = D(0);

const receiptInclude = {
  store: { select: { id: true, code: true, name: true, address: true, phone: true, currency: true, khrRate: true } },
  cashier: { select: { id: true, fullName: true } },
  customer: { select: { id: true, code: true, name: true, phone: true, points: true } },
  items: { orderBy: { lineNo: 'asc' }, include: { promotion: { select: { id: true, name: true } } } },
  payments: true,
  refunds: { include: { items: true } },
} satisfies Prisma.SaleInclude;

@Injectable()
export class SalesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly stock: StockService,
    private readonly inventory: InventoryService,
    private readonly webhooks: WebhooksService,
    private readonly promotions: PromotionsService,
    private readonly khqr: KhqrService,
    private readonly wallet: WalletService,
    private readonly coupons: CouponsService,
    private readonly vouchers: VouchersService,
    private readonly recipes: RecipesService,
    private readonly audit: AuditService,
    private readonly approvals: ApprovalsService,
  ) {}

  /**
   * Checkout. Everything (stock, points, receipt number, payments) happens in ONE
   * database transaction: either the whole sale is saved or nothing is.
   */
  /**
   * @param opts.walletVerified the wallet owner already proved who they are (member app login),
   *        so the card PIN is not asked again.
   */
  async create(p: Principal, dto: CreateSaleDto, opts: { walletVerified?: boolean } = {}) {
    assertStoreAccess(p, dto.storeId);

    if (dto.clientRef) {
      const existing = await this.prisma.sale.findUnique({ where: { clientRef: dto.clientRef }, include: receiptInclude });
      if (existing) return existing; // already processed (retry / offline re-sync)
    }

    let offlineAt: Date | undefined;
    if (dto.offlineCreatedAt) {
      if (!dto.clientRef) throw new BadRequestException('Offline sales need a clientRef');
      offlineAt = new Date(dto.offlineCreatedAt);
      const now = Date.now();
      if (offlineAt.getTime() > now + 5 * 60_000 || offlineAt.getTime() < now - 7 * 86_400_000) {
        throw new BadRequestException('offlineCreatedAt must be within the last 7 days');
      }
    }

    const store = await this.prisma.store.findUniqueOrThrow({ where: { id: dto.storeId } });
    if (!store.isActive) throw new BadRequestException('Store is inactive');

    const { lines, usage, coupon, priced } = await this.buildPricing(dto, store, offlineAt);

    // Cashier controls: a manual discount above the store's limit needs a manager PIN (promotions,
    // coupons and points do not count: they follow their own rules).
    const promoTotal = lines.reduce((t, l) => t.plus(l.promo), ZERO);
    const manualDiscount = priced.discountTotal.minus(promoTotal).minus(coupon?.discount ?? 0);
    const discountBase = priced.subtotal.minus(promoTotal);
    const manualPercent = discountBase.gt(0) && manualDiscount.gt(0) ? manualDiscount.div(discountBase).mul(100).toDecimalPlaces(2).toNumber() : 0;
    const discountLimit = Number(store.cashierMaxDiscountPercent);
    const discountNeedsPin = p.kind === 'user' && p.role === Role.CASHIER && manualPercent > discountLimit;
    if (discountNeedsPin && offlineAt) throw new ForbiddenException(`Discounts above ${discountLimit}% need a manager PIN and cannot be given offline`);

    // Loyalty redemption reduces the amount the customer has to pay.
    let pointsDiscount = ZERO;
    const redeem = dto.redeemPoints ?? 0;
    if (redeem && !dto.customerId) throw new BadRequestException('Select a customer to redeem points');
    if (redeem) {
      pointsDiscount = valueOfPoints(redeem);
      if (pointsDiscount.gt(priced.total)) throw new BadRequestException(`Points are worth ${pointsDiscount}, more than the total ${priced.total}`);
    }
    const amountDue = priced.total.minus(pointsDiscount);

    // Payments: cash can be more than due (change is given), other methods cannot.
    const paid = dto.payments.reduce((s, x) => s.plus(x.amount), ZERO);
    const nonCash = dto.payments.filter((x) => x.method !== 'CASH').reduce((s, x) => s.plus(x.amount), ZERO);
    if (paid.lt(amountDue)) throw new BadRequestException(`Payment ${paid} is less than amount due ${amountDue}`);
    if (nonCash.gt(amountDue)) throw new BadRequestException('Card / KHQR / transfer payments cannot be more than the amount due');
    const changeDue = paid.minus(amountDue);

    // Dual currency: riel cash is checked against the store rate (5% leeway for offline tills with an older rate).
    for (const pay of dto.payments) {
      if ((pay.currency ?? 'USD') !== 'KHR') continue;
      if (pay.method !== 'CASH') throw new BadRequestException('Only cash can be paid in riel');
      if (!store.khrRate) throw new BadRequestException('Riel cash is not set up for this store');
      if (!pay.tendered || pay.tendered % 100 !== 0) throw new BadRequestException('Riel cash must be in steps of 100');
      if (!pay.rate || Math.abs(pay.rate - store.khrRate) > store.khrRate * 0.05) throw new BadRequestException(`The exchange rate is now ${store.khrRate} riel per dollar; enter the riel again`);
      if (Math.abs(khrToUsd(pay.tendered, pay.rate) - pay.amount) > 0.005) throw new BadRequestException(`${pay.tendered} riel at ${pay.rate} is ${khrToUsd(pay.tendered, pay.rate)} dollars, not ${pay.amount}`);
    }
    const change = splitChange(changeDue.toNumber(), store.khrRate, dto.changeIn);

    const userId = userIdOf(p);
    if (offlineAt && dto.payments.some((x) => x.method === 'VOUCHER')) throw new BadRequestException('Vouchers need a connection and cannot be used offline');
    const usesWallet = dto.payments.some((x) => x.method === 'WALLET');
    if (usesWallet && offlineAt) throw new BadRequestException('Wallet card payments need a connection and cannot be made offline');
    if (usesWallet && !opts.walletVerified) await this.wallet.verifyForPayment(dto.payments); // PIN checks, outside the transaction

    const shift = userId
      ? await this.prisma.shift.findFirst({ where: { storeId: dto.storeId, userId, status: 'OPEN' }, select: { id: true } })
      : null;

    let stockResults: MovementResult[] = [];
    let sale;
    try {
      sale = await this.prisma.$transaction(
        async (tx) => {
          // 1. Receipt number (locks the store row briefly so numbers never repeat).
          const [{ receipt_seq: seq }] = await tx.$queryRaw<{ receipt_seq: number }[]>`
            UPDATE stores SET receipt_seq = receipt_seq + 1 WHERE id = ${dto.storeId}::uuid RETURNING receipt_seq`;
          const receiptNo = `${store.code}-${String(seq).padStart(8, '0')}`;

          // Manager approval for a big discount: checked and used up in this transaction.
          const approvedBy = discountNeedsPin
            ? await this.approvals.consume(tx, p, dto.approvalId, { storeId: dto.storeId, action: 'DISCOUNT', percent: manualPercent, usedFor: receiptNo })
            : null;
          if (manualPercent > 0) {
            await this.audit.record(tx, p, {
              action: approvedBy ? 'DISCOUNT_APPROVED' : 'DISCOUNT', storeId: dto.storeId, entityType: 'sale', entityId: receiptNo, approvedBy,
              summary: `Manual discount ${manualPercent}% (${manualDiscount.toFixed(2)}) on ${receiptNo}${approvedBy ? `, approved by ${approvedBy.name}` : ''}`,
              details: { percent: manualPercent, amount: manualDiscount.toFixed(2), limit: discountLimit, offline: !!offlineAt },
            });
          }

          // Café mode: daily queue number (A001, A002...) in the store's time zone.
          let queueNo: string | undefined;
          if (store.hasKitchen) {
            const day = new Intl.DateTimeFormat('en-CA', { timeZone: REPORT_TIMEZONE }).format(offlineAt ?? new Date());
            const [{ seq: q }] = await tx.$queryRaw<{ seq: number }[]>`
              INSERT INTO store_day_counters (store_id, day, seq) VALUES (${dto.storeId}::uuid, ${day}::date, 1)
              ON CONFLICT (store_id, day) DO UPDATE SET seq = store_day_counters.seq + 1 RETURNING seq`;
            queueNo = 'A' + String(q).padStart(3, '0');
          }

          // 2. Save the sale.
          const created = await tx.sale.create({
            data: {
              receiptNo,
              clientRef: dto.clientRef,
              storeId: dto.storeId,
              shiftId: shift?.id,
              cashierId: userId,
              customerId: dto.customerId,
              channel: dto.channel ?? (p.kind === 'api_key' ? 'API' : 'POS'),
              orderType: dto.orderType ?? (store.hasKitchen ? 'TAKEAWAY' : 'RETAIL'),
              tableNo: dto.tableNo,
              queueNo,
              kitchenStatus: store.hasKitchen ? 'NEW' : 'NONE',
              subtotal: priced.subtotal,
              discountTotal: priced.discountTotal,
              taxTotal: priced.taxTotal,
              total: priced.total,
              pointsRedeemed: redeem,
              couponCodeId: coupon?.code.id,
              couponDiscount: coupon?.discount ?? 0,
              couponName: coupon ? `${coupon.campaign.name} (${coupon.code.code})` : undefined,
              pointsDiscount,
              amountDue,
              amountPaid: paid,
              changeDue,
              changeUsd: change.usd,
              changeKhr: change.khr,
              note: dto.note,
              ...(offlineAt && { createdAt: offlineAt }),
              items: {
                create: lines.map((l, i) => ({
                  lineNo: i + 1,
                  modifiers: l.modifiers.length ? l.modifiers : undefined,
                  note: l.item.note,
                  productId: l.prod.id,
                  sku: l.prod.sku,
                  name: l.prod.name,
                  nameKm: l.prod.nameKm,
                  quantity: l.item.quantity,
                  unitPrice: l.unitPrice,
                  costPrice: usage[i].unitCost !== null ? D(usage[i].unitCost!).toDecimalPlaces(6) : l.prod.costPrice,
                  discount: priced.lines[i].discount,
                  promotionId: l.promotionId,
                  promoDiscount: l.promo,
                  taxRate: priced.lines[i].taxRate,
                  netAmount: priced.lines[i].net,
                  taxAmount: priced.lines[i].tax,
                  lineTotal: priced.lines[i].total,
                })),
              },
              payments: {
                create: dto.payments.map((x) => ({
                  method: x.method, amount: x.amount, reference: x.reference,
                  ...(x.currency === 'KHR' && { currency: 'KHR', tendered: x.tendered, rate: x.rate }),
                })),
              },
            },
          });

          // KHQR payments must really be paid and can pay for one sale only.
          await this.khqr.claimForSale(tx, created.id, dto.storeId, dto.payments);

          if (dto.onlineOrderId) {
            const done = await tx.onlineOrder.updateMany({
              where: { id: dto.onlineOrderId, storeId: dto.storeId, status: { in: ['PAY_AT_COUNTER', 'PENDING_PAYMENT', 'FAILED'] } },
              data: { status: 'PAID', saleId: created.id, paidAt: new Date(), error: null },
            });
            if (!done.count) throw new BadRequestException('This online order was already paid or cancelled');
          }
          if (coupon) await this.coupons.redeem(tx, coupon, { saleId: created.id, storeId: dto.storeId, customerId: dto.customerId, discount: coupon.discount });
          for (const pay of dto.payments.filter((x) => x.method === 'VOUCHER')) {
            if (!pay.reference) throw new BadRequestException('Scan the voucher code');
            await this.vouchers.spend(tx, pay.reference, pay.amount, { saleId: created.id, storeId: dto.storeId });
          }

          // Wallet cards: take the money off the balance (fails the whole sale if not enough).
          for (const pay of dto.payments.filter((x) => x.method === 'WALLET')) {
            await this.wallet.debitForSale(tx, pay.reference!, pay.amount, { saleId: created.id, storeId: dto.storeId, shiftId: shift?.id, userId, receiptNo });
          }

          // 3. Take items and recipe ingredients out of stock, one change per product, sorted by
          //    product id so concurrent sales lock rows in the same order (no deadlocks).
          //    A missing ingredient never blocks a sale: its stock may go below zero (and shows as low).
          const deduct = new Map<string, { qty: Prisma.Decimal; sold: boolean; recipe: boolean }>();
          const bump = (id: string, q: Prisma.Decimal.Value, kind: 'sold' | 'recipe') => {
            const e = deduct.get(id) ?? { qty: D(0), sold: false, recipe: false };
            e.qty = e.qty.plus(q);
            e[kind] = true;
            deduct.set(id, e);
          };
          lines.forEach((l, i) => {
            if (l.prod.trackStock) bump(l.prod.id, l.item.quantity, 'sold');
            for (const [ingId, perUnit] of usage[i].perUnit) bump(ingId, D(perUnit).mul(l.item.quantity).toDecimalPlaces(3), 'recipe');
          });
          stockResults = [];
          for (const [productId, d] of [...deduct].sort(([a], [b]) => a.localeCompare(b))) {
            if (d.qty.isZero()) continue;
            stockResults.push(
              await this.stock.apply(tx, {
                storeId: dto.storeId,
                productId,
                delta: d.qty.neg(),
                type: d.sold ? 'SALE' : 'RECIPE',
                referenceType: 'SALE',
                referenceId: queueNo ? `${receiptNo} (${queueNo})` : receiptNo,
                userId,
                // Offline sales already happened in the real world, and ingredients never block a sale.
                ...((offlineAt || !d.sold) && { allowNegative: true }),
                ...(offlineAt && { note: 'Offline sale' }),
              }),
            );
          }

          // 4. Loyalty: use points, then earn points on the money actually paid.
          let pointsEarned = 0;
          if (dto.customerId) {
            if (redeem) await changePoints(tx, dto.customerId, -redeem, 'REDEEM', created.id);
            pointsEarned = pointsForAmount(amountDue);
            if (pointsEarned) await changePoints(tx, dto.customerId, pointsEarned, 'EARN', created.id);
            await tx.customer.update({
              where: { id: dto.customerId },
              data: { totalSpent: { increment: amountDue }, visitCount: { increment: 1 } },
            });
          }

          return tx.sale.update({ where: { id: created.id }, data: { pointsEarned }, include: receiptInclude });
        },
        { timeout: 15_000 },
      );
    } catch (e) {
      // Two requests with the same clientRef at the same moment: return the one that won.
      if (dto.clientRef && e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        const existing = await this.prisma.sale.findUnique({ where: { clientRef: dto.clientRef }, include: receiptInclude });
        if (existing) return existing;
      }
      throw e;
    }

    await this.webhooks.emit('sale.created', sale);
    await this.inventory.emitLowStock(stockResults);
    return sale;
  }

  /**
   * Prices a basket exactly like checkout does: store prices, drink options, recipes,
   * promotions, coupon and tax. Used by checkout and by the online-order quote.
   * `online` = only products available for online ordering.
   */
  private async buildPricing(
    dto: Pick<CreateSaleDto, 'storeId' | 'items' | 'couponCode' | 'customerId' | 'discount' | 'discountPercent'>,
    store: { taxRate: Prisma.Decimal },
    offlineAt?: Date,
    opts: { online?: boolean } = {},
  ) {
    // Load products with this store's price.
    const productIds = [...new Set(dto.items.map((i) => i.productId))];
    const products = await this.prisma.product.findMany({
      where: { id: { in: productIds } },
      include: { inventory: { where: { storeId: dto.storeId }, select: { priceOverride: true } } },
    });
    const byId = new Map(products.map((x) => [x.id, x]));
    for (const id of productIds) {
      const prod = byId.get(id);
      if (!prod) throw new BadRequestException(`Product ${id} not found`);
      if (!prod.isActive || prod.isIngredient) throw new BadRequestException(`Product ${prod.name} is not for sale`);
      if (opts.online && !prod.onlineAvailable) throw new BadRequestException(`${prod.name} cannot be ordered online`);
    }

    // Drink options: check them against the product's option groups and add their prices.
    const optionIds = [...new Set(dto.items.flatMap((i) => i.modifiers ?? []))];
    const options = optionIds.length
      ? await this.prisma.modifierOption.findMany({ where: { id: { in: optionIds } }, include: { group: true } })
      : [];
    const optionById = new Map(options.map((o) => [o.id, o]));
    const groupsByProduct = new Map<string, { groupId: string; group: { name: string; minSelect: number; maxSelect: number; isActive: boolean } }[]>();
    const links = await this.prisma.productModifierGroup.findMany({ where: { productId: { in: productIds } }, include: { group: true } });
    for (const l of links) groupsByProduct.set(l.productId, [...(groupsByProduct.get(l.productId) ?? []), l]);

    const baseLines = dto.items.map((i) => {
      const prod = byId.get(i.productId)!;
      const allowed = (groupsByProduct.get(prod.id) ?? []).filter((g) => g.group.isActive);
      const chosen = (i.modifiers ?? []).map((id) => {
        const o = optionById.get(id);
        if (!o || !o.isActive) throw new BadRequestException(`Option ${id} is not available`);
        if (!allowed.some((g) => g.groupId === o.groupId)) throw new BadRequestException(`"${o.name}" is not an option of ${prod.name}`);
        return o;
      });
      for (const g of allowed) {
        const n = chosen.filter((o) => o.groupId === g.groupId).length;
        if (n < g.group.minSelect) throw new BadRequestException(`Choose ${g.group.name} for ${prod.name}`);
        if (n > g.group.maxSelect) throw new BadRequestException(`Choose at most ${g.group.maxSelect} for ${g.group.name} (${prod.name})`);
      }
      const extra = chosen.reduce((t, o) => t.plus(o.priceDelta), D(0));
      const unitPrice = (prod.inventory[0]?.priceOverride ?? prod.sellPrice).plus(extra);
      if (unitPrice.isNegative()) throw new BadRequestException(`Options make ${prod.name} cost less than zero`);
      const modifiers = chosen.map((o) => ({ id: o.id, group: o.group.name, option: o.name, price: o.priceDelta.toString() }));
      return { item: i, prod, unitPrice, modifiers };
    });

    // Recipes: what each line uses up (beans, milk, cups...) and its real cost per unit.
    const usage = await this.recipes.usageForLines(baseLines.map((l) => ({ productId: l.prod.id, optionIds: l.modifiers.map((m) => m.id) })));

    // Promotions: same engine as the POS, evaluated at the time of sale (offline sales: when they happened).
    const promoResults = applyPromotions(
      baseLines.map((l) => ({ productId: l.prod.id, categoryId: l.prod.categoryId, price: l.unitPrice.toString(), quantity: l.item.quantity })),
      await this.promotions.forStore(dto.storeId),
      dto.storeId,
      offlineAt ?? new Date(),
      REPORT_TIMEZONE,
    );
    const lines = baseLines.map((l, i) => {
      const promo = D(promoResults[i].discount);
      const gross = l.unitPrice.mul(l.item.quantity).toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP);
      // Manual line discount on top of a promotion can never make the line negative.
      const manual = Prisma.Decimal.min(D(l.item.discount ?? 0), gross.minus(promo));
      return { ...l, promo, promotionId: promoResults[i].promotionId, lineDiscount: promo.plus(manual) };
    });

    // Coupon: checked here (clear errors), counted inside the transaction.
    let coupon: (CouponCheck & { discount: number }) | null = null;
    if (dto.couponCode) {
      if (offlineAt) throw new BadRequestException('Coupons need a connection and cannot be used offline');
      const base = lines.reduce((t, l) => t.plus(l.unitPrice.mul(l.item.quantity).toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP).minus(l.lineDiscount)), D(0));
      coupon = await this.coupons.check(dto.couponCode, { storeId: dto.storeId, customerId: dto.customerId, base: base.toNumber() });
    }

    let priced;
    try {
      priced = priceSale(
        lines.map((l) => ({ unitPrice: l.unitPrice, quantity: l.item.quantity, discount: l.lineDiscount, taxable: l.prod.taxable })),
        store.taxRate,
        { amount: D(dto.discount ?? 0).plus(coupon?.discount ?? 0).toNumber() || undefined, percent: dto.discountPercent },
      );
    } catch (e) {
      if (e instanceof PricingError) throw new BadRequestException(e.message);
      throw e;
    }

    return { lines, usage, coupon, priced: priced! };
  }

  /** Price a basket without saving anything (online ordering shows this before payment). */
  async quote(dto: Pick<CreateSaleDto, 'storeId' | 'items' | 'couponCode' | 'customerId'>, opts: { online?: boolean } = {}) {
    const store = await this.prisma.store.findUniqueOrThrow({ where: { id: dto.storeId } });
    const { lines, priced, coupon } = await this.buildPricing(dto, store, undefined, opts);
    return {
      lines: lines.map((l, i) => ({
        productId: l.prod.id, name: l.prod.name, nameKm: l.prod.nameKm, quantity: l.item.quantity, unitPrice: l.unitPrice, modifiers: l.modifiers, note: l.item.note ?? null,
        promotion: l.promotionId ? { id: l.promotionId, discount: l.promo } : null, total: priced.lines[i].total,
      })),
      subtotal: priced.subtotal, discountTotal: priced.discountTotal, taxTotal: priced.taxTotal, total: priced.total,
      coupon: coupon ? { code: coupon.code.code, name: coupon.campaign.name, discount: coupon.discount } : null,
    };
  }

  async list(p: Principal, q: SaleQueryDto) {
    const where: Prisma.SaleWhereInput = {
      ...storeScope(p, q.storeId),
      status: q.status,
      customerId: q.customerId,
      cashierId: q.cashierId,
      shiftId: q.shiftId,
      createdAt: dateFilter(q.from, q.to),
      ...(q.search && { receiptNo: { contains: q.search, mode: 'insensitive' } }),
    };
    const [rows, total] = await Promise.all([
      this.prisma.sale.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        include: {
          store: { select: { code: true, name: true } },
          cashier: { select: { fullName: true } },
          customer: { select: { name: true, code: true } },
          _count: { select: { items: true } },
        },
        ...pageArgs(q),
      }),
      this.prisma.sale.count({ where }),
    ]);
    return toPage(rows, total, q);
  }

  /** Full receipt by sale id or receipt number. */
  async get(p: Principal, idOrReceipt: string) {
    const isUuid = /^[0-9a-f-]{36}$/i.test(idOrReceipt);
    const sale = await this.prisma.sale.findUnique({
      where: isUuid ? { id: idOrReceipt } : { receiptNo: idOrReceipt },
      include: receiptInclude,
    });
    if (!sale) throw new NotFoundException('Sale not found');
    assertStoreAccess(p, sale.storeId);
    return sale;
  }

  /** Refund some or all items of a sale. Money, points and stock are reversed proportionally. */
  async refund(p: Principal, saleId: string, dto: CreateRefundDto, opts: { voidReason?: string; approvedBy?: { id: string; name: string } | null } = {}) {
    const userId = userIdOf(p);
    let stockResults: MovementResult[] = [];

    const result = await this.prisma.$transaction(
      async (tx) => {
        // Lock the sale so two refunds cannot run at the same time.
        await tx.$queryRaw`SELECT id FROM sales WHERE id = ${saleId}::uuid FOR UPDATE`;
        const sale = await tx.sale.findUnique({
          where: { id: saleId },
          include: {
            items: { orderBy: { lineNo: 'asc' }, include: { refundItems: true, product: { select: { trackStock: true } } } },
            refunds: true,
            payments: true,
          },
        });
        if (!sale) throw new NotFoundException('Sale not found');
        assertStoreAccess(p, sale.storeId);
        if (sale.status === 'REFUNDED' || sale.status === 'VOIDED') throw new BadRequestException(`Sale is already ${sale.status}`);
        const refundNo = `${sale.receiptNo}-R${sale.refunds.length + 1}`;

        // Cashier controls: cashiers refund with a manager PIN (if the store says so). Voids are approved by void().
        let approvedBy = opts.approvedBy ?? null;
        if (!opts.voidReason && p.kind === 'user' && p.role === Role.CASHIER) {
          const store = await tx.store.findUniqueOrThrow({ where: { id: sale.storeId }, select: { refundNeedsApproval: true } });
          if (store.refundNeedsApproval) approvedBy = await this.approvals.consume(tx, p, dto.approvalId, { storeId: sale.storeId, action: 'REFUND', saleId, usedFor: refundNo });
        }

        const itemsById = new Map(sale.items.map((i) => [i.id, i]));
        const requested = new Map<string, Prisma.Decimal>();
        for (const r of dto.items) {
          requested.set(r.saleItemId, (requested.get(r.saleItemId) ?? ZERO).plus(r.quantity));
        }

        let lineSum = ZERO;
        const refundItems: { saleItemId: string; quantity: Prisma.Decimal; amount: Prisma.Decimal }[] = [];
        for (const [saleItemId, qty] of requested) {
          const item = itemsById.get(saleItemId);
          if (!item) throw new BadRequestException(`Item ${saleItemId} is not part of this sale`);
          const left = item.quantity.minus(item.refundedQty);
          if (qty.gt(left)) throw new BadRequestException(`Only ${left} of ${item.name} can still be refunded`);
          // Last units of a line get the exact remaining amount, avoiding rounding drift.
          const alreadyAmount = item.refundItems.reduce((s, x) => s.plus(x.amount), ZERO);
          const amount = qty.eq(left)
            ? item.lineTotal.minus(alreadyAmount)
            : item.lineTotal.mul(qty).div(item.quantity).toDecimalPlaces(2);
          lineSum = lineSum.plus(amount);
          refundItems.push({ saleItemId, quantity: qty, amount });
        }

        const fullyRefunded = sale.items.every((i) => i.quantity.minus(i.refundedQty).eq(requested.get(i.id) ?? ZERO));
        const ratio = sale.total.gt(0) ? lineSum.div(sale.total) : ZERO;
        const prevReturned = sale.refunds.reduce((s, r) => s + r.pointsReturned, 0);
        const prevReversed = sale.refunds.reduce((s, r) => s + r.pointsReversed, 0);

        // Money back = items value minus the part that was paid with points.
        const amount = fullyRefunded
          ? sale.amountDue.minus(sale.refundedTotal)
          : lineSum.minus(sale.pointsDiscount.mul(ratio)).toDecimalPlaces(2);
        let pointsReturned = fullyRefunded ? sale.pointsRedeemed - prevReturned : Math.floor(sale.pointsRedeemed * ratio.toNumber());
        let pointsReversed = fullyRefunded ? sale.pointsEarned - prevReversed : Math.floor(sale.pointsEarned * ratio.toNumber());

        const refund = await tx.refund.create({
          data: {
            refundNo,
            saleId,
            userId,
            method: dto.method ?? 'CASH',
            amount,
            restock: dto.restock ?? true,
            reason: opts.voidReason ? `Void: ${opts.voidReason}`.slice(0, 500) : dto.reason,
            items: { create: refundItems },
          },
        });

        if (dto.method === 'VOUCHER') {
          const vPay = sale.payments.find((x) => x.method === 'VOUCHER');
          if (!vPay?.reference) throw new BadRequestException('This sale was not paid with a voucher');
          await this.vouchers.refund(tx, vPay.reference, amount, { saleId, storeId: sale.storeId });
        }
        if ((dto.method ?? 'CASH') === 'WALLET') {
          const walletPay = sale.payments.find((x) => x.method === 'WALLET');
          if (!walletPay?.reference) throw new BadRequestException('This sale was not paid with a wallet card');
          await this.wallet.creditRefund(tx, walletPay.reference, amount, { saleId, storeId: sale.storeId, userId, reference: refund.refundNo });
        }

        for (const ri of refundItems) {
          await tx.saleItem.update({ where: { id: ri.saleItemId }, data: { refundedQty: { increment: ri.quantity } } });
        }

        if (dto.restock ?? true) {
          const restockable = refundItems
            .filter((ri) => itemsById.get(ri.saleItemId)!.product.trackStock)
            .sort((a, b) => itemsById.get(a.saleItemId)!.productId.localeCompare(itemsById.get(b.saleItemId)!.productId));
          stockResults = [];
          for (const ri of restockable) {
            stockResults.push(
              await this.stock.apply(tx, {
                storeId: sale.storeId,
                productId: itemsById.get(ri.saleItemId)!.productId,
                delta: ri.quantity,
                type: 'REFUND',
                referenceType: 'REFUND',
                referenceId: refund.refundNo,
                userId,
              }),
            );
          }
        }

        if (sale.customerId) {
          if (pointsReturned > 0) await changePoints(tx, sale.customerId, pointsReturned, 'RETURN', saleId);
          // Never push the balance below zero if the customer already spent the points.
          const c = await tx.customer.findUniqueOrThrow({ where: { id: sale.customerId }, select: { points: true } });
          pointsReversed = Math.min(pointsReversed, c.points);
          if (pointsReversed > 0) await changePoints(tx, sale.customerId, -pointsReversed, 'REVERSE', saleId);
          await tx.customer.update({ where: { id: sale.customerId }, data: { totalSpent: { decrement: amount } } });
        } else {
          pointsReturned = 0;
          pointsReversed = 0;
        }

        await tx.refund.update({ where: { id: refund.id }, data: { pointsReturned, pointsReversed } });
        await tx.sale.update({
          where: { id: saleId },
          data: { status: opts.voidReason ? 'VOIDED' : fullyRefunded ? 'REFUNDED' : 'PARTIALLY_REFUNDED', refundedTotal: { increment: amount } },
        });
        await this.audit.record(tx, p, {
          action: opts.voidReason ? 'VOID' : 'REFUND', storeId: sale.storeId, entityType: 'sale', entityId: sale.receiptNo, approvedBy,
          summary: opts.voidReason
            ? `Voided ${sale.receiptNo} (${amount.toFixed(2)}): ${opts.voidReason}${approvedBy ? `, approved by ${approvedBy.name}` : ''}`
            : `Refund ${refundNo}: ${amount.toFixed(2)} by ${dto.method ?? 'CASH'}${dto.reason ? ` (${dto.reason})` : ''}${approvedBy ? `, approved by ${approvedBy.name}` : ''}`,
          details: { refundNo, amount: amount.toFixed(2), method: dto.method ?? 'CASH', restock: dto.restock ?? true, items: refundItems.map((r) => ({ name: itemsById.get(r.saleItemId)!.name, quantity: r.quantity.toString() })) },
        });

        return tx.refund.findUniqueOrThrow({ where: { id: refund.id }, include: { items: true } });
      },
      { timeout: 15_000 },
    );

    await this.webhooks.emit('sale.refunded', result);
    return result;
  }

  /**
   * Void: cancel a whole sale from today (wrong order, customer changed their mind) and give everything
   * back the way it was paid. Older or part-refunded sales use Refund.
   */
  async void(p: Principal, saleId: string, dto: VoidSaleDto) {
    const sale = await this.prisma.sale.findUnique({ where: { id: saleId }, include: { items: true, payments: true, refunds: { select: { id: true } }, store: { select: { voidNeedsApproval: true } } } });
    if (!sale) throw new NotFoundException('Sale not found');
    assertStoreAccess(p, sale.storeId);
    if (sale.status !== 'COMPLETED' || sale.refunds.length) throw new BadRequestException(`Only untouched sales can be voided (this one is ${sale.status.toLowerCase().replace('_', ' ')}); use Refund`);
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: REPORT_TIMEZONE }).format(new Date());
    if (new Intl.DateTimeFormat('en-CA', { timeZone: REPORT_TIMEZONE }).format(sale.createdAt) !== today) throw new BadRequestException('Only sales from today can be voided; use Refund');
    const methods = [...new Set(sale.payments.map((x) => x.method))];
    if (methods.length > 1) throw new BadRequestException('This sale was paid in more than one way; use Refund');
    let approvedBy: { id: string; name: string } | null = null;
    if (p.kind === 'user' && p.role === Role.CASHIER && sale.store.voidNeedsApproval) {
      approvedBy = await this.prisma.$transaction((tx) => this.approvals.consume(tx, p, dto.approvalId, { storeId: sale.storeId, action: 'VOID', saleId, usedFor: sale.receiptNo }));
    }
    await this.refund(
      p, saleId,
      { items: sale.items.map((i) => ({ saleItemId: i.id, quantity: Number(i.quantity) })), method: methods[0] ?? 'CASH', restock: dto.restock ?? true },
      { voidReason: dto.reason, approvedBy },
    );
    return this.get(p, saleId);
  }
}

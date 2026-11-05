import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { randomInt } from 'crypto';
import { config } from '../config';
import { PageQueryDto, pageArgs, toPage } from '../common/pagination';
import { PrismaService } from '../prisma/prisma.service';
import { WebhooksService } from '../webhooks/webhooks.service';
import { AdjustPointsDto, CreateCustomerDto, CustomerQueryDto, UpdateCustomerDto } from './customers.dto';
import { changePoints, valueOfPoints } from './loyalty';

/** Customers are shared by all stores, so a member can earn and redeem points anywhere. */
@Injectable()
export class CustomersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly webhooks: WebhooksService,
  ) {}

  async list(q: CustomerQueryDto) {
    const where: Prisma.CustomerWhereInput = q.search
      ? {
          OR: [
            { name: { contains: q.search, mode: 'insensitive' } },
            { phone: { contains: q.search } },
            { email: { contains: q.search, mode: 'insensitive' } },
            { code: q.search },
          ],
        }
      : {};
    const [rows, total] = await Promise.all([
      this.prisma.customer.findMany({ where, orderBy: { createdAt: 'desc' }, ...pageArgs(q) }),
      this.prisma.customer.count({ where }),
    ]);
    return toPage(rows, total, q);
  }

  async get(id: string) {
    const c = await this.prisma.customer.findUniqueOrThrow({ where: { id } });
    return { ...c, pointsValue: valueOfPoints(c.points) };
  }

  /** POS: find a member by phone or card number. */
  async lookup(code: string) {
    const c = await this.prisma.customer.findFirst({ where: { isActive: true, OR: [{ phone: code }, { code }] } });
    if (!c) throw new NotFoundException('Customer not found');
    return { ...c, pointsValue: valueOfPoints(c.points) };
  }

  async create(dto: CreateCustomerDto) {
    const customer = await this.prisma.customer.create({
      data: { ...dto, code: dto.code ?? `M${Date.now().toString().slice(-8)}${randomInt(10, 99)}` },
    });
    await this.webhooks.emit('customer.created', customer);
    return customer;
  }

  update(id: string, dto: UpdateCustomerDto) {
    return this.prisma.customer.update({ where: { id }, data: dto });
  }

  async adjustPoints(id: string, dto: AdjustPointsDto) {
    const balance = await this.prisma.$transaction((tx) => changePoints(tx, id, dto.points, 'ADJUST', undefined, dto.reason));
    return { points: balance };
  }

  async history(id: string, q: PageQueryDto) {
    const where = { customerId: id };
    const [rows, total] = await Promise.all([
      this.prisma.loyaltyTransaction.findMany({ where, orderBy: { id: 'desc' }, ...pageArgs(q) }),
      this.prisma.loyaltyTransaction.count({ where }),
    ]);
    return toPage(rows, total, q);
  }

  async purchases(id: string, q: PageQueryDto) {
    const where = { customerId: id };
    const [rows, total] = await Promise.all([
      this.prisma.sale.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        select: { id: true, receiptNo: true, total: true, status: true, pointsEarned: true, pointsRedeemed: true, createdAt: true, store: { select: { code: true, name: true } } },
        ...pageArgs(q),
      }),
      this.prisma.sale.count({ where }),
    ]);
    return toPage(rows, total, q);
  }

  loyaltyRules() {
    return { earnRate: config.loyaltyEarnRate, pointValue: config.loyaltyPointValue };
  }
}

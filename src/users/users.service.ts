// Copyright (c) 2026 Chea Phearom. All rights reserved.
// Proprietary and confidential: see the LICENSE file.
import { ForbiddenException, Injectable } from '@nestjs/common';
import { Prisma, Role } from '@prisma/client';
import * as bcrypt from 'bcryptjs';
import { pageArgs, toPage } from '../common/pagination';
import { assertStoreAccess, hasPermission, Principal } from '../common/principal';
import { PrismaService } from '../prisma/prisma.service';
import { CreateUserDto, UpdateUserDto, UserQueryDto } from './users.dto';

const userSelect = {
  id: true, email: true, fullName: true, phone: true, role: true, isActive: true, permissions: true,
  lastLoginAt: true, createdAt: true,
  stores: { select: { store: { select: { id: true, code: true, name: true } } } },
} satisfies Prisma.UserSelect;

@Injectable()
export class UsersService {
  constructor(private readonly prisma: PrismaService) {}

  async list(p: Principal, q: UserQueryDto) {
    const where: Prisma.UserWhereInput = {
      role: q.role,
      ...(q.search && {
        OR: [
          { fullName: { contains: q.search, mode: 'insensitive' } },
          { email: { contains: q.search, mode: 'insensitive' } },
        ],
      }),
    };
    if (q.storeId) {
      assertStoreAccess(p, q.storeId);
      where.stores = { some: { storeId: q.storeId } };
    } else if (p.storeIds !== 'ALL') {
      where.stores = { some: { storeId: { in: p.storeIds } } };
    }
    const [rows, total] = await Promise.all([
      this.prisma.user.findMany({ where, select: userSelect, orderBy: { createdAt: 'desc' }, ...pageArgs(q) }),
      this.prisma.user.count({ where }),
    ]);
    return toPage(rows.map(flatten), total, q);
  }

  async get(p: Principal, id: string) {
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id }, select: userSelect });
    this.assertCanManage(p, user.role, user.stores.map((s) => s.store.id), true);
    return flatten(user);
  }

  async create(p: Principal, dto: CreateUserDto) {
    const storeIds = allStores(dto.role) ? [] : (dto.storeIds ?? []);
    this.assertCanManage(p, dto.role, storeIds);
    if (dto.permissions?.length && (p.role !== Role.SUPER_ADMIN || dto.role !== Role.ADMIN)) throw new ForbiddenException('Only a super admin gives permissions, and only to admins');
    const user = await this.prisma.user.create({
      data: {
        email: dto.email.toLowerCase(),
        passwordHash: await bcrypt.hash(dto.password, 10),
        fullName: dto.fullName,
        phone: dto.phone,
        role: dto.role,
        permissions: dto.role === Role.ADMIN ? dto.permissions ?? [] : [],
        stores: { create: storeIds.map((storeId) => ({ storeId })) },
      },
      select: userSelect,
    });
    return flatten(user);
  }

  async update(p: Principal, id: string, dto: UpdateUserDto) {
    const existing = await this.prisma.user.findUniqueOrThrow({ where: { id }, include: { stores: true } });
    this.assertCanManage(p, existing.role, existing.stores.map((s) => s.storeId));
    const role = dto.role ?? existing.role;
    if (dto.role || dto.storeIds) this.assertCanManage(p, role, dto.storeIds ?? existing.stores.map((s) => s.storeId));
    if (id === p.id && (dto.isActive === false || (dto.role && dto.role !== existing.role))) {
      throw new ForbiddenException('You cannot deactivate yourself or change your own role');
    }
    if (dto.permissions !== undefined && p.role !== Role.SUPER_ADMIN) throw new ForbiddenException('Only a super admin changes permissions');

    const user = await this.prisma.$transaction(async (tx) => {
      if (dto.storeIds) {
        await tx.storeUser.deleteMany({ where: { userId: id } });
        if (!allStores(role)) {
          await tx.storeUser.createMany({ data: dto.storeIds.map((storeId) => ({ storeId, userId: id })) });
        }
      }
      return tx.user.update({
        where: { id },
        data: {
          email: dto.email?.toLowerCase(),
          fullName: dto.fullName,
          phone: dto.phone,
          role: dto.role,
          // permissions belong to admins only: cleared when the role changes to something else
          ...(role === Role.ADMIN ? (dto.permissions !== undefined && { permissions: dto.permissions }) : { permissions: [] }),
          isActive: dto.isActive,
          ...(dto.password && { passwordHash: await bcrypt.hash(dto.password, 10) }),
        },
        select: userSelect,
      });
    });
    if (dto.isActive === false || dto.password) {
      await this.prisma.refreshToken.updateMany({ where: { userId: id, revokedAt: null }, data: { revokedAt: new Date() } });
    }
    return flatten(user);
  }

  /**
   * Super admins manage everyone. Admins with the Users permission manage store managers and cashiers in every
   * store; other admins, like store managers, manage cashiers. Nobody but a super admin touches super admins or
   * admins. Store managers may only manage cashiers in their own stores (and may view other managers there).
   */
  private assertCanManage(p: Principal, targetRole: Role, targetStores: string[], readOnly = false) {
    if (p.role === Role.SUPER_ADMIN) return;
    if (p.role === Role.ADMIN) {
      if (readOnly) return;
      const ok = targetRole === Role.CASHIER || (targetRole === Role.STORE_MANAGER && hasPermission(p, 'users'));
      if (!ok) throw new ForbiddenException(targetRole === Role.STORE_MANAGER ? 'A super admin has not allowed you to manage store managers' : 'Only a super admin manages super admins and admins');
      return;
    }
    const allowedRole = readOnly ? targetRole !== Role.SUPER_ADMIN : targetRole === Role.CASHIER;
    if (!allowedRole) throw new ForbiddenException('Store managers can only manage cashiers');
    if (!targetStores.length && !readOnly) throw new ForbiddenException('Assign the user to at least one of your stores');
    targetStores.forEach((s) => assertStoreAccess(p, s));
  }
}

/** Super admins and admins work in every store (no store list). */
const allStores = (role: Role) => role === Role.SUPER_ADMIN || role === Role.ADMIN;

function flatten<T extends { stores: { store: unknown }[] }>(u: T) {
  return { ...u, stores: u.stores.map((s) => s.store) };
}

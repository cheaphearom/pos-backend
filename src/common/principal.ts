// Copyright (c) 2026 Chea Phearom. All rights reserved.
// Proprietary and confidential: see the LICENSE file.
import { ForbiddenException } from '@nestjs/common';
import { Role } from '@prisma/client';

/** Who is calling the API: a logged-in staff user, or another system using an API key. */
export interface Principal {
  kind: 'user' | 'api_key';
  id: string;
  name: string;
  role?: Role; // users only
  scopes: string[]; // api keys only
  /** Store ids this caller may touch; 'ALL' for super admins, admins and unrestricted keys. */
  storeIds: string[] | 'ALL';
  /** ADMIN users: the owner areas a super admin allowed (common/permissions.ts) */
  permissions?: string[];
}

/** Super admin, or an admin allowed this owner area. */
export const hasPermission = (p: Principal, key: string) =>
  p.kind === 'user' && (p.role === 'SUPER_ADMIN' || (p.role === 'ADMIN' && !!p.permissions?.includes(key)));

export function canAccessStore(p: Principal, storeId: string): boolean {
  return p.storeIds === 'ALL' || p.storeIds.includes(storeId);
}

export function assertStoreAccess(p: Principal, storeId: string): void {
  if (!canAccessStore(p, storeId)) {
    throw new ForbiddenException('You do not have access to this store');
  }
}

/** Prisma `where` fragment limiting rows to the caller's stores. */
export function storeScope(p: Principal, storeId?: string): { storeId?: string | { in: string[] } } {
  if (storeId) {
    assertStoreAccess(p, storeId);
    return { storeId };
  }
  return p.storeIds === 'ALL' ? {} : { storeId: { in: p.storeIds } };
}

export const userIdOf = (p: Principal) => (p.kind === 'user' ? p.id : null);

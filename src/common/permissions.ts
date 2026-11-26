// Copyright (c) 2026 Chea Phearom. All rights reserved.
// Proprietary and confidential: see the LICENSE file.
/**
 * What an ADMIN may do on top of everything a store manager does (in all stores). A super admin ticks them per
 * admin in Users. Endpoints that are super admin only carry @Permission(key): an admin with that key may use them;
 * super admin only endpoints without a key (API docs, fault testing) stay for super admins.
 *
 * pos-frontend keeps the same list in src/utils/permissions.ts (labels for the tick boxes).
 */
export const ADMIN_PERMISSIONS = {
  products: 'Products & prices (new products, photos, size prices, bulk and scheduled prices, import)',
  catalogue: 'Categories, drink options & recipes',
  marketing: 'Promotions, coupons & gift vouchers',
  wallet: 'Create wallet cards',
  stores: 'Create stores',
  users: 'Manage store managers and cashiers (all stores)',
  display: 'Customer display slides',
  integrations: 'Integrations: API keys, webhooks, BROWN menu sync',
  monitor: 'System monitor & Telegram summary',
} as const;

export type AdminPermission = keyof typeof ADMIN_PERMISSIONS;
export const ADMIN_PERMISSION_KEYS = Object.keys(ADMIN_PERMISSIONS) as AdminPermission[];

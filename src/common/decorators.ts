// Copyright (c) 2026 Chea Phearom. All rights reserved.
// Proprietary and confidential: see the LICENSE file.
import { createParamDecorator, ExecutionContext, SetMetadata } from '@nestjs/common';
import { Role } from '@prisma/client';
import { Principal } from './principal';

export const IS_PUBLIC = 'isPublic';
export const ROLES = 'roles';
export const SCOPES = 'scopes';

/** No authentication required. */
export const Public = () => SetMetadata(IS_PUBLIC, true);

/** Staff roles allowed (SUPER_ADMIN is always allowed). No decorator = any logged-in user. */
export const Roles = (...roles: Role[]) => SetMetadata(ROLES, roles);

export const PERMISSION = 'adminPermission';
/** On a super admin only endpoint: an ADMIN with this permission (common/permissions.ts) may use it too. */
export const Permission = (key: import('./permissions').AdminPermission) => SetMetadata(PERMISSION, key);

/**
 * API-key scopes that may call this endpoint (any one of them).
 * Endpoints without @Scopes cannot be called with an API key.
 */
export const Scopes = (...scopes: string[]) => SetMetadata(SCOPES, scopes);

export const CurrentPrincipal = createParamDecorator(
  (_: unknown, ctx: ExecutionContext): Principal => ctx.switchToHttp().getRequest().principal,
);

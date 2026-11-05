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

/**
 * API-key scopes that may call this endpoint (any one of them).
 * Endpoints without @Scopes cannot be called with an API key.
 */
export const Scopes = (...scopes: string[]) => SetMetadata(SCOPES, scopes);

export const CurrentPrincipal = createParamDecorator(
  (_: unknown, ctx: ExecutionContext): Principal => ctx.switchToHttp().getRequest().principal,
);

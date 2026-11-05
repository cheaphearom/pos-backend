import { Body, Controller, Delete, Get, HttpCode, Injectable, Module, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Role } from '@prisma/client';
import { ArrayMinSize, IsArray, IsDateString, IsIn, IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';
import { createHash, randomBytes } from 'crypto';
import { CurrentPrincipal, Roles } from '../common/decorators';
import { Principal } from '../common/principal';
import { PrismaService } from '../prisma/prisma.service';

/** Permissions an API key can be given. '*' = everything. */
export const API_SCOPES = [
  'stores:read',
  'products:read',
  'products:write',
  'inventory:read',
  'inventory:write',
  'customers:read',
  'customers:write',
  'sales:read',
  'sales:write',
  'sales:refund',
  'reports:read',
  '*',
] as const;

export class CreateApiKeyDto {
  /** Who uses this key, e.g. "Accounting system" */
  @IsString() @MaxLength(100)
  name: string;

  @IsArray() @ArrayMinSize(1) @IsIn(API_SCOPES, { each: true })
  scopes: string[];

  /** Limit the key to one store (leave empty for all stores) */
  @IsOptional() @IsUUID()
  storeId?: string;

  @IsOptional() @IsDateString()
  expiresAt?: string;
}

@Injectable()
export class ApiKeysService {
  constructor(private readonly prisma: PrismaService) {}

  list() {
    return this.prisma.apiKey.findMany({
      orderBy: { createdAt: 'desc' },
      omit: { keyHash: true },
      include: { store: { select: { code: true, name: true } } },
    });
  }

  async create(p: Principal, dto: CreateApiKeyDto) {
    const key = `pos_${randomBytes(24).toString('base64url')}`;
    const record = await this.prisma.apiKey.create({
      data: {
        name: dto.name,
        scopes: dto.scopes,
        storeId: dto.storeId,
        expiresAt: dto.expiresAt ? new Date(dto.expiresAt) : undefined,
        prefix: key.slice(0, 12),
        keyHash: createHash('sha256').update(key).digest('hex'),
        createdById: p.id,
      },
      omit: { keyHash: true },
    });
    return { ...record, key, warning: 'Copy this key now. It will not be shown again.' };
  }

  revoke(id: string) {
    return this.prisma.apiKey.update({ where: { id }, data: { revokedAt: new Date() }, omit: { keyHash: true } });
  }
}

@ApiTags('Integrations: API keys')
@ApiBearerAuth()
@Roles(Role.SUPER_ADMIN)
@Controller('api-keys')
export class ApiKeysController {
  constructor(private readonly keys: ApiKeysService) {}

  @Get('scopes')
  scopes() {
    return API_SCOPES;
  }

  @Get()
  list() {
    return this.keys.list();
  }

  /** Create a key for another system. The full key is returned only once. */
  @Post()
  create(@CurrentPrincipal() p: Principal, @Body() dto: CreateApiKeyDto) {
    return this.keys.create(p, dto);
  }

  @Delete(':id')
  @HttpCode(200)
  revoke(@Param('id', ParseUUIDPipe) id: string) {
    return this.keys.revoke(id);
  }
}

@Module({ controllers: [ApiKeysController], providers: [ApiKeysService] })
export class ApiKeysModule {}

// Copyright (c) 2026 Chea Phearom. All rights reserved.
// Proprietary and confidential: see the LICENSE file.
/**
 * Pictures for the customer display. A super admin uploads them in the admin portal (for every store or one),
 * the POS asks which are showing now, and the display loads each picture from its own address.
 *
 * Upload: POST /display-slides?title=…&storeId=… with the picture itself as the body (Content-Type image/jpeg,
 * image/png or image/webp, at most 5 MB). The picture address is public (an <img> sends no token); its id is a
 * random UUID, and the address carries ?v= so a changed slide is fetched again while others stay cached.
 */
import { BadRequestException, Body, Controller, Delete, Get, Headers, HttpCode, Injectable, Module, NotFoundException, Param, ParseUUIDPipe, Patch, Post, Query, Res } from '@nestjs/common';
import { ApiBearerAuth, ApiSecurity, ApiTags } from '@nestjs/swagger';
import { Role } from '@prisma/client';
import { IsBoolean, IsDateString, IsIn, IsOptional, IsString, IsUUID, MaxLength, MinLength, ValidateIf } from 'class-validator';
import type { Response } from 'express';
import { CurrentPrincipal, Public, Roles, Scopes } from '../common/decorators';
import { assertStoreAccess, Principal } from '../common/principal';
import { PrismaService } from '../prisma/prisma.service';

export const MAX_SLIDE_BYTES = 5 * 1024 * 1024;
export const SLIDE_TYPES = ['image/jpeg', 'image/png', 'image/webp'];

/** Checks the file's first bytes, so a renamed file of another kind is refused. */
export function sniffImage(buf: Buffer): string | null {
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (buf.length >= 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  return null;
}

export class UploadSlideQuery {
  @IsString() @MinLength(1) @MaxLength(120)
  title: string;

  /** Empty = every store */
  @IsOptional() @IsUUID()
  storeId?: string;
}

export class UpdateSlideDto {
  @IsOptional() @IsString() @MinLength(1) @MaxLength(120)
  title?: string;

  /** null = every store */
  @IsOptional() @ValidateIf((_, v) => v !== null) @IsUUID()
  storeId?: string | null;

  @IsOptional() @IsBoolean()
  isActive?: boolean;

  @IsOptional() @ValidateIf((_, v) => v !== null) @IsDateString()
  startsAt?: string | null;

  @IsOptional() @ValidateIf((_, v) => v !== null) @IsDateString()
  endsAt?: string | null;
}

export class MoveSlideDto {
  @IsIn(['up', 'down', 'top', 'bottom'])
  move: 'up' | 'down' | 'top' | 'bottom';
}

const listSelect = {
  id: true, storeId: true, title: true, mimeType: true, sizeBytes: true, sortOrder: true, isActive: true,
  startsAt: true, endsAt: true, createdAt: true, updatedAt: true, store: { select: { code: true, name: true } },
} as const;

/** The picture's address, with ?v= so a changed picture is not taken from the cache. */
export const imageUrl = (s: { id: string; updatedAt: Date }) => `/api/v1/display-slides/${s.id}/image?v=${s.updatedAt.getTime()}`;

@Injectable()
export class DisplayService {
  constructor(private readonly prisma: PrismaService) {}

  async list() {
    const rows = await this.prisma.displaySlide.findMany({ select: listSelect, orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }] });
    return rows.map((r) => ({ ...r, imageUrl: imageUrl(r) }));
  }

  /** Slides showing now in one store: active, for this store or every store, inside their dates. */
  async active(storeId: string, now = new Date()) {
    const rows = await this.prisma.displaySlide.findMany({
      where: {
        isActive: true,
        OR: [{ storeId: null }, { storeId }],
        AND: [{ OR: [{ startsAt: null }, { startsAt: { lte: now } }] }, { OR: [{ endsAt: null }, { endsAt: { gt: now } }] }],
      },
      select: { id: true, title: true, updatedAt: true, endsAt: true },
      orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
    });
    return rows.map((r) => ({ id: r.id, title: r.title, imageUrl: imageUrl(r), endsAt: r.endsAt }));
  }

  async upload(body: unknown, contentType: string | undefined, q: UploadSlideQuery) {
    if (!Buffer.isBuffer(body) || !body.length) {
      throw new BadRequestException('Send the picture itself as the body, as a JPG, PNG or WebP file (at most 5 MB)');
    }
    if (body.length > MAX_SLIDE_BYTES) throw new BadRequestException('The picture is larger than 5 MB');
    const kind = sniffImage(body);
    if (!kind) throw new BadRequestException('This file is not a JPG, PNG or WebP picture');
    if (contentType && SLIDE_TYPES.includes(contentType.split(';')[0].trim()) === false) throw new BadRequestException('Use a JPG, PNG or WebP picture');
    if (q.storeId && !(await this.prisma.store.findUnique({ where: { id: q.storeId }, select: { id: true } }))) throw new BadRequestException('Store not found');
    const last = await this.prisma.displaySlide.aggregate({ _max: { sortOrder: true } });
    const row = await this.prisma.displaySlide.create({
      data: { title: q.title.trim(), storeId: q.storeId || null, mimeType: kind, image: new Uint8Array(body), sizeBytes: body.length, sortOrder: (last._max.sortOrder ?? 0) + 10 },
      select: listSelect,
    });
    return { ...row, imageUrl: imageUrl(row) };
  }

  async update(id: string, dto: UpdateSlideDto) {
    const cur = await this.prisma.displaySlide.findUnique({ where: { id }, select: { startsAt: true, endsAt: true } });
    if (!cur) throw new NotFoundException('Picture not found');
    const startsAt = dto.startsAt === undefined ? cur.startsAt : dto.startsAt ? new Date(dto.startsAt) : null;
    const endsAt = dto.endsAt === undefined ? cur.endsAt : dto.endsAt ? new Date(dto.endsAt) : null;
    if (startsAt && endsAt && endsAt <= startsAt) throw new BadRequestException('End must be after start');
    if (dto.storeId && !(await this.prisma.store.findUnique({ where: { id: dto.storeId }, select: { id: true } }))) throw new BadRequestException('Store not found');
    const row = await this.prisma.displaySlide.update({
      where: { id },
      data: {
        ...(dto.title !== undefined && { title: dto.title.trim() }),
        ...(dto.storeId !== undefined && { storeId: dto.storeId }),
        ...(dto.isActive !== undefined && { isActive: dto.isActive }),
        startsAt, endsAt,
      },
      select: listSelect,
    });
    return { ...row, imageUrl: imageUrl(row) };
  }

  /** One step up or down, or straight to the top or bottom; then numbered 10, 20, 30… */
  async move(id: string, dir: MoveSlideDto['move']) {
    return this.prisma.$transaction(async (tx) => {
      const ids = (await tx.displaySlide.findMany({ select: { id: true }, orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }] })).map((r) => r.id);
      const i = ids.indexOf(id);
      if (i < 0) throw new NotFoundException('Picture not found');
      if (dir === 'top' || dir === 'bottom') {
        ids.splice(i, 1);
        if (dir === 'top') ids.unshift(id);
        else ids.push(id);
      } else {
        const j = dir === 'up' ? i - 1 : i + 1;
        if (j >= 0 && j < ids.length) [ids[i], ids[j]] = [ids[j], ids[i]];
      }
      // sortOrder only: updatedAt (and so the picture's address) stays the same
      for (const [k, rid] of ids.entries()) await tx.$executeRaw`UPDATE display_slides SET sort_order = ${(k + 1) * 10} WHERE id = ${rid}::uuid`;
      return { order: ids };
    });
  }

  async remove(id: string) {
    const n = await this.prisma.displaySlide.deleteMany({ where: { id } });
    if (!n.count) throw new NotFoundException('Picture not found');
  }

  async image(id: string) {
    const row = await this.prisma.displaySlide.findUnique({ where: { id }, select: { image: true, mimeType: true } });
    if (!row) throw new NotFoundException('Picture not found');
    return row;
  }
}

@ApiTags('Customer display')
@ApiBearerAuth()
@ApiSecurity('api-key')
@Controller('display-slides')
export class DisplayController {
  constructor(private readonly display: DisplayService) {}

  /** Every picture (without the picture data), for the admin page. */
  @Roles(Role.SUPER_ADMIN)
  @Scopes('products:read')
  @Get()
  list() {
    return this.display.list();
  }

  /** The pictures showing now in a store: what the POS passes to its customer display. */
  @Scopes('products:read')
  @Get('active')
  active(@CurrentPrincipal() p: Principal, @Query('storeId', new ParseUUIDPipe()) storeId: string) {
    assertStoreAccess(p, storeId);
    return this.display.active(storeId);
  }

  /** The picture itself. Public, so the customer display can show it with a plain <img>. */
  @Public()
  @Get(':id/image')
  async image(@Param('id', new ParseUUIDPipe()) id: string, @Res() res: Response) {
    const row = await this.display.image(id);
    res.setHeader('Content-Type', row.mimeType);
    res.setHeader('Cache-Control', 'public, max-age=604800, immutable');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.send(Buffer.from(row.image));
  }

  @Roles(Role.SUPER_ADMIN)
  @Scopes('products:write')
  @Post()
  upload(@Body() body: Buffer, @Headers('content-type') contentType: string | undefined, @Query() q: UploadSlideQuery) {
    return this.display.upload(body, contentType, q);
  }

  @Roles(Role.SUPER_ADMIN)
  @Scopes('products:write')
  @Patch(':id')
  update(@Param('id', new ParseUUIDPipe()) id: string, @Body() dto: UpdateSlideDto) {
    return this.display.update(id, dto);
  }

  @Roles(Role.SUPER_ADMIN)
  @Scopes('products:write')
  @Post(':id/move')
  @HttpCode(200)
  move(@Param('id', new ParseUUIDPipe()) id: string, @Body() dto: MoveSlideDto) {
    return this.display.move(id, dto.move);
  }

  @Roles(Role.SUPER_ADMIN)
  @Scopes('products:write')
  @Delete(':id')
  @HttpCode(204)
  async remove(@Param('id', new ParseUUIDPipe()) id: string) {
    await this.display.remove(id);
  }
}

@Module({
  controllers: [DisplayController],
  providers: [DisplayService],
})
export class DisplayModule {}

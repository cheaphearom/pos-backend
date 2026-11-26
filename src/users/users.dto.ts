// Copyright (c) 2026 Chea Phearom. All rights reserved.
// Proprietary and confidential: see the LICENSE file.
import { PartialType } from '@nestjs/swagger';
import { Role } from '@prisma/client';
import { ArrayUnique, IsArray, IsBoolean, IsEmail, IsEnum, IsIn, IsOptional, IsString, IsUUID, MaxLength, MinLength } from 'class-validator';
import { ADMIN_PERMISSION_KEYS } from '../common/permissions';
import { PageQueryDto } from '../common/pagination';

export class CreateUserDto {
  @IsEmail()
  email: string;

  @IsString() @MinLength(8)
  password: string;

  @IsString() @MaxLength(150)
  fullName: string;

  @IsOptional() @IsString() @MaxLength(30)
  phone?: string;

  @IsEnum(Role)
  role: Role;

  /** ADMIN only: owner areas allowed (src/common/permissions.ts); only a super admin sets them */
  @IsOptional() @IsArray() @ArrayUnique() @IsIn(ADMIN_PERMISSION_KEYS, { each: true })
  permissions?: string[];

  /** Stores this user can work in (ignored for SUPER_ADMIN and ADMIN: all stores) */
  @IsOptional() @IsArray() @ArrayUnique() @IsUUID('all', { each: true })
  storeIds?: string[];
}

export class UpdateUserDto extends PartialType(CreateUserDto) {
  @IsOptional() @IsBoolean()
  isActive?: boolean;
}

export class UserQueryDto extends PageQueryDto {
  @IsOptional() @IsString()
  search?: string;

  @IsOptional() @IsEnum(Role)
  role?: Role;

  @IsOptional() @IsUUID()
  storeId?: string;
}

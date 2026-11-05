import { PartialType } from '@nestjs/swagger';
import { Role } from '@prisma/client';
import { ArrayUnique, IsArray, IsBoolean, IsEmail, IsEnum, IsOptional, IsString, IsUUID, MaxLength, MinLength } from 'class-validator';
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

  /** Stores this user can work in (ignored for SUPER_ADMIN) */
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

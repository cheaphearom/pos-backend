import { PartialType } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsBoolean, IsNumber, IsOptional, IsString, Length, Matches, Max, MaxLength, Min, ValidateIf } from 'class-validator';

export class CreateStoreDto {
  /** Short unique code used in receipt numbers, e.g. PP01 */
  @Matches(/^[A-Z0-9]{2,20}$/, { message: 'code must be 2-20 uppercase letters or digits' })
  code: string;

  @IsString() @MaxLength(150)
  name: string;

  @IsOptional() @IsString()
  address?: string;

  @IsOptional() @IsString() @MaxLength(30)
  phone?: string;

  /** ISO currency code */
  @IsOptional() @IsString() @Length(3, 3)
  currency?: string;

  /** Tax rate as a fraction: 0.1 = 10% */
  @IsOptional() @Type(() => Number) @IsNumber({ maxDecimalPlaces: 4 }) @Min(0) @Max(1)
  taxRate?: number;

  /** Bakong account id for KHQR, e.g. myshop@aclb. Empty = KHQR off */
  @IsOptional() @ValidateIf((_, v) => v !== null && v !== '') @Matches(/^[^\s@]+@[^\s@]+$/, { message: 'khqrAccountId looks like name@bank' }) @MaxLength(32)
  khqrAccountId?: string | null;

  /** Name customers see in their banking app (max 25) */
  @IsOptional() @IsString() @MaxLength(25)
  khqrMerchantName?: string | null;

  @IsOptional() @IsString() @MaxLength(15)
  khqrCity?: string | null;

  /** Only for Bakong merchant accounts */
  @IsOptional() @IsString() @MaxLength(32)
  khqrMerchantId?: string | null;

  /** Acquiring bank name */
  @IsOptional() @IsString() @MaxLength(32)
  khqrBank?: string | null;
}

export class UpdateStoreDto extends PartialType(CreateStoreDto) {
  @IsOptional() @IsBoolean()
  isActive?: boolean;
}

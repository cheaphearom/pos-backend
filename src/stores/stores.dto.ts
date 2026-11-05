import { PartialType } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsBoolean, IsNumber, IsOptional, IsString, Length, Matches, Max, MaxLength, Min } from 'class-validator';

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
}

export class UpdateStoreDto extends PartialType(CreateStoreDto) {
  @IsOptional() @IsBoolean()
  isActive?: boolean;
}

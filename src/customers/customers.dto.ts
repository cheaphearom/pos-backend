import { PartialType } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsBoolean, IsEmail, IsInt, IsOptional, IsString, MaxLength, NotEquals } from 'class-validator';
import { PageQueryDto } from '../common/pagination';

export class CreateCustomerDto {
  @IsString() @MaxLength(150)
  name: string;

  @IsOptional() @IsString() @MaxLength(30)
  phone?: string;

  @IsOptional() @IsEmail()
  email?: string;

  /** Member card number. Generated automatically if empty. */
  @IsOptional() @IsString() @MaxLength(30)
  code?: string;
}

export class UpdateCustomerDto extends PartialType(CreateCustomerDto) {
  @IsOptional() @IsBoolean()
  isActive?: boolean;
}

export class CustomerQueryDto extends PageQueryDto {
  /** Name, phone, email or member code */
  @IsOptional() @IsString()
  search?: string;
}

export class AdjustPointsDto {
  /** Positive to add, negative to remove */
  @Type(() => Number) @IsInt() @NotEquals(0)
  points: number;

  @IsString() @MaxLength(200)
  reason: string;
}

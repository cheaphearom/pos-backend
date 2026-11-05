import { PartialType } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsBoolean, IsNumber, IsOptional, IsString, IsUUID, MaxLength, Min, ValidateNested } from 'class-validator';
import { PageQueryDto } from '../common/pagination';

const money = { maxDecimalPlaces: 2 };

export class CreateProductDto {
  @IsString() @MaxLength(50)
  sku: string;

  @IsOptional() @IsString() @MaxLength(64)
  barcode?: string;

  @IsString() @MaxLength(200)
  name: string;

  @IsOptional() @IsString()
  description?: string;

  @IsOptional() @IsUUID()
  categoryId?: string;

  @IsOptional() @IsString() @MaxLength(20)
  unit?: string;

  @IsOptional() @Type(() => Number) @IsNumber(money) @Min(0)
  costPrice?: number;

  @Type(() => Number) @IsNumber(money) @Min(0)
  sellPrice: number;

  @IsOptional() @IsBoolean()
  taxable?: boolean;

  /** false for services that have no stock */
  @IsOptional() @IsBoolean()
  trackStock?: boolean;
}

export class UpdateProductDto extends PartialType(CreateProductDto) {
  @IsOptional() @IsBoolean()
  isActive?: boolean;
}

export class BulkUpsertProductsDto {
  /** Up to 1000 products per request, matched by SKU */
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(1000) @ValidateNested({ each: true }) @Type(() => CreateProductDto)
  products: CreateProductDto[];
}

export class ProductQueryDto extends PageQueryDto {
  /** Search name, SKU or barcode */
  @IsOptional() @IsString()
  search?: string;

  @IsOptional() @IsUUID()
  categoryId?: string;

  /** Include stock and the store's price for this store */
  @IsOptional() @IsUUID()
  storeId?: string;

  @IsOptional() @Transform(({ value }) => value === 'true' || value === true) @IsBoolean()
  includeInactive?: boolean;
}

import { PartialType } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsBoolean, IsIn, IsNumber, IsOptional, IsString, IsUrl, IsUUID, MaxLength, Min, ValidateIf, ValidateNested } from 'class-validator';
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

  /** Cost per unit (up to 6 decimals: ingredients can cost $0.0016 per ml) */
  @IsOptional() @Type(() => Number) @IsNumber({ maxDecimalPlaces: 6 }) @Min(0)
  costPrice?: number;

  @Type(() => Number) @IsNumber(money) @Min(0)
  sellPrice: number;

  @IsOptional() @IsBoolean()
  taxable?: boolean;

  /** false for services that have no stock */
  @IsOptional() @IsBoolean()
  trackStock?: boolean;

  /** Ingredient / supply used by recipes (beans, milk, cups): kept in stock, not sold at the POS */
  @IsOptional() @IsBoolean()
  isIngredient?: boolean;

  /** Shown on the online ordering menu */
  @IsOptional() @IsBoolean()
  onlineAvailable?: boolean;

  /** Picture shown on the POS tile and online menu */
  @IsOptional() @ValidateIf((_, v) => v !== null && v !== '') @IsUrl({ require_tld: false })
  imageUrl?: string | null;

  /** Drink options (Size, Sugar...) offered for this product, in order */
  @IsOptional() @IsArray() @IsUUID('all', { each: true })
  modifierGroupIds?: string[];
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

  /** sellable = what the POS sells; ingredient = recipe ingredients and supplies */
  @IsOptional() @IsIn(['sellable', 'ingredient'])
  kind?: 'sellable' | 'ingredient';
}

import { Transform, Type } from 'class-transformer';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsBoolean, IsIn, IsNumber, IsOptional, IsString, IsUUID, Min, NotEquals, ValidateIf, ValidateNested } from 'class-validator';
import { DateRangeQueryDto } from '../common/date-range';
import { PageQueryDto } from '../common/pagination';

export class InventoryQueryDto extends PageQueryDto {
  @IsUUID()
  storeId: string;

  @IsOptional() @IsString()
  search?: string;

  /** Only items at or below their reorder level */
  @IsOptional() @Transform(({ value }) => value === 'true' || value === true) @IsBoolean()
  lowStock?: boolean;
}

export class UpdateInventoryDto {
  @IsOptional() @Type(() => Number) @IsNumber({ maxDecimalPlaces: 3 }) @Min(0)
  reorderLevel?: number;

  /** Store-specific selling price. Send null to use the product's default price. */
  @IsOptional() @ValidateIf((_, v) => v !== null) @Type(() => Number) @IsNumber({ maxDecimalPlaces: 2 }) @Min(0)
  priceOverride?: number | null;
}

export class AdjustItemDto {
  @IsUUID()
  productId: string;

  /** Change in quantity: +10 received, -2 damaged */
  @Type(() => Number) @IsNumber({ maxDecimalPlaces: 3 }) @NotEquals(0)
  quantity: number;
}

export class AdjustStockDto {
  @IsUUID()
  storeId: string;

  /** PURCHASE = goods received from supplier; ADJUSTMENT = count correction, damage, loss */
  @IsIn(['PURCHASE', 'ADJUSTMENT'])
  type: 'PURCHASE' | 'ADJUSTMENT';

  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(500) @ValidateNested({ each: true }) @Type(() => AdjustItemDto)
  items: AdjustItemDto[];

  /** Supplier invoice number, count sheet number... */
  @IsOptional() @IsString()
  reference?: string;

  @IsOptional() @IsString()
  note?: string;
}

export class TransferItemDto {
  @IsUUID()
  productId: string;

  @Type(() => Number) @IsNumber({ maxDecimalPlaces: 3 }) @Min(0.001)
  quantity: number;
}

export class CreateTransferDto {
  @IsUUID()
  fromStoreId: string;

  @IsUUID()
  toStoreId: string;

  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(500) @ValidateNested({ each: true }) @Type(() => TransferItemDto)
  items: TransferItemDto[];

  @IsOptional() @IsString()
  note?: string;
}

export class MovementQueryDto extends DateRangeQueryDto {
  @IsOptional() @IsUUID()
  productId?: string;
}

export class TransferQueryDto extends PageQueryDto {
  @IsOptional() @IsUUID()
  storeId?: string;

  @IsOptional() @IsIn(['IN_TRANSIT', 'RECEIVED', 'CANCELLED'])
  status?: 'IN_TRANSIT' | 'RECEIVED' | 'CANCELLED';
}

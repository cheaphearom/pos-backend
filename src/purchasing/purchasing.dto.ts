import { PartialType } from '@nestjs/swagger';
import { PurchaseOrderStatus } from '@prisma/client';
import { Type } from 'class-transformer';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsBoolean, IsDateString, IsEmail, IsEnum, IsInt, IsNumber, IsOptional, IsString, IsUUID, MaxLength, Min, ValidateNested } from 'class-validator';
import { PageQueryDto } from '../common/pagination';

export class CreateSupplierDto {
  @IsString() @MaxLength(30)
  code: string;

  @IsString() @MaxLength(150)
  name: string;

  @IsOptional() @IsString() @MaxLength(150)
  contactName?: string;

  @IsOptional() @IsString() @MaxLength(30)
  phone?: string;

  @IsOptional() @IsEmail()
  email?: string;

  @IsOptional() @IsString()
  address?: string;

  @IsOptional() @IsString() @MaxLength(50)
  taxId?: string;

  /** Days until payment is due after delivery */
  @IsOptional() @Type(() => Number) @IsInt() @Min(0)
  paymentTermsDays?: number;

  @IsOptional() @IsString()
  note?: string;
}

export class UpdateSupplierDto extends PartialType(CreateSupplierDto) {
  @IsOptional() @IsBoolean()
  isActive?: boolean;
}

export class SupplierQueryDto extends PageQueryDto {
  @IsOptional() @IsString()
  search?: string;
}

export class PoItemDto {
  @IsUUID()
  productId: string;

  @Type(() => Number) @IsNumber({ maxDecimalPlaces: 3 }) @Min(0.001)
  quantity: number;

  /** Cost per unit; defaults to the product's current cost price */
  @IsOptional() @Type(() => Number) @IsNumber({ maxDecimalPlaces: 6 }) @Min(0)
  unitCost?: number;
}

export class CreatePurchaseOrderDto {
  @IsUUID()
  supplierId: string;

  /** Store that receives the goods */
  @IsUUID()
  storeId: string;

  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(500) @ValidateNested({ each: true }) @Type(() => PoItemDto)
  items: PoItemDto[];

  @IsOptional() @IsDateString()
  expectedAt?: string;

  @IsOptional() @IsString()
  note?: string;
}

export class UpdatePurchaseOrderDto extends PartialType(CreatePurchaseOrderDto) {}

export class ReceiveItemDto {
  /** Purchase order line id */
  @IsUUID()
  itemId: string;

  @Type(() => Number) @IsNumber({ maxDecimalPlaces: 3 }) @Min(0.001)
  quantity: number;

  /** Actual cost on the invoice, if different from the order */
  @IsOptional() @Type(() => Number) @IsNumber({ maxDecimalPlaces: 6 }) @Min(0)
  unitCost?: number;
}

export class ReceivePurchaseOrderDto {
  @IsArray() @ArrayMinSize(1) @ValidateNested({ each: true }) @Type(() => ReceiveItemDto)
  items: ReceiveItemDto[];

  /** Supplier invoice or delivery note number */
  @IsOptional() @IsString() @MaxLength(100)
  reference?: string;

  @IsOptional() @IsString()
  note?: string;

  /** Update each product's cost price to the received cost (default true) */
  @IsOptional() @IsBoolean()
  updateCost?: boolean;
}

export class PoQueryDto extends PageQueryDto {
  @IsOptional() @IsUUID()
  storeId?: string;

  @IsOptional() @IsUUID()
  supplierId?: string;

  @IsOptional() @IsEnum(PurchaseOrderStatus)
  status?: PurchaseOrderStatus;

  /** PO number (partial) */
  @IsOptional() @IsString()
  search?: string;
}

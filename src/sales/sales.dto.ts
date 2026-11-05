import { OrderType, PaymentMethod, SaleStatus } from '@prisma/client';
import { Type } from 'class-transformer';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsBoolean, IsDateString, IsEnum, Matches, IsInt, IsNumber, IsOptional, IsString, IsUUID, Max, MaxLength, Min, ValidateNested } from 'class-validator';
import { DateRangeQueryDto } from '../common/date-range';

export class SaleItemDto {
  @IsUUID()
  productId: string;

  @Type(() => Number) @IsNumber({ maxDecimalPlaces: 3 }) @Min(0.001)
  quantity: number;

  /** Discount amount for this line */
  @IsOptional() @Type(() => Number) @IsNumber({ maxDecimalPlaces: 2 }) @Min(0)
  discount?: number;

  /** Chosen drink options (modifier option ids), e.g. size L + 50% sugar */
  @IsOptional() @IsArray() @ArrayMaxSize(30) @IsUUID('all', { each: true })
  modifiers?: string[];

  /** Note for the barista / kitchen */
  @IsOptional() @IsString() @MaxLength(200)
  note?: string;
}

export class PaymentDto {
  @IsEnum(PaymentMethod)
  method: PaymentMethod;

  @Type(() => Number) @IsNumber({ maxDecimalPlaces: 2 }) @Min(0.01)
  amount: number;

  /** Card approval code, KHQR md5, wallet card number, etc. */
  @IsOptional() @IsString() @MaxLength(100)
  reference?: string;

  /** Wallet card PIN (only for method WALLET; never stored) */
  @IsOptional() @Matches(/^\d{4,6}$/, { message: 'PIN must be 4 to 6 digits' })
  pin?: string;
}

export class CreateSaleDto {
  @IsUUID()
  storeId: string;

  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(500) @ValidateNested({ each: true }) @Type(() => SaleItemDto)
  items: SaleItemDto[];

  @IsArray() @ArrayMaxSize(10) @ValidateNested({ each: true }) @Type(() => PaymentDto)
  payments: PaymentDto[];

  /** Loyalty member */
  @IsOptional() @IsUUID()
  customerId?: string;

  /** Discount amount on the whole sale */
  @IsOptional() @Type(() => Number) @IsNumber({ maxDecimalPlaces: 2 }) @Min(0)
  discount?: number;

  /** Discount percent on the whole sale (0-100) */
  @IsOptional() @Type(() => Number) @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) @Max(100)
  discountPercent?: number;

  /** Coupon code (discount on the whole sale) */
  @IsOptional() @IsString() @MaxLength(40)
  couponCode?: string;

  /** Loyalty points to use as payment */
  @IsOptional() @Type(() => Number) @IsInt() @Min(1)
  redeemPoints?: number;

  /**
   * Unique id created by the client (e.g. a UUID). Sending the same sale twice
   * (offline sync, network retry) returns the first sale instead of charging twice.
   */
  @IsOptional() @IsString() @MaxLength(64)
  clientRef?: string;

  /** Café: TAKEAWAY, DINE_IN, PICKUP, DELIVERY (default RETAIL) */
  @IsOptional() @IsEnum(OrderType)
  orderType?: OrderType;

  /** Table number for dine-in */
  @IsOptional() @IsString() @MaxLength(20)
  tableNo?: string;

  /** Sales channel; integrations can send e.g. ONLINE */
  @IsOptional() @IsString() @MaxLength(20)
  channel?: string;

  @IsOptional() @IsString() @MaxLength(500)
  note?: string;

  /**
   * When the POS was offline: the time the sale really happened. The sale is then
   * accepted even if stock is short (the goods already left the store), and dated at this time.
   * Must be within the last 7 days. Requires clientRef.
   */
  @IsOptional() @IsDateString()
  offlineCreatedAt?: string;
}

export class RefundItemDto {
  @IsUUID()
  saleItemId: string;

  @Type(() => Number) @IsNumber({ maxDecimalPlaces: 3 }) @Min(0.001)
  quantity: number;
}

export class CreateRefundDto {
  @IsArray() @ArrayMinSize(1) @ValidateNested({ each: true }) @Type(() => RefundItemDto)
  items: RefundItemDto[];

  @IsOptional() @IsEnum(PaymentMethod)
  method?: PaymentMethod;

  /** Put items back into stock (false for damaged goods) */
  @IsOptional() @IsBoolean()
  restock?: boolean;

  @IsOptional() @IsString() @MaxLength(500)
  reason?: string;
}

export class SaleQueryDto extends DateRangeQueryDto {
  @IsOptional() @IsEnum(SaleStatus)
  status?: SaleStatus;

  @IsOptional() @IsUUID()
  customerId?: string;

  @IsOptional() @IsUUID()
  cashierId?: string;

  @IsOptional() @IsUUID()
  shiftId?: string;

  /** Receipt number (partial match) */
  @IsOptional() @IsString()
  search?: string;
}

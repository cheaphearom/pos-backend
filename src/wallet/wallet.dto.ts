import { PaymentMethod, WalletCardStatus } from '@prisma/client';
import { Type } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsEnum, IsInt, IsNumber, IsOptional, IsString, IsUUID, Matches, Max, MaxLength, Min, NotEquals, ValidateNested } from 'class-validator';
import { DateRangeQueryDto } from '../common/date-range';
import { PageQueryDto } from '../common/pagination';

export class ExistingCardDto {
  @Matches(/^\d{12,19}$/)
  cardNumber: string;

  @IsString() @MaxLength(20)
  serialNumber: string;
}

export class CreateCardsDto {
  /** Generate this many new cards (ignored when `cards` is given) */
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(5000)
  count?: number;

  /** Or register cards already printed by a card supplier */
  @IsOptional() @IsArray() @ArrayMaxSize(5000) @ValidateNested({ each: true }) @Type(() => ExistingCardDto)
  cards?: ExistingCardDto[];
}

export class CardQueryDto extends PageQueryDto {
  /** Card number, serial, customer name or phone */
  @IsOptional() @IsString()
  search?: string;

  @IsOptional() @IsEnum(WalletCardStatus)
  status?: WalletCardStatus;

  @IsOptional() @IsUUID()
  customerId?: string;
}

export class ActivateCardDto {
  /** Serial printed on the card (proves the card is in your hands) */
  @IsString()
  serialNumber: string;

  /** Existing customer, or give name/phone to register a new one */
  @IsOptional() @IsUUID()
  customerId?: string;

  @IsOptional() @IsString() @MaxLength(150)
  name?: string;

  @IsOptional() @IsString() @MaxLength(30)
  phone?: string;

  /** Optional 4-6 digit PIN asked when paying */
  @IsOptional() @Matches(/^\d{4,6}$/, { message: 'PIN must be 4 to 6 digits' })
  pin?: string;
}

export class TopupDto {
  @IsUUID()
  storeId: string;

  @Type(() => Number) @IsNumber({ maxDecimalPlaces: 2 }) @Min(0.01)
  amount: number;

  /** How the customer paid for the top-up */
  @IsEnum(PaymentMethod)
  method: PaymentMethod;

  @IsOptional() @IsString() @MaxLength(100)
  reference?: string;

  /** Unique id from the client so a retried request does not top up twice */
  @IsOptional() @IsString() @MaxLength(64)
  clientRef?: string;
}

export class AdjustBalanceDto {
  /** Positive adds, negative removes */
  @Type(() => Number) @IsNumber({ maxDecimalPlaces: 2 }) @NotEquals(0)
  amount: number;

  @IsString() @MaxLength(200)
  reason: string;
}

export class SetPinDto {
  /** New PIN, or empty string to remove the PIN */
  @Matches(/^(\d{4,6})?$/, { message: 'PIN must be 4 to 6 digits' })
  pin: string;
}

export class ReasonDto {
  @IsOptional() @IsString() @MaxLength(200)
  reason?: string;
}

export class ReplaceCardDto {
  /** The new card (must be INACTIVE) */
  @Matches(/^\d{12,19}$/)
  newCardNumber: string;

  @IsString()
  newSerialNumber: string;
}

export class WalletTxQueryDto extends DateRangeQueryDto {}

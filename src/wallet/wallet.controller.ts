import { AuditService } from '../audit/audit.module';
import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiSecurity, ApiTags } from '@nestjs/swagger';
import { Role } from '@prisma/client';
import { CurrentPrincipal, Roles, Scopes } from '../common/decorators';
import { PageQueryDto } from '../common/pagination';
import { Principal } from '../common/principal';
import { ActivateCardDto, AdjustBalanceDto, CardQueryDto, CreateCardsDto, ReasonDto, ReplaceCardDto, SetPinDto, TopupDto } from './wallet.dto';
import { WalletService } from './wallet.service';

@ApiTags('Wallet cards')
@ApiBearerAuth()
@ApiSecurity('api-key')
@Controller('wallet/cards')
export class WalletController {
  constructor(
    private readonly wallet: WalletService,
    private readonly audit: AuditService,
  ) {}

  @Roles(Role.STORE_MANAGER)
  @Scopes('wallet:read')
  @Get()
  list(@Query() q: CardQueryDto) {
    return this.wallet.list(q);
  }

  /** Generate new cards to print, or register cards printed by a supplier. */
  @Roles(Role.SUPER_ADMIN)
  @Scopes('wallet:write')
  @Post()
  create(@Body() dto: CreateCardsDto) {
    return this.wallet.createCards(dto);
  }

  /** POS: find a card by scanned card number or serial. */
  @Scopes('wallet:read')
  @Get('lookup')
  lookup(@Query('code') code: string) {
    return this.wallet.lookup(code ?? '');
  }

  @Scopes('wallet:read')
  @Get(':id')
  get(@Param('id', ParseUUIDPipe) id: string) {
    return this.wallet.get(id);
  }

  @Scopes('wallet:read')
  @Get(':id/transactions')
  transactions(@Param('id', ParseUUIDPipe) id: string, @Query() q: PageQueryDto) {
    return this.wallet.transactions(id, q);
  }

  /** Give a new card to a customer. Needs the serial printed on the card. */
  @Scopes('wallet:write')
  @Post(':id/activate')
  activate(@CurrentPrincipal() p: Principal, @Param('id', ParseUUIDPipe) id: string, @Body() dto: ActivateCardDto) {
    return this.wallet.activate(p, id, dto);
  }

  /** Customer pays money onto the card (cash, KHQR, bank card...). */
  @Scopes('wallet:write')
  @Post(':id/topup')
  topup(@CurrentPrincipal() p: Principal, @Param('id', ParseUUIDPipe) id: string, @Body() dto: TopupDto) {
    return this.wallet.topup(p, id, dto);
  }

  @Roles(Role.STORE_MANAGER)
  @Post(':id/adjust')
  async adjust(@CurrentPrincipal() p: Principal, @Param('id', ParseUUIDPipe) id: string, @Body() dto: AdjustBalanceDto) {
    const r: any = await this.wallet.adjust(p, id, dto);
    this.audit.add(p, { action: 'WALLET_ADJUSTED', entityType: 'wallet', entityId: r?.cardNumber ?? id, summary: `Wallet ${r?.cardNumber ?? id}: ${dto.amount > 0 ? '+' : ''}${dto.amount} (${dto.reason})`, details: dto });
    return r;
  }

  @Roles(Role.STORE_MANAGER)
  @Post(':id/block')
  async block(@CurrentPrincipal() p: Principal, @Param('id', ParseUUIDPipe) id: string, @Body() dto: ReasonDto) {
    const r = await this.wallet.setStatus(id, 'BLOCKED', dto.reason);
    this.audit.add(p, { action: 'WALLET_BLOCKED', entityType: 'wallet', entityId: r.cardNumber, summary: `Wallet ${r.cardNumber} blocked${dto.reason ? `: ${dto.reason}` : ''}` });
    return r;
  }

  @Roles(Role.STORE_MANAGER)
  @Post(':id/unblock')
  async unblock(@CurrentPrincipal() p: Principal, @Param('id', ParseUUIDPipe) id: string) {
    const r = await this.wallet.setStatus(id, 'ACTIVE');
    this.audit.add(p, { action: 'WALLET_UNBLOCKED', entityType: 'wallet', entityId: r.cardNumber, summary: `Wallet ${r.cardNumber} unblocked` });
    return r;
  }

  @Post(':id/pin')
  setPin(@CurrentPrincipal() p: Principal, @Param('id', ParseUUIDPipe) id: string, @Body() dto: SetPinDto) {
    return this.wallet.setPin(p, id, dto.pin);
  }

  /** Lost card: move customer and balance to a new card. */
  @Roles(Role.STORE_MANAGER)
  @Post(':id/replace')
  replace(@CurrentPrincipal() p: Principal, @Param('id', ParseUUIDPipe) id: string, @Body() dto: ReplaceCardDto) {
    return this.wallet.replace(p, id, dto);
  }
}

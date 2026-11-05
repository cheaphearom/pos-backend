import { BadRequestException, Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Role } from '@prisma/client';
import { ArrayMinSize, IsArray, IsBoolean, IsIn, IsOptional, IsUrl } from 'class-validator';
import { Roles } from '../common/decorators';
import { PageQueryDto, pageArgs, toPage } from '../common/pagination';
import { PrismaService } from '../prisma/prisma.service';
import { WEBHOOK_EVENTS } from './webhook-events';
import { WebhooksService } from './webhooks.service';

export class CreateWebhookDto {
  @IsUrl({ require_tld: false })
  url: string;

  /** Events to receive; use ["*"] for all */
  @IsArray() @ArrayMinSize(1) @IsIn([...WEBHOOK_EVENTS, '*'], { each: true })
  events: string[];
}

export class UpdateWebhookDto {
  @IsOptional() @IsUrl({ require_tld: false })
  url?: string;

  @IsOptional() @IsArray() @ArrayMinSize(1) @IsIn([...WEBHOOK_EVENTS, '*'], { each: true })
  events?: string[];

  @IsOptional() @IsBoolean()
  isActive?: boolean;
}

@ApiTags('Integrations: Webhooks')
@ApiBearerAuth()
@Roles(Role.SUPER_ADMIN)
@Controller('webhooks')
export class WebhooksController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly webhooks: WebhooksService,
  ) {}

  /** List of events you can subscribe to. */
  @Get('events')
  events() {
    return WEBHOOK_EVENTS;
  }

  @Get()
  list() {
    return this.prisma.webhookEndpoint.findMany({ orderBy: { createdAt: 'desc' }, omit: { secret: true } });
  }

  /** The signing secret is returned only once, here. */
  @Post()
  create(@Body() dto: CreateWebhookDto) {
    return this.prisma.webhookEndpoint.create({ data: { ...dto, secret: this.webhooks.generateSecret() } });
  }

  @Patch(':id')
  update(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateWebhookDto) {
    return this.prisma.webhookEndpoint.update({ where: { id }, data: dto, omit: { secret: true } });
  }

  @Delete(':id')
  @HttpCode(204)
  async remove(@Param('id', ParseUUIDPipe) id: string) {
    await this.prisma.webhookEndpoint.delete({ where: { id } });
  }

  @Get(':id/deliveries')
  async deliveries(@Param('id', ParseUUIDPipe) id: string, @Query() q: PageQueryDto) {
    const where = { endpointId: id };
    const [rows, total] = await Promise.all([
      this.prisma.webhookDelivery.findMany({ where, orderBy: { id: 'desc' }, ...pageArgs(q) }),
      this.prisma.webhookDelivery.count({ where }),
    ]);
    return toPage(rows, total, q);
  }

  /** Send a test "ping" event to this endpoint. */
  @Post(':id/ping')
  @HttpCode(202)
  async ping(@Param('id', ParseUUIDPipe) id: string) {
    const d = await this.prisma.webhookDelivery.create({
      data: { endpointId: id, event: 'ping', payload: { event: 'ping', createdAt: new Date().toISOString(), data: {} } },
    });
    await this.webhooks.enqueue(d.id);
    return { deliveryId: d.id };
  }

  /** Retry a failed delivery. */
  @Post('deliveries/:deliveryId/retry')
  @HttpCode(202)
  async retry(@Param('deliveryId') deliveryId: string) {
    if (!/^\d+$/.test(deliveryId)) throw new BadRequestException('Invalid delivery id');
    const d = await this.prisma.webhookDelivery.update({ where: { id: BigInt(deliveryId) }, data: { status: 'PENDING' } });
    await this.webhooks.enqueue(d.id);
    return { deliveryId: d.id };
  }
}

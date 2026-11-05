import { AuditService } from '../audit/audit.module';
import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Role } from '@prisma/client';
import { CurrentPrincipal, Roles } from '../common/decorators';
import { Principal } from '../common/principal';
import { CreateUserDto, UpdateUserDto, UserQueryDto } from './users.dto';
import { UsersService } from './users.service';

@ApiTags('Users')
@ApiBearerAuth()
@Roles(Role.STORE_MANAGER)
@Controller('users')
export class UsersController {
  constructor(
    private readonly users: UsersService,
    private readonly audit: AuditService,
  ) {}

  @Get()
  list(@CurrentPrincipal() p: Principal, @Query() q: UserQueryDto) {
    return this.users.list(p, q);
  }

  @Get(':id')
  get(@CurrentPrincipal() p: Principal, @Param('id', ParseUUIDPipe) id: string) {
    return this.users.get(p, id);
  }

  @Post()
  async create(@CurrentPrincipal() p: Principal, @Body() dto: CreateUserDto) {
    const u: any = await this.users.create(p, dto);
    this.audit.add(p, { action: 'USER_CREATED', entityType: 'user', entityId: u.id, summary: `User ${u.email} created as ${u.role}`, details: { role: u.role, storeIds: dto.storeIds } });
    return u;
  }

  @Patch(':id')
  async update(@CurrentPrincipal() p: Principal, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateUserDto) {
    const u: any = await this.users.update(p, id, dto);
    const { password, ...safe } = dto as any;
    this.audit.add(p, {
      action: 'USER_CHANGED', entityType: 'user', entityId: id,
      summary: `User ${u.email}: ${Object.keys(safe).join(', ') || 'no fields'}${password ? ', password reset' : ''}`, details: safe,
    });
    return u;
  }
}

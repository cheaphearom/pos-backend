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
  constructor(private readonly users: UsersService) {}

  @Get()
  list(@CurrentPrincipal() p: Principal, @Query() q: UserQueryDto) {
    return this.users.list(p, q);
  }

  @Get(':id')
  get(@CurrentPrincipal() p: Principal, @Param('id', ParseUUIDPipe) id: string) {
    return this.users.get(p, id);
  }

  @Post()
  create(@CurrentPrincipal() p: Principal, @Body() dto: CreateUserDto) {
    return this.users.create(p, dto);
  }

  @Patch(':id')
  update(@CurrentPrincipal() p: Principal, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateUserDto) {
    return this.users.update(p, id, dto);
  }
}

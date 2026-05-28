import { Body, Controller, Delete, Get, Param, Patch, Post, Req, UseGuards } from '@nestjs/common';
import { AuthGuard } from './auth.guard';
import { RequestWithAuth } from './auth.types';
import { UsersService } from './users.service';

@Controller('api/users')
@UseGuards(AuthGuard)
export class UsersController {
  constructor(private readonly users: UsersService) {}

  @Get()
  list(@Req() request: RequestWithAuth) {
    return this.users.list(request.auth!);
  }

  @Post()
  create(@Req() request: RequestWithAuth, @Body() body: Record<string, unknown>) {
    return this.users.create(request.auth!, {
      name: String(body.name || ''),
      email: String(body.email || ''),
      password: String(body.password || ''),
      clientId: Number(body.clientId),
      role: String(body.role || 'viewer'),
    });
  }

  @Patch(':id/role')
  updateRole(@Req() request: RequestWithAuth, @Param('id') id: string, @Body() body: Record<string, unknown>) {
    return this.users.updateRole(request.auth!, Number(id), {
      clientId: Number(body.clientId),
      role: String(body.role || 'viewer'),
    });
  }

  @Delete(':id')
  delete(@Req() request: RequestWithAuth, @Param('id') id: string) {
    return this.users.delete(request.auth!, Number(id));
  }
}

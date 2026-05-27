import { Body, Controller, Get, Post, Req, UseGuards } from '@nestjs/common';
import { AuthGuard } from './auth.guard';
import { RequestWithAuth } from './auth.types';
import { ClientsService } from './clients.service';

@Controller('api/clients')
@UseGuards(AuthGuard)
export class ClientsController {
  constructor(private readonly clients: ClientsService) {}

  @Get()
  list(@Req() request: RequestWithAuth) {
    return this.clients.list(request.auth!);
  }

  @Post()
  create(@Req() request: RequestWithAuth, @Body() body: Record<string, unknown>) {
    return this.clients.create(request.auth!, {
      clientName: String(body.clientName || ''),
      slug: String(body.slug || ''),
      schemaName: String(body.schemaName || ''),
      sourceSchema: String(body.sourceSchema || ''),
      copyData: body.copyData === 'true' || body.copyData === true,
    });
  }
}

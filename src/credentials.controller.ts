import { Body, Controller, Get, Post, Req, UseGuards } from '@nestjs/common';
import { AuthGuard } from './auth.guard';
import { RequestWithAuth } from './auth.types';
import { CredentialsService } from './credentials.service';

@Controller('api/integration/credentials')
@UseGuards(AuthGuard)
export class CredentialsController {
  constructor(private readonly credentials: CredentialsService) {}

  @Get()
  status(@Req() request: RequestWithAuth) {
    return this.credentials.status(request.auth!);
  }

  @Post()
  save(@Req() request: RequestWithAuth, @Body() body: Record<string, string>) {
    return this.credentials.save(request.auth!, {
      apiUrl: body.apiUrl,
      login: body.login,
      password: body.password,
    });
  }
}

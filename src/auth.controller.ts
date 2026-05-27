import { Body, Controller, Get, Headers, Post, Req } from '@nestjs/common';
import { AuthService, extractBearer } from './auth.service';

@Controller('api/auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Get('bootstrap')
  bootstrap() {
    return this.auth.bootstrapStatus();
  }

  @Post('setup')
  setup(@Body() body: Record<string, string>, @Req() request: any) {
    return this.auth.setup(
      {
        name: body.name,
        email: body.email,
        password: body.password,
        clientName: body.clientName,
        clientSlug: body.clientSlug,
        schemaName: body.schemaName,
      },
      sessionMeta(request),
    );
  }

  @Post('login')
  login(@Body() body: Record<string, string>, @Req() request: any) {
    return this.auth.login(
      {
        email: body.email,
        password: body.password,
      },
      sessionMeta(request),
    );
  }

  @Get('me')
  me(@Headers('authorization') authorization?: string) {
    return this.auth.me(extractBearer(authorization));
  }

  @Post('logout')
  logout(@Headers('authorization') authorization?: string) {
    return this.auth.logout(extractBearer(authorization));
  }

  @Post('switch-client')
  switchClient(@Headers('authorization') authorization: string | undefined, @Body() body: Record<string, unknown>) {
    return this.auth.switchClient(extractBearer(authorization), Number(body.clientId));
  }
}

function sessionMeta(request: any) {
  return {
    userAgent: request.headers?.['user-agent'],
    ipAddress: request.ip || request.socket?.remoteAddress,
  };
}

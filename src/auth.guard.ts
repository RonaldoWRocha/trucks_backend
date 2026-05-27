import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { AuthService, extractBearer } from './auth.service';
import { RequestWithAuth } from './auth.types';

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(private readonly auth: AuthService) {}

  async canActivate(context: ExecutionContext) {
    const request = context.switchToHttp().getRequest<RequestWithAuth>();
    const token = extractBearer(request.headers.authorization);
    const session = await this.auth.sessionFromToken(token);
    if (!session) {
      throw new UnauthorizedException('Sessao invalida');
    }

    request.auth = {
      userId: session.user.id,
      clientId: session.client.id,
      schemaName: session.client.schemaName,
      role: session.client.role,
      isPlatformAdmin: session.user.isPlatformAdmin,
    };
    return true;
  }
}

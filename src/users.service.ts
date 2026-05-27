import { BadRequestException, ForbiddenException, Injectable } from '@nestjs/common';
import { pbkdf2Sync, randomBytes } from 'node:crypto';
import { DatabaseService } from './database.service';
import { AuthContext } from './auth.types';

type CreateUserInput = {
  name?: string;
  email?: string;
  password?: string;
  clientId?: number;
  role?: string;
};

@Injectable()
export class UsersService {
  constructor(private readonly db: DatabaseService) {}

  async list(auth: AuthContext) {
    this.requirePlatformAdmin(auth);
    const result = await this.db.query(
      `
      select
        u.id,
        u.name,
        u.email,
        u.enabled,
        u.is_platform_admin,
        c.id as client_id,
        c.name as client_name,
        c.schema_name,
        uc.role
      from public.app_users u
      left join public.user_clients uc on uc.user_id = u.id and uc.enabled = true
      left join public.clients c on c.id = uc.client_id
      order by u.name, c.name
      `,
    );
    return result.rows.map(camelize);
  }

  async create(auth: AuthContext, input: CreateUserInput) {
    this.requirePlatformAdmin(auth);

    const name = String(input.name || '').trim();
    const email = normalizeEmail(input.email || '');
    const password = String(input.password || '');
    const role = normalizeRole(input.role || 'viewer');
    const clientId = Number(input.clientId);

    if (!name || !password || !Number.isFinite(clientId)) {
      throw new BadRequestException('Nome, email, senha e cliente sao obrigatorios');
    }

    const client = await this.db.query('select 1 from public.clients where id = $1 and enabled = true', [clientId]);
    if (!client.rows[0]) {
      throw new BadRequestException('Cliente invalido');
    }

    const user = await this.db.query<{ id: number }>(
      `
      insert into public.app_users (name, email, password_hash)
      values ($1, $2, $3)
      on conflict (email) do update set
        name = excluded.name,
        password_hash = excluded.password_hash,
        enabled = true,
        updated_at = now()
      returning id
      `,
      [name, email, hashPassword(password)],
    );

    await this.db.query(
      `
      insert into public.user_clients (user_id, client_id, role)
      values ($1, $2, $3)
      on conflict (user_id, client_id) do update set
        role = excluded.role,
        enabled = true,
        updated_at = now()
      `,
      [user.rows[0].id, clientId, role],
    );

    return { ok: true, userId: user.rows[0].id };
  }

  private requirePlatformAdmin(auth: AuthContext) {
    if (!auth.isPlatformAdmin) {
      throw new ForbiddenException('Apenas admin da plataforma pode gerenciar usuarios');
    }
  }
}

function hashPassword(password: string) {
  const salt = randomBytes(16).toString('base64url');
  const iterations = 210000;
  const hash = pbkdf2Sync(password, salt, iterations, 32, 'sha256').toString('base64url');
  return `pbkdf2_sha256$${iterations}$${salt}$${hash}`;
}

function normalizeEmail(email: string) {
  const value = String(email || '').trim().toLowerCase();
  if (!value.includes('@')) throw new BadRequestException('Email invalido');
  return value;
}

function normalizeRole(role: string) {
  const value = String(role || 'viewer');
  if (!['owner', 'admin', 'operator', 'viewer'].includes(value)) {
    throw new BadRequestException('Perfil invalido');
  }
  return value;
}

function camelize(row: Record<string, unknown>) {
  return Object.fromEntries(
    Object.entries(row).map(([key, value]) => [
      key.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase()),
      value,
    ]),
  );
}

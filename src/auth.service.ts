import { BadRequestException, Injectable, UnauthorizedException } from '@nestjs/common';
import { createHash, pbkdf2Sync, randomBytes, timingSafeEqual } from 'node:crypto';
import { DatabaseService } from './database.service';

type LoginInput = {
  email: string;
  password: string;
};

type SetupInput = LoginInput & {
  name: string;
  clientName: string;
  clientSlug?: string;
  schemaName?: string;
};

@Injectable()
export class AuthService {
  constructor(private readonly db: DatabaseService) {}

  async bootstrapStatus() {
    const result = await this.db.query<{ count: string }>('select count(*)::int as count from public.app_users');
    return { needsSetup: Number(result.rows[0]?.count || 0) === 0 };
  }

  async setup(input: SetupInput, meta: SessionMeta = {}) {
    const status = await this.bootstrapStatus();
    if (!status.needsSetup) {
      throw new BadRequestException('Setup inicial ja foi concluido');
    }

    const email = normalizeEmail(input.email);
    const schemaName = normalizeSchemaName(input.schemaName || 'trucks');
    const slug = normalizeSlug(input.clientSlug || input.clientName || schemaName);

    const client = await this.db.query<{ id: number }>(
      `
      insert into public.clients (name, slug, schema_name)
      values ($1, $2, $3)
      returning id
      `,
      [input.clientName.trim(), slug, schemaName],
    );

    const user = await this.db.query<{ id: number }>(
      `
      insert into public.app_users (name, email, password_hash, is_platform_admin)
      values ($1, $2, $3, true)
      returning id
      `,
      [input.name.trim(), email, hashPassword(input.password)],
    );

    await this.db.query(
      `
      insert into public.user_clients (user_id, client_id, role)
      values ($1, $2, 'owner')
      `,
      [user.rows[0].id, client.rows[0].id],
    );

    return this.createSession(user.rows[0].id, client.rows[0].id, meta);
  }

  async login(input: LoginInput, meta: SessionMeta = {}) {
    const email = normalizeEmail(input.email);
    const user = await this.db.query<{
      id: number;
      name: string;
      email: string;
      password_hash: string;
      enabled: boolean;
    }>(
      `
      select id, name, email, password_hash, enabled
      from public.app_users
      where email = $1
      limit 1
      `,
      [email],
    );

    const row = user.rows[0];
    if (!row || !row.enabled || !verifyPassword(input.password, row.password_hash)) {
      throw new UnauthorizedException('Email ou senha invalidos');
    }

    const client = await this.db.query<{ client_id: number }>(
      `
      select client_id
      from public.user_clients
      where user_id = $1 and enabled = true
      order by case role when 'owner' then 1 when 'admin' then 2 when 'operator' then 3 else 4 end
      limit 1
      `,
      [row.id],
    );

    if (!client.rows[0]) {
      throw new UnauthorizedException('Usuario sem cliente ativo');
    }

    await this.db.query('update public.app_users set last_login_at = now() where id = $1', [row.id]);
    return this.createSession(row.id, client.rows[0].client_id, meta);
  }

  async me(token: string) {
    const session = await this.sessionFromToken(token);
    if (!session) {
      throw new UnauthorizedException('Sessao invalida');
    }
    return {
      ...session,
      clients: await this.clientsForUser(session.user.id, session.user.isPlatformAdmin),
    };
  }

  async logout(token: string) {
    await this.db.query(
      `
      update public.app_sessions
      set revoked_at = now()
      where token_hash = $1 and revoked_at is null
      `,
      [hashToken(token)],
    );
    return { ok: true };
  }

  async switchClient(token: string, clientId: number) {
    const session = await this.sessionFromToken(token);
    if (!session) {
      throw new UnauthorizedException('Sessao invalida');
    }

    const allowed = await this.canAccessClient(session.user.id, session.user.isPlatformAdmin, clientId);
    if (!allowed) {
      throw new UnauthorizedException('Cliente nao permitido');
    }

    await this.db.query(
      `
      update public.app_sessions
      set active_client_id = $2,
          updated_at = now()
      where token_hash = $1 and revoked_at is null and expires_at > now()
      `,
      [hashToken(token), clientId],
    );

    return this.me(token);
  }

  async sessionFromToken(token: string) {
    if (!token) return null;
    const result = await this.db.query<{
      user_id: number;
      user_name: string;
      email: string;
      is_platform_admin: boolean;
      client_id: number;
      client_name: string;
      schema_name: string;
      role: string;
    }>(
      `
      select
        u.id as user_id,
        u.name as user_name,
        u.email,
        u.is_platform_admin,
        c.id as client_id,
        c.name as client_name,
        c.schema_name,
        coalesce(uc.role, case when u.is_platform_admin then 'platform_admin' else null end) as role
      from public.app_sessions s
      join public.app_users u on u.id = s.user_id and u.enabled = true
      join public.clients c on c.id = s.active_client_id and c.enabled = true
      left join public.user_clients uc on uc.user_id = u.id and uc.client_id = c.id and uc.enabled = true
      where s.token_hash = $1
        and s.revoked_at is null
        and s.expires_at > now()
        and (u.is_platform_admin = true or uc.user_id is not null)
      limit 1
      `,
      [hashToken(token)],
    );

    const row = result.rows[0];
    if (!row) return null;
    return {
      user: {
        id: Number(row.user_id),
        name: row.user_name,
        email: row.email,
        isPlatformAdmin: Boolean(row.is_platform_admin),
      },
      client: {
        id: Number(row.client_id),
        name: row.client_name,
        schemaName: row.schema_name,
        role: row.role,
      },
    };
  }

  private async createSession(userId: number, clientId: number, meta: SessionMeta) {
    const token = randomBytes(32).toString('base64url');
    const expiresDays = Number(process.env.SESSION_DAYS || 7);
    await this.db.query(
      `
      insert into public.app_sessions (
        user_id, active_client_id, token_hash, user_agent, ip_address, expires_at
      )
      values ($1, $2, $3, $4, nullif($5, '')::inet, now() + ($6::text || ' days')::interval)
      `,
      [userId, clientId, hashToken(token), meta.userAgent || null, meta.ipAddress || '', expiresDays],
    );

    const session = await this.sessionFromToken(token);
    return {
      token,
      ...session,
      clients: await this.clientsForUser(userId, Boolean(session?.user.isPlatformAdmin)),
    };
  }

  private async clientsForUser(userId: number, isPlatformAdmin: boolean) {
    const result = await this.db.query<{
      id: number;
      name: string;
      slug: string;
      schema_name: string;
      role: string;
    }>(
      isPlatformAdmin
        ? `
          select id, name, slug, schema_name, 'platform_admin' as role
          from public.clients
          where enabled = true
          order by name
          `
        : `
          select c.id, c.name, c.slug, c.schema_name, uc.role
          from public.user_clients uc
          join public.clients c on c.id = uc.client_id and c.enabled = true
          where uc.user_id = $1 and uc.enabled = true
          order by c.name
          `,
      isPlatformAdmin ? [] : [userId],
    );

    return result.rows.map((row) => ({
      id: Number(row.id),
      name: row.name,
      slug: row.slug,
      schemaName: row.schema_name,
      role: row.role,
    }));
  }

  private async canAccessClient(userId: number, isPlatformAdmin: boolean, clientId: number) {
    if (isPlatformAdmin) {
      const result = await this.db.query('select 1 from public.clients where id = $1 and enabled = true', [clientId]);
      return Boolean(result.rows[0]);
    }

    const result = await this.db.query(
      `
      select 1
      from public.user_clients uc
      join public.clients c on c.id = uc.client_id and c.enabled = true
      where uc.user_id = $1 and uc.client_id = $2 and uc.enabled = true
      `,
      [userId, clientId],
    );
    return Boolean(result.rows[0]);
  }
}

type SessionMeta = {
  userAgent?: string;
  ipAddress?: string;
};

export function extractBearer(value?: string | string[]) {
  const header = Array.isArray(value) ? value[0] : value;
  const match = header?.match(/^Bearer\s+(.+)$/i);
  return match?.[1] || '';
}

function hashToken(token: string) {
  return createHash('sha256').update(token).digest('hex');
}

function hashPassword(password: string) {
  const salt = randomBytes(16).toString('base64url');
  const iterations = 210000;
  const hash = pbkdf2Sync(password, salt, iterations, 32, 'sha256').toString('base64url');
  return `pbkdf2_sha256$${iterations}$${salt}$${hash}`;
}

function verifyPassword(password: string, stored: string) {
  const [kind, iterationsRaw, salt, expected] = stored.split('$');
  if (kind !== 'pbkdf2_sha256' || !iterationsRaw || !salt || !expected) return false;
  const actual = pbkdf2Sync(password, salt, Number(iterationsRaw), 32, 'sha256');
  const expectedBuffer = Buffer.from(expected, 'base64url');
  return actual.length === expectedBuffer.length && timingSafeEqual(actual, expectedBuffer);
}

function normalizeEmail(email: string) {
  const value = String(email || '').trim().toLowerCase();
  if (!value.includes('@')) throw new BadRequestException('Email invalido');
  return value;
}

function normalizeSlug(value: string) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'cliente';
}

function normalizeSchemaName(value: string) {
  const normalized = String(value || '').trim().toLowerCase();
  if (!/^[a-z][a-z0-9_]*$/.test(normalized)) {
    throw new BadRequestException('Schema invalido');
  }
  return normalized;
}

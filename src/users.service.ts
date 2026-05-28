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

type UpdateUserInput = {
  clientId?: number;
  role?: string;
};

type UpdatePasswordInput = {
  password?: string;
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
    const isPlatformAdmin = role === 'platform_admin';

    if (!name || !password || (!isPlatformAdmin && !Number.isFinite(clientId))) {
      throw new BadRequestException('Nome, email, senha e cliente sao obrigatorios');
    }

    if (!isPlatformAdmin) {
      const client = await this.db.query('select 1 from public.clients where id = $1 and enabled = true', [clientId]);
      if (!client.rows[0]) {
        throw new BadRequestException('Cliente invalido');
      }
    }

    const user = await this.db.query<{ id: number }>(
      `
      insert into public.app_users (name, email, password_hash, is_platform_admin)
      values ($1, $2, $3, $4)
      on conflict (email) do update set
        name = excluded.name,
        password_hash = excluded.password_hash,
        is_platform_admin = excluded.is_platform_admin,
        enabled = true,
        updated_at = now()
      returning id
      `,
      [name, email, hashPassword(password), isPlatformAdmin],
    );

    if (isPlatformAdmin) {
      return { ok: true, userId: user.rows[0].id };
    }

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

  async updateRole(auth: AuthContext, userId: number, input: UpdateUserInput) {
    this.requirePlatformAdmin(auth);
    if (!Number.isFinite(userId) || userId <= 0) {
      throw new BadRequestException('Usuario invalido');
    }

    const role = normalizeRole(input.role || 'viewer');
    const clientId = Number(input.clientId);
    const isPlatformAdmin = role === 'platform_admin';

    const user = await this.db.query('select 1 from public.app_users where id = $1 and enabled = true', [userId]);
    if (!user.rows[0]) {
      throw new BadRequestException('Usuario invalido');
    }

    if (isPlatformAdmin) {
      await this.db.query(
        `
        update public.app_users
        set is_platform_admin = true,
            updated_at = now()
        where id = $1
        `,
        [userId],
      );
      return { ok: true };
    }

    if (!Number.isFinite(clientId)) {
      throw new BadRequestException('Cliente e obrigatorio para perfil de ambiente');
    }

    const client = await this.db.query('select 1 from public.clients where id = $1 and enabled = true', [clientId]);
    if (!client.rows[0]) {
      throw new BadRequestException('Cliente invalido');
    }

    await this.db.query(
      `
      update public.app_users
      set is_platform_admin = false,
          updated_at = now()
      where id = $1
      `,
      [userId],
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
      [userId, clientId, role],
    );

    return { ok: true };
  }

  async updatePassword(auth: AuthContext, userId: number, input: UpdatePasswordInput) {
    this.requirePlatformAdmin(auth);
    if (!Number.isFinite(userId) || userId <= 0) {
      throw new BadRequestException('Usuario invalido');
    }

    const password = String(input.password || '');
    if (password.length < 6) {
      throw new BadRequestException('A senha deve ter pelo menos 6 caracteres');
    }

    const user = await this.db.query('select 1 from public.app_users where id = $1 and enabled = true', [userId]);
    if (!user.rows[0]) {
      throw new BadRequestException('Usuario invalido');
    }

    await this.db.query(
      `
      update public.app_users
      set password_hash = $2,
          updated_at = now()
      where id = $1
      `,
      [userId, hashPassword(password)],
    );

    if (userId !== auth.userId) {
      await this.db.query(
        `
        update public.app_sessions
        set revoked_at = coalesce(revoked_at, now()),
            updated_at = now()
        where user_id = $1
        `,
        [userId],
      );
    }

    return { ok: true };
  }

  async delete(auth: AuthContext, userId: number) {
    this.requirePlatformAdmin(auth);
    if (!Number.isFinite(userId) || userId <= 0) {
      throw new BadRequestException('Usuario invalido');
    }
    if (userId === auth.userId) {
      throw new BadRequestException('Voce nao pode excluir seu proprio usuario');
    }

    await this.db.query(
      `
      update public.app_users
      set enabled = false,
          updated_at = now()
      where id = $1
      `,
      [userId],
    );
    await this.db.query(
      `
      update public.user_clients
      set enabled = false,
          updated_at = now()
      where user_id = $1
      `,
      [userId],
    );
    await this.db.query(
      `
      update public.app_sessions
      set revoked_at = coalesce(revoked_at, now()),
          updated_at = now()
      where user_id = $1
      `,
      [userId],
    );
    return { ok: true };
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
  if (!['platform_admin', 'owner', 'admin', 'operator', 'viewer'].includes(value)) {
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

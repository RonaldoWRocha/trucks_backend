import { BadRequestException, Injectable } from '@nestjs/common';
import { DatabaseService } from './database.service';
import { AuthContext } from './auth.types';

type CredentialsInput = {
  apiUrl?: string;
  login?: string;
  password?: string;
};

@Injectable()
export class CredentialsService {
  constructor(private readonly db: DatabaseService) {}

  async status(auth: AuthContext) {
    const result = await this.db.query<{
      id: number;
      api_url: string;
      login: string;
      enabled: boolean;
      last_test_at: Date | null;
      last_test_status: string | null;
      last_test_message: string | null;
      updated_at: Date;
    }>(
      `
      select id, api_url, login, enabled, last_test_at, last_test_status, last_test_message, updated_at
      from public.integration_credentials
      where client_id = $1 and provider = 'trucks'
      limit 1
      `,
      [auth.clientId],
    );

    const row = result.rows[0];
    return {
      configured: Boolean(row?.enabled),
      credential: row
        ? {
            id: row.id,
            apiUrl: row.api_url,
            login: row.login,
            enabled: row.enabled,
            lastTestAt: row.last_test_at,
            lastTestStatus: row.last_test_status,
            lastTestMessage: row.last_test_message,
            updatedAt: row.updated_at,
          }
        : null,
    };
  }

  async save(auth: AuthContext, input: CredentialsInput) {
    const key = encryptionKey();
    const apiUrl = String(input.apiUrl || 'https://webservice.newrastreamentoonline.com.br/').trim();
    const login = String(input.login || '').trim();
    const password = String(input.password || '');

    if (!apiUrl || !login) {
      throw new BadRequestException('URL e login sao obrigatorios');
    }

    const current = await this.db.query<{ id: number }>(
      `
      select id
      from public.integration_credentials
      where client_id = $1 and provider = 'trucks'
      limit 1
      `,
      [auth.clientId],
    );

    if (!current.rows[0] && !password) {
      throw new BadRequestException('Senha e obrigatoria no primeiro cadastro');
    }

    if (current.rows[0]) {
      await this.db.query(
        `
        update public.integration_credentials
        set api_url = $2,
            login = $3,
            password_encrypted = case
              when $4 = '' then password_encrypted
              else encode(pgp_sym_encrypt($4, $5), 'base64')
            end,
            enabled = true,
            updated_by = $6,
            updated_at = now()
        where client_id = $1 and provider = 'trucks'
        `,
        [auth.clientId, apiUrl, login, password, key, auth.userId],
      );
    } else {
      await this.db.query(
        `
        insert into public.integration_credentials (
          client_id, provider, api_url, login, password_encrypted, enabled, created_by, updated_by
        )
        values ($1, 'trucks', $2, $3, encode(pgp_sym_encrypt($4, $5), 'base64'), true, $6, $6)
        `,
        [auth.clientId, apiUrl, login, password, key, auth.userId],
      );
    }

    return this.status(auth);
  }
}

function encryptionKey() {
  const key = process.env.APP_ENCRYPTION_KEY;
  if (!key) {
    throw new BadRequestException('APP_ENCRYPTION_KEY nao configurada na API');
  }
  return key;
}

import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { Pool, PoolConfig, QueryResult, QueryResultRow } from 'pg';
import { loadEnvironment } from './support/env';

@Injectable()
export class DatabaseService implements OnModuleDestroy {
  private readonly pool: Pool;

  constructor() {
    loadEnvironment();
    const connectionString = process.env.POSTGRES_DSN;
    if (!connectionString) {
      throw new Error('POSTGRES_DSN nao configurado');
    }

    this.pool = new Pool(toPoolConfig(connectionString));
  }

  query<T extends QueryResultRow = QueryResultRow>(
    text: string,
    params: unknown[] = [],
  ): Promise<QueryResult<T>> {
    return this.pool.query<T>(text, params);
  }

  async onModuleDestroy() {
    await this.pool.end();
  }
}

function toPoolConfig(dsn: string): PoolConfig {
  if (dsn.includes('://')) {
    return { connectionString: dsn };
  }

  const config: PoolConfig = {};
  const pattern = /(\w+)=("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|\S+)/g;
  for (const match of dsn.matchAll(pattern)) {
    const key = match[1];
    const raw = match[2].replace(/^['"]|['"]$/g, '');
    if (key === 'host') config.host = raw;
    if (key === 'port') config.port = Number(raw);
    if (key === 'dbname') config.database = raw;
    if (key === 'user') config.user = raw;
    if (key === 'password') config.password = raw;
    if (key === 'sslmode' && raw === 'require') config.ssl = { rejectUnauthorized: false };
  }
  return config;
}

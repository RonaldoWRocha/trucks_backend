import { BadRequestException, ForbiddenException, Injectable } from '@nestjs/common';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { DatabaseService } from './database.service';
import { AuthContext } from './auth.types';

const INTEGRATION_JOBS = [
  { jobName: 'veiculos', requestType: 'RequestVeiculo', intervalSeconds: 86400 },
  { jobName: 'telemetria_relatorio', requestType: 'RequestTelemetriaRelatorio', intervalSeconds: 300 },
  { jobName: 'mensagens_cb', requestType: 'RequestMensagemCB', intervalSeconds: 60 },
  { jobName: 'ocorrencias_telemetria', requestType: 'RequestTelemetriaOcorrencias', intervalSeconds: 86400 },
];

const CLONE_DATA_TABLES = new Set(['integration_jobs']);

type CreateClientInput = {
  clientName?: string;
  slug?: string;
  schemaName?: string;
  sourceSchema?: string;
  copyData?: boolean;
};

@Injectable()
export class ClientsService {
  constructor(private readonly db: DatabaseService) {}

  async list(auth: AuthContext) {
    this.requirePlatformAdmin(auth);
    const result = await this.db.query(
      `
      select
        c.id,
        c.name,
        c.slug,
        c.schema_name,
        c.enabled,
        c.created_at,
        count(uc.user_id)::int as users
      from public.clients c
      left join public.user_clients uc on uc.client_id = c.id
      group by c.id
      order by c.created_at desc
      `,
    );
    return result.rows.map(camelize);
  }

  async create(auth: AuthContext, input: CreateClientInput) {
    this.requirePlatformAdmin(auth);

    const clientName = String(input.clientName || '').trim();
    const slug = normalizeSlug(input.slug || clientName);
    const schemaName = normalizeSchemaName(input.schemaName || slug.replace(/-/g, '_'));
    const sourceSchema = input.sourceSchema ? normalizeSchemaName(input.sourceSchema) : '';

    if (!clientName) {
      throw new BadRequestException('Cliente e obrigatorio');
    }

    if (sourceSchema) {
      await this.cloneClientSchema(sourceSchema, schemaName, Boolean(input.copyData));
    } else {
      await this.createClientSchema(schemaName);
    }

    const client = await this.db.query<{ id: number }>(
      `
      insert into public.clients (name, slug, schema_name)
      values ($1, $2, $3)
      returning id
      `,
      [clientName, slug, schemaName],
    );

    return { ok: true, clientId: client.rows[0].id, schemaName };
  }

  private async createClientSchema(schemaName: string) {
    const schema = quoteIdent(schemaName);
    const schemaPath = resolve(process.cwd(), '..', 'telemetria_dados', 'schema.sql');
    const schemaSql = readFileSync(schemaPath, 'utf-8')
      .replace('CREATE SCHEMA IF NOT EXISTS trucks;', `CREATE SCHEMA IF NOT EXISTS ${schema};`)
      .replace(/trucks\./g, `${schema}.`);

    await this.db.query(schemaSql);
    for (const job of INTEGRATION_JOBS) {
      await this.db.query(
        `
        insert into ${schema}.integration_jobs (job_name, request_type, interval_seconds)
        values ($1, $2, $3)
        on conflict (job_name) do update set
          request_type = excluded.request_type,
          interval_seconds = excluded.interval_seconds,
          updated_at = now()
        `,
        [job.jobName, job.requestType, job.intervalSeconds],
      );
    }
  }

  private async cloneClientSchema(sourceSchema: string, targetSchema: string, copyData: boolean) {
    await this.createClientSchema(targetSchema);
    if (!copyData) return;

    const source = quoteIdent(sourceSchema);
    const target = quoteIdent(targetSchema);
    const tables = await this.db.query<{ table_name: string }>(
      `
      select s.table_name
      from information_schema.tables s
      join information_schema.tables t on t.table_schema = $2 and t.table_name = s.table_name
      where s.table_schema = $1
        and s.table_type = 'BASE TABLE'
        and t.table_type = 'BASE TABLE'
      order by s.table_name
      `,
      [sourceSchema, targetSchema],
    );

    for (const row of tables.rows) {
      if (!CLONE_DATA_TABLES.has(row.table_name)) continue;

      const table = quoteIdent(row.table_name);
      const columns = await this.db.query<{ column_name: string }>(
        `
        select s.column_name
        from information_schema.columns s
        join information_schema.columns t
          on t.table_schema = $2
         and t.table_name = s.table_name
         and t.column_name = s.column_name
        where s.table_schema = $1
          and s.table_name = $3
        order by s.ordinal_position
        `,
        [sourceSchema, targetSchema, row.table_name],
      );

      const columnList = columns.rows.map((column) => quoteIdent(column.column_name)).join(', ');
      if (!columnList) continue;

      await this.db.query(
        `
        insert into ${target}.${table} (${columnList})
        select ${columnList}
        from ${source}.${table}
        on conflict do nothing
        `,
      );
    }

    await this.resetSequences(targetSchema);
  }

  private async resetSequences(schemaName: string) {
    const schema = quoteIdent(schemaName);
    const sequences = await this.db.query<{ table_name: string; column_name: string; sequence_name: string }>(
      `
      select
        cols.table_name,
        cols.column_name,
        pg_get_serial_sequence(format('%I.%I', cols.table_schema, cols.table_name), cols.column_name) as sequence_name
      from information_schema.columns cols
      where cols.table_schema = $1
        and pg_get_serial_sequence(format('%I.%I', cols.table_schema, cols.table_name), cols.column_name) is not null
      `,
      [schemaName],
    );

    for (const sequence of sequences.rows) {
      await this.db.query(
        `
        select setval(
          $1::regclass,
          greatest(coalesce((select max(${quoteIdent(sequence.column_name)}) from ${schema}.${quoteIdent(sequence.table_name)}), 0), 1),
          true
        )
        `,
        [sequence.sequence_name],
      );
    }
  }

  private requirePlatformAdmin(auth: AuthContext) {
    if (!auth.isPlatformAdmin) {
      throw new ForbiddenException('Apenas admin da plataforma pode gerenciar clientes');
    }
  }
}

function normalizeSlug(value: string) {
  return (
    String(value || '')
      .trim()
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9_-]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'cliente'
  );
}

function normalizeSchemaName(value: string) {
  const normalized = String(value || '').trim().toLowerCase();
  if (!/^[a-z][a-z0-9_]*$/.test(normalized)) {
    throw new BadRequestException('Schema invalido');
  }
  return normalized;
}

function quoteIdent(value: string) {
  if (!/^[a-z][a-z0-9_]*$/.test(value)) {
    throw new BadRequestException('Schema invalido');
  }
  return `"${value}"`;
}

function camelize(row: Record<string, unknown>) {
  return Object.fromEntries(
    Object.entries(row).map(([key, value]) => [
      key.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase()),
      value,
    ]),
  );
}

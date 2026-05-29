import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { AuthContext } from './auth.types';
import { DatabaseService } from './database.service';

type DriverInput = {
  name?: string;
  cpf?: string;
  rg?: string;
  birthDate?: string;
  phone?: string;
  email?: string;
  cnhNumber?: string;
  cnhCategory?: string;
  cnhExpiresAt?: string;
  moppExpiresAt?: string;
  admissionDate?: string;
  contractType?: string;
  registrationNumber?: string;
  status?: string;
  assignedVehiclePlate?: string;
  base?: string;
  address?: string;
  emergencyContactName?: string;
  emergencyContactPhone?: string;
  notes?: string;
};

const WRITE_ROLES = new Set(['owner', 'admin', 'operator']);
const STATUSES = new Set(['ativo', 'inativo', 'afastado', 'ferias', 'desligado']);

@Injectable()
export class DriversService {
  constructor(private readonly db: DatabaseService) {}

  async list(auth: AuthContext) {
    await this.ensureTable(auth.schemaName);
    const schema = quoteIdent(auth.schemaName);
    const result = await this.db.query(
      `
      select *
      from ${schema}.motoristas
      order by name
      `,
    );
    return result.rows.map(camelize);
  }

  async create(auth: AuthContext, input: DriverInput) {
    this.requireWrite(auth);
    await this.ensureTable(auth.schemaName);
    const data = normalizeDriver(input);
    const schema = quoteIdent(auth.schemaName);
    const result = await this.db.query(
      `
      insert into ${schema}.motoristas (
        name, cpf, rg, birth_date, phone, email, cnh_number, cnh_category,
        cnh_expires_at, mopp_expires_at, admission_date, contract_type,
        registration_number, status, assigned_vehicle_plate, base, address,
        emergency_contact_name, emergency_contact_phone, notes
      )
      values (
        $1, $2, $3, $4, $5, $6, $7, $8,
        $9, $10, $11, $12, $13, $14, $15, $16, $17,
        $18, $19, $20
      )
      returning *
      `,
      driverParams(data),
    );
    return camelize(result.rows[0]);
  }

  async update(auth: AuthContext, id: number, input: DriverInput) {
    this.requireWrite(auth);
    await this.ensureTable(auth.schemaName);
    const data = normalizeDriver(input);
    const schema = quoteIdent(auth.schemaName);
    const result = await this.db.query(
      `
      update ${schema}.motoristas
      set name = $1,
          cpf = $2,
          rg = $3,
          birth_date = $4,
          phone = $5,
          email = $6,
          cnh_number = $7,
          cnh_category = $8,
          cnh_expires_at = $9,
          mopp_expires_at = $10,
          admission_date = $11,
          contract_type = $12,
          registration_number = $13,
          status = $14,
          assigned_vehicle_plate = $15,
          base = $16,
          address = $17,
          emergency_contact_name = $18,
          emergency_contact_phone = $19,
          notes = $20,
          updated_at = now()
      where id = $21
      returning *
      `,
      [...driverParams(data), id],
    );
    if (!result.rowCount) {
      throw new NotFoundException('Motorista nao encontrado');
    }
    return camelize(result.rows[0]);
  }

  async remove(auth: AuthContext, id: number) {
    this.requireWrite(auth);
    await this.ensureTable(auth.schemaName);
    const schema = quoteIdent(auth.schemaName);
    const result = await this.db.query(`delete from ${schema}.motoristas where id = $1`, [id]);
    if (!result.rowCount) {
      throw new NotFoundException('Motorista nao encontrado');
    }
    return { ok: true };
  }

  async import(auth: AuthContext, rows: DriverInput[]) {
    this.requireWrite(auth);
    if (!Array.isArray(rows) || rows.length === 0) {
      throw new BadRequestException('Nenhum motorista para importar');
    }
    if (rows.length > 1000) {
      throw new BadRequestException('Importe no maximo 1000 motoristas por arquivo');
    }

    await this.ensureTable(auth.schemaName);
    const schema = quoteIdent(auth.schemaName);
    let inserted = 0;
    let updated = 0;
    const errors: Array<{ row: number; message: string }> = [];

    for (const [index, row] of rows.entries()) {
      try {
        const data = normalizeDriver(row);
        const result = await this.db.query(
          `
          insert into ${schema}.motoristas (
            name, cpf, rg, birth_date, phone, email, cnh_number, cnh_category,
            cnh_expires_at, mopp_expires_at, admission_date, contract_type,
            registration_number, status, assigned_vehicle_plate, base, address,
            emergency_contact_name, emergency_contact_phone, notes
          )
          values (
            $1, $2, $3, $4, $5, $6, $7, $8,
            $9, $10, $11, $12, $13, $14, $15, $16, $17,
            $18, $19, $20
          )
          on conflict (cpf) where cpf is not null do update set
            name = excluded.name,
            rg = excluded.rg,
            birth_date = excluded.birth_date,
            phone = excluded.phone,
            email = excluded.email,
            cnh_number = excluded.cnh_number,
            cnh_category = excluded.cnh_category,
            cnh_expires_at = excluded.cnh_expires_at,
            mopp_expires_at = excluded.mopp_expires_at,
            admission_date = excluded.admission_date,
            contract_type = excluded.contract_type,
            registration_number = excluded.registration_number,
            status = excluded.status,
            assigned_vehicle_plate = excluded.assigned_vehicle_plate,
            base = excluded.base,
            address = excluded.address,
            emergency_contact_name = excluded.emergency_contact_name,
            emergency_contact_phone = excluded.emergency_contact_phone,
            notes = excluded.notes,
            updated_at = now()
          returning (xmax = 0) as inserted
          `,
          driverParams(data),
        );
        if (result.rows[0]?.inserted) inserted += 1;
        else updated += 1;
      } catch (error) {
        errors.push({ row: index + 2, message: error instanceof Error ? error.message : 'Linha invalida' });
      }
    }

    return { inserted, updated, errors };
  }

  private async ensureTable(schemaName: string) {
    const schema = quoteIdent(schemaName);
    await this.db.query(`
      create table if not exists ${schema}.motoristas (
        id bigserial primary key,
        name text not null,
        cpf text,
        rg text,
        birth_date date,
        phone text,
        email text,
        cnh_number text,
        cnh_category text,
        cnh_expires_at date,
        mopp_expires_at date,
        admission_date date,
        contract_type text,
        registration_number text,
        status text not null default 'ativo',
        assigned_vehicle_plate text,
        base text,
        address text,
        emergency_contact_name text,
        emergency_contact_phone text,
        notes text,
        created_at timestamptz not null default now(),
        updated_at timestamptz not null default now()
      );

      create unique index if not exists ux_motoristas_cpf
      on ${schema}.motoristas (cpf)
      where cpf is not null;

      create index if not exists idx_motoristas_name
      on ${schema}.motoristas (name);

      create index if not exists idx_motoristas_status
      on ${schema}.motoristas (status);
    `);
  }

  private requireWrite(auth: AuthContext) {
    if (!auth.isPlatformAdmin && !WRITE_ROLES.has(auth.role)) {
      throw new ForbiddenException('Usuario sem permissao para gerenciar motoristas');
    }
  }
}

function normalizeDriver(input: DriverInput) {
  const name = clean(input.name);
  if (!name) {
    throw new BadRequestException('Nome do motorista e obrigatorio');
  }
  const status = clean(input.status || 'ativo').toLowerCase();
  if (!STATUSES.has(status)) {
    throw new BadRequestException('Status invalido');
  }
  return {
    name,
    cpf: digits(input.cpf),
    rg: clean(input.rg),
    birthDate: dateOrNull(input.birthDate),
    phone: clean(input.phone),
    email: clean(input.email).toLowerCase(),
    cnhNumber: clean(input.cnhNumber),
    cnhCategory: clean(input.cnhCategory).toUpperCase(),
    cnhExpiresAt: dateOrNull(input.cnhExpiresAt),
    moppExpiresAt: dateOrNull(input.moppExpiresAt),
    admissionDate: dateOrNull(input.admissionDate),
    contractType: clean(input.contractType),
    registrationNumber: clean(input.registrationNumber),
    status,
    assignedVehiclePlate: clean(input.assignedVehiclePlate).toUpperCase(),
    base: clean(input.base),
    address: clean(input.address),
    emergencyContactName: clean(input.emergencyContactName),
    emergencyContactPhone: clean(input.emergencyContactPhone),
    notes: clean(input.notes),
  };
}

function driverParams(data: ReturnType<typeof normalizeDriver>) {
  return [
    data.name,
    data.cpf || null,
    data.rg || null,
    data.birthDate,
    data.phone || null,
    data.email || null,
    data.cnhNumber || null,
    data.cnhCategory || null,
    data.cnhExpiresAt,
    data.moppExpiresAt,
    data.admissionDate,
    data.contractType || null,
    data.registrationNumber || null,
    data.status,
    data.assignedVehiclePlate || null,
    data.base || null,
    data.address || null,
    data.emergencyContactName || null,
    data.emergencyContactPhone || null,
    data.notes || null,
  ];
}

function clean(value: unknown) {
  return String(value ?? '').trim();
}

function digits(value: unknown) {
  return clean(value).replace(/\D/g, '') || '';
}

function dateOrNull(value: unknown) {
  const text = clean(value);
  if (!text) return null;
  const normalized = text.includes('/') ? text.split('/').reverse().join('-') : text;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(normalized)) {
    throw new BadRequestException(`Data invalida: ${text}`);
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

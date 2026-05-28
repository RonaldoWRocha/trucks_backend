import { Injectable, NotFoundException } from '@nestjs/common';
import { DatabaseService } from './database.service';

type VehicleFilter = {
  search?: string;
  status?: string;
  limit: number;
};

type AlertFilter = {
  period?: string;
  severity?: string;
  search?: string;
  limit: number;
};

@Injectable()
export class TelemetryService {
  constructor(private readonly db: DatabaseService) {}

  async dashboard(schemaName: string) {
    const [vehicles, alerts, daily, topEvents, integration] = await Promise.all([
      this.vehicleStats(schemaName),
      this.alertStats(schemaName),
      this.dailyActivity(schemaName),
      this.topEventTypes(schemaName),
      this.integration(schemaName),
    ]);

    return {
      vehicles,
      alerts,
      daily,
      topEventTypes: topEvents,
      jobs: integration.jobs,
      generatedAt: new Date().toISOString(),
    };
  }

  async vehicles(schemaName: string, filter: VehicleFilter) {
    const schema = quoteIdent(schemaName);
    const params: unknown[] = [];
    const where: string[] = [];

    if (filter.search) {
      params.push(`%${filter.search.toLowerCase()}%`);
      where.push(
        `(lower(v.placa) like $${params.length} or lower(coalesce(v.driver, '')) like $${params.length} or v.veiculo_id::text like $${params.length})`,
      );
    }

    if (filter.status && filter.status !== 'todos') {
      params.push(filter.status);
      where.push(`status = $${params.length}`);
    }

    params.push(filter.limit);

    const result = await this.db.query(
      `
      with latest_msg as (
        select distinct on (veiculo_id)
          veiculo_id, data_hora, latitude, longitude, municipio, uf, velocidade,
          rpm, odometro, evt4_ignicao_acionada
        from ${schema}.mensagens_cb
        order by veiculo_id, data_hora desc
      ),
      latest_report as (
        select distinct on (veiculo_id)
          veiculo_id, distancia, velocidade_media, velocidade_max, media_consumo,
          rpm_medio, hodometro_fim, total_motor_lig, total_motor_lig_par
        from ${schema}.telemetria_relatorio
        order by veiculo_id, data_referencia desc
      ),
      base as (
        select
          v.veiculo_id,
          v.placa,
          coalesce(v.nome_motorista, 'Sem motorista') as driver,
          v.chassi,
          coalesce(v.identificacao_equipamento, v.tipo_equipamento::text, 'Nao informado') as equip,
          coalesce(lm.data_hora, v.updated_at, v.created_at) as last_message_at,
          lm.latitude,
          lm.longitude,
          lm.municipio,
          lm.uf,
          coalesce(lm.velocidade, 0) as speed,
          coalesce(lm.rpm, lr.rpm_medio, 0) as rpm,
          coalesce(lm.evt4_ignicao_acionada, false) as ignition,
          coalesce(lm.odometro, lr.hodometro_fim, 0) as odometer,
          coalesce(lr.distancia, 0) as distance_7d,
          coalesce(lr.velocidade_media, 0) as avg_speed,
          coalesce(lr.velocidade_max, 0) as max_speed,
          coalesce(lr.media_consumo, 0) as fuel,
          coalesce(extract(epoch from lr.total_motor_lig) / 3600, 0) as motor_on_h,
          coalesce(extract(epoch from lr.total_motor_lig_par) / 3600, 0) as idle_h,
          case
            when lm.data_hora is null then 'sem-comm'
            when lm.data_hora < now() - interval '10 minutes' then 'sem-comm'
            else 'online'
          end as status
        from ${schema}.veiculos v
        left join latest_msg lm on lm.veiculo_id = v.veiculo_id
        left join latest_report lr on lr.veiculo_id = v.veiculo_id
      )
      select *
      from base v
      ${where.length ? `where ${where.join(' and ')}` : ''}
      order by placa nulls last, veiculo_id
      limit $${params.length}
      `,
      params,
    );

    return result.rows.map((row) => this.mapVehicle(row));
  }

  async vehicle(schemaName: string, plate: string) {
    const rows = await this.vehicles(schemaName, { search: plate, status: undefined, limit: 20 });
    const vehicle = rows.find((item) => item.plate === plate || String(item.veiculoId) === plate);
    if (!vehicle) {
      throw new NotFoundException('Veiculo nao encontrado');
    }
    return vehicle;
  }

  async vehicleTimeline(schemaName: string, plate: string, limit: number) {
    const schema = quoteIdent(schemaName);
    const result = await this.db.query(
      `
      with target as (
        select veiculo_id, placa
        from ${schema}.veiculos
        where placa = $1 or veiculo_id::text = $1
        limit 1
      ),
      events as (
        select
          'mensagem-' || m.mensagem_id as id,
          m.data_hora as when_at,
          coalesce(nullif(m.alerta_telemetria, ''), 'Mensagem de bordo') as label,
          case
            when m.evt2_sirene_acionada or m.evt3_veiculo_bloqueado or m.evt27_desengate_carreta2 then 'crit'
            when m.velocidade >= 100 or m.rpm >= 2400 then 'warn'
            else 'info'
          end as severity,
          concat_ws(' - ', m.municipio, m.uf) as location,
          m.velocidade as speed,
          m.rpm
        from ${schema}.mensagens_cb m
        join target t on t.veiculo_id = m.veiculo_id
        union all
        select
          'ocorrencia-' || o.id as id,
          o.data_hora as when_at,
          'Ocorrencia de telemetria' as label,
          case when o.velocidade_max >= 100 or o.rpm >= 2400 then 'warn' else 'info' end as severity,
          '' as location,
          o.velocidade,
          o.rpm
        from ${schema}.ocorrencias_telemetria o
        join target t on t.veiculo_id = o.veiculo_id
      )
      select *
      from events
      order by when_at desc
      limit $2
      `,
      [plate, limit],
    );

    return result.rows.map((row) => this.mapEvent(row));
  }

  async vehiclePositions(schemaName: string, plate: string, hours: number) {
    const schema = quoteIdent(schemaName);
    const result = await this.db.query(
      `
      with target as (
        select veiculo_id
        from ${schema}.veiculos
        where placa = $1 or veiculo_id::text = $1
        limit 1
      )
      select
        m.mensagem_id as id,
        m.data_hora as when_at,
        m.latitude,
        m.longitude,
        m.velocidade,
        m.municipio,
        m.uf
      from ${schema}.mensagens_cb m
      join target t on t.veiculo_id = m.veiculo_id
      where m.latitude is not null
        and m.longitude is not null
        and m.data_hora >= now() - ($2::text || ' hours')::interval
      order by m.data_hora asc
      limit 1000
      `,
      [plate, hours],
    );

    return result.rows.map((row) => ({
      id: row.id,
      whenAt: row.when_at,
      lat: toNumber(row.latitude),
      lng: toNumber(row.longitude),
      speed: toNumber(row.velocidade),
      city: row.municipio,
      uf: row.uf,
    }));
  }

  async alerts(schemaName: string, filter: AlertFilter) {
    const schema = quoteIdent(schemaName);
    const params: unknown[] = [];
    const where: string[] = [];
    const period = periodToInterval(filter.period);

    if (period) {
      params.push(period);
      where.push(`when_at >= now() - $${params.length}::interval`);
    }
    if (filter.severity && filter.severity !== 'todos') {
      params.push(filter.severity);
      where.push(`severity = $${params.length}`);
    }
    if (filter.search) {
      params.push(`%${filter.search.toLowerCase()}%`);
      where.push(
        `(lower(plate) like $${params.length} or lower(driver) like $${params.length} or lower(label) like $${params.length})`,
      );
    }

    params.push(filter.limit);

    const result = await this.db.query(
      `
      with events as (
        select
          'mensagem-' || m.mensagem_id as id,
          m.data_hora as when_at,
          v.placa as plate,
          coalesce(v.nome_motorista, 'Sem motorista') as driver,
          coalesce(
            nullif(m.alerta_telemetria, ''),
            case
              when m.evt2_sirene_acionada then 'Sirene acionada'
              when m.evt3_veiculo_bloqueado then 'Veiculo bloqueado'
              when m.evt27_desengate_carreta2 then 'Desengate de carreta'
              when m.evt12_porta_carona_aberta then 'Porta carona aberta'
              when m.evt13_porta_motorista_aberta then 'Porta motorista aberta'
              when m.velocidade >= 90 then 'Excesso de velocidade'
              when m.rpm >= 2200 then 'RPM elevado'
              else 'Mensagem de bordo'
            end
          ) as label,
          case
            when m.evt2_sirene_acionada or m.evt3_veiculo_bloqueado or m.evt27_desengate_carreta2 then 'crit'
            when m.velocidade >= 100 or m.rpm >= 2400 then 'warn'
            else 'info'
          end as severity,
          concat_ws(' - ', m.municipio, m.uf) as location,
          m.velocidade as speed,
          m.rpm
        from ${schema}.mensagens_cb m
        left join ${schema}.veiculos v on v.veiculo_id = m.veiculo_id
        where m.evt2_sirene_acionada
           or m.evt3_veiculo_bloqueado
           or m.evt12_porta_carona_aberta
           or m.evt13_porta_motorista_aberta
           or m.evt27_desengate_carreta2
           or m.velocidade >= 90
           or m.rpm >= 2200
           or nullif(m.alerta_telemetria, '') is not null
        union all
        select
          'ocorrencia-' || o.id as id,
          o.data_hora as when_at,
          v.placa as plate,
          coalesce(v.nome_motorista, 'Sem motorista') as driver,
          'Ocorrencia de telemetria' as label,
          case when o.velocidade_max >= 100 or o.rpm >= 2400 then 'warn' else 'info' end as severity,
          '' as location,
          o.velocidade as speed,
          o.rpm
        from ${schema}.ocorrencias_telemetria o
        left join ${schema}.veiculos v on v.veiculo_id = o.veiculo_id
      ),
      labeled as (
        select *
        from events
      )
      select *
      from labeled
      ${where.length ? `where ${where.join(' and ')}` : ''}
      order by when_at desc
      limit $${params.length}
      `,
      params,
    );

    return result.rows.map((row) => this.mapEvent(row));
  }

  async reportsSummary(schemaName: string) {
    const schema = quoteIdent(schemaName);
    const result = await this.db.query(
      `
      select
        count(*)::int as vehicles,
        coalesce(sum(distancia), 0)::numeric as total_distance,
        coalesce(avg(velocidade_media), 0)::numeric as avg_speed,
        coalesce(avg(media_consumo), 0)::numeric as avg_fuel,
        coalesce(sum(extract(epoch from total_motor_lig_par) / 3600), 0)::numeric as total_idle_h
      from ${schema}.telemetria_relatorio
      where data_referencia >= current_date - interval '7 days'
      `,
    );
    return camelize(result.rows[0] ?? {});
  }

  async integration(schemaName: string) {
    const schema = quoteIdent(schemaName);
    const [jobs, errors, queue] = await Promise.all([
      this.db.query(
        `
        select
          job_name as id,
          job_name as label,
          request_type,
          interval_seconds,
          last_success_at,
          last_error_at,
          last_error_message,
          last_status,
          last_records_inserted,
          last_records_ignored,
          next_run_at
        from ${schema}.integration_jobs
        order by job_name
        `,
      ),
      this.db.query(
        `
        select id, job_name, stage, error_message, occurred_at
        from ${schema}.integration_errors
        order by occurred_at desc
        limit 50
        `,
      ),
      this.db.query(
        `
        select 'veiculos' as job, status, count(*)::int as count from ${schema}.veiculos_temp group by status
        union all
        select 'mensagens_cb' as job, status, count(*)::int as count from ${schema}.mensagens_cb_temp group by status
        union all
        select 'ocorrencias_telemetria' as job, status, count(*)::int as count from ${schema}.ocorrencias_telemetria_temp group by status
        union all
        select 'telemetria_relatorio' as job, status, count(*)::int as count from ${schema}.telemetria_relatorio_temp group by status
        `,
      ),
    ]);

    return {
      jobs: jobs.rows.map((row) => ({
        id: row.id,
        label: row.label,
        requestType: row.request_type,
        intervalSeconds: Number(row.interval_seconds),
        lastSuccessAt: row.last_success_at,
        lastErrorAt: row.last_error_at,
        lastErrorMessage: row.last_error_message,
        status: row.last_status || 'pending',
        inserted: Number(row.last_records_inserted || 0),
        ignored: Number(row.last_records_ignored || 0),
        nextRunAt: row.next_run_at,
      })),
      errors: errors.rows.map(camelize),
      queue: queue.rows.map(camelize),
    };
  }

  private async vehicleStats(schemaName: string) {
    const schema = quoteIdent(schemaName);
    const result = await this.db.query(
      `
      with latest as (
        select distinct on (veiculo_id) veiculo_id, data_hora
        from ${schema}.mensagens_cb
        order by veiculo_id, data_hora desc
      )
      select
        count(v.*)::int as total,
        count(*) filter (where l.data_hora >= now() - interval '10 minutes')::int as online,
        count(*) filter (where l.data_hora < now() - interval '10 minutes' and l.data_hora >= now() - interval '90 minutes')::int as atrasado,
        count(*) filter (where l.data_hora is null or l.data_hora < now() - interval '90 minutes')::int as sem_comm
      from ${schema}.veiculos v
      left join latest l on l.veiculo_id = v.veiculo_id
      `,
    );
    return camelize(result.rows[0] ?? {});
  }

  private async alertStats(schemaName: string) {
    const schema = quoteIdent(schemaName);
    const result = await this.db.query(
      `
      select
        count(*) filter (
          where evt2_sirene_acionada
             or evt3_veiculo_bloqueado
             or evt12_porta_carona_aberta
             or evt13_porta_motorista_aberta
             or evt27_desengate_carreta2
             or velocidade >= 90
             or rpm >= 2200
             or nullif(alerta_telemetria, '') is not null
        )::int as total_24h,
        count(*) filter (
          where evt2_sirene_acionada or evt3_veiculo_bloqueado or evt27_desengate_carreta2
        )::int as critical_24h
      from ${schema}.mensagens_cb
      where data_hora >= now() - interval '24 hours'
      `,
    );
    return camelize(result.rows[0] ?? {});
  }

  private async dailyActivity(schemaName: string) {
    const schema = quoteIdent(schemaName);
    const result = await this.db.query(
      `
      select
        to_char(data_referencia, 'Dy') as day,
        coalesce(sum(distancia), 0)::numeric as km,
        coalesce(avg(media_consumo), 0)::numeric as fuel
      from ${schema}.telemetria_relatorio
      where data_referencia >= current_date - interval '7 days'
      group by data_referencia
      order by data_referencia
      `,
    );
    return result.rows.map(camelize);
  }

  private async topEventTypes(schemaName: string) {
    const schema = quoteIdent(schemaName);
    const result = await this.db.query(
      `
      select label, count(*)::int as count, severity as sev
      from (
        select
          coalesce(
            nullif(m.alerta_telemetria, ''),
            case
              when m.evt2_sirene_acionada then 'Sirene acionada'
              when m.evt3_veiculo_bloqueado then 'Veiculo bloqueado'
              when m.evt27_desengate_carreta2 then 'Desengate de carreta'
              when m.evt12_porta_carona_aberta then 'Porta carona aberta'
              when m.evt13_porta_motorista_aberta then 'Porta motorista aberta'
              when m.velocidade >= 90 then 'Excesso de velocidade'
              when m.rpm >= 2200 then 'RPM elevado'
              else 'Mensagem de bordo'
            end
          ) as label,
          case
            when m.evt2_sirene_acionada or m.evt3_veiculo_bloqueado or m.evt27_desengate_carreta2 then 'crit'
            when m.velocidade >= 100 or m.rpm >= 2400 then 'warn'
            else 'info'
          end as severity
        from ${schema}.mensagens_cb m
        where m.data_hora >= now() - interval '24 hours'
          and (
            m.evt2_sirene_acionada
            or m.evt3_veiculo_bloqueado
            or m.evt12_porta_carona_aberta
            or m.evt13_porta_motorista_aberta
            or m.evt27_desengate_carreta2
            or m.velocidade >= 90
            or m.rpm >= 2200
            or nullif(m.alerta_telemetria, '') is not null
          )
      ) e
      group by label, severity
      order by count desc
      limit 10
      `,
    );
    return result.rows.map(camelize);
  }

  private mapVehicle(row: Record<string, unknown>) {
    const lastMessageAt = row.last_message_at ? new Date(String(row.last_message_at)) : null;
    return {
      veiculoId: Number(row.veiculo_id),
      id: String(row.veiculo_id),
      plate: row.placa,
      driver: row.driver,
      chassis: row.chassi,
      equip: row.equip,
      status: String(row.status || 'sem-comm'),
      lat: toNumber(row.latitude),
      lng: toNumber(row.longitude),
      city: row.municipio,
      uf: row.uf,
      speed: toNumber(row.speed),
      rpm: toNumber(row.rpm),
      ignition: Boolean(row.ignition),
      odometer: toNumber(row.odometer),
      distance7d: toNumber(row.distance_7d),
      avgSpeed: toNumber(row.avg_speed),
      maxSpeed: toNumber(row.max_speed),
      fuel: toNumber(row.fuel),
      motorOnH: toNumber(row.motor_on_h),
      idleH: toNumber(row.idle_h),
      lastMessageAt,
      lastMessageMin: lastMessageAt
        ? Math.max(0, Math.round((Date.now() - lastMessageAt.getTime()) / 60000))
        : null,
    };
  }

  private mapEvent(row: Record<string, unknown>) {
    const when = row.when_at ? new Date(String(row.when_at)) : null;
    return {
      id: row.id,
      whenAt: when,
      when: when?.toISOString(),
      label: row.label,
      sev: row.severity,
      severity: row.severity,
      veh: row.plate,
      plate: row.plate,
      driver: row.driver,
      location: row.location,
      speed: toNumber(row.speed),
      rpm: toNumber(row.rpm),
      status: row.status,
      minAgo: when ? Math.max(0, Math.round((Date.now() - when.getTime()) / 60000)) : null,
    };
  }
}

function periodToInterval(period?: string) {
  if (period === '24h') return '24 hours';
  if (period === '7d') return '7 days';
  if (period === '30d') return '30 days';
  return undefined;
}

function toNumber(value: unknown) {
  if (value === null || value === undefined) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function camelize(row: Record<string, unknown>) {
  return Object.fromEntries(
    Object.entries(row).map(([key, value]) => [
      key.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase()),
      value,
    ]),
  );
}

function quoteIdent(value: string) {
  if (!/^[a-z][a-z0-9_]*$/.test(value)) {
    throw new Error('Schema invalido');
  }
  return `"${value}"`;
}

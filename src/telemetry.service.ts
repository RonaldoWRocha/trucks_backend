import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { AuthContext } from './auth.types';
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

type GamificationDriverFilter = {
  search?: string;
  limit: number;
};

type GamificationPeriod = {
  start?: string;
  end?: string;
};

const FORCE_JOB_ROLES = new Set(['owner', 'admin', 'operator']);

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
        select
          veiculo_id,
          coalesce(sum(distancia), 0) as distancia,
          coalesce(avg(velocidade_media), 0) as velocidade_media,
          coalesce(max(velocidade_max), 0) as velocidade_max,
          coalesce(avg(media_consumo), 0) as media_consumo,
          coalesce(avg(rpm_medio), 0) as rpm_medio,
          max(hodometro_fim) as hodometro_fim,
          coalesce(sum(extract(epoch from total_motor_lig)) * interval '1 second', interval '0 seconds') as total_motor_lig,
          coalesce(sum(extract(epoch from total_motor_deslig)) * interval '1 second', interval '0 seconds') as total_motor_deslig,
          coalesce(sum(extract(epoch from total_motor_lig_par)) * interval '1 second', interval '0 seconds') as total_motor_lig_par
        from ${schema}.telemetria_relatorio
        where data_referencia >= current_date - interval '6 days'
          and data_referencia < current_date + interval '1 day'
        group by veiculo_id
      ),
      alert_counts as (
        select veiculo_id, count(*)::int as alerts_7d
        from (
          with ordered as (
            select
              veiculo_id,
              data_hora,
              coalesce(evt2_sirene_acionada, false) as evt2,
              coalesce(evt3_veiculo_bloqueado, false) as evt3,
              coalesce(evt12_porta_carona_aberta, false) as evt12,
              coalesce(evt13_porta_motorista_aberta, false) as evt13,
              coalesce(evt27_desengate_carreta2, false) as evt27,
              coalesce(velocidade, 0) as velocidade,
              coalesce(rpm, 0) as rpm,
              lag(coalesce(evt2_sirene_acionada, false), 1, false) over (partition by veiculo_id order by data_hora) as prev_evt2,
              lag(coalesce(evt3_veiculo_bloqueado, false), 1, false) over (partition by veiculo_id order by data_hora) as prev_evt3,
              lag(coalesce(evt12_porta_carona_aberta, false), 1, false) over (partition by veiculo_id order by data_hora) as prev_evt12,
              lag(coalesce(evt13_porta_motorista_aberta, false), 1, false) over (partition by veiculo_id order by data_hora) as prev_evt13,
              lag(coalesce(evt27_desengate_carreta2, false), 1, false) over (partition by veiculo_id order by data_hora) as prev_evt27,
              lag(coalesce(velocidade, 0), 1, 0) over (partition by veiculo_id order by data_hora) as prev_velocidade,
              lag(coalesce(rpm, 0), 1, 0) over (partition by veiculo_id order by data_hora) as prev_rpm,
              nullif(alerta_telemetria, '') as alerta_telemetria
            from ${schema}.mensagens_cb
            where data_hora >= now() - interval '7 days' - interval '1 hour'
          )
          select veiculo_id from ordered where data_hora >= now() - interval '7 days' and evt2 and not prev_evt2
          union all select veiculo_id from ordered where data_hora >= now() - interval '7 days' and evt3 and not prev_evt3
          union all select veiculo_id from ordered where data_hora >= now() - interval '7 days' and evt27 and not prev_evt27
          union all select veiculo_id from ordered where data_hora >= now() - interval '7 days' and evt12 and not prev_evt12
          union all select veiculo_id from ordered where data_hora >= now() - interval '7 days' and evt13 and not prev_evt13
          union all select veiculo_id from ordered where data_hora >= now() - interval '7 days' and velocidade >= 90 and prev_velocidade < 90
          union all select veiculo_id from ordered where data_hora >= now() - interval '7 days' and rpm >= 2200 and prev_rpm < 2200
          union all select veiculo_id from ordered where data_hora >= now() - interval '7 days' and alerta_telemetria is not null
        ) e
        group by veiculo_id
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
          coalesce(extract(epoch from lr.total_motor_deslig) / 3600, 0) as motor_off_h,
          coalesce(extract(epoch from lr.total_motor_lig_par) / 3600, 0) as idle_h,
          coalesce(ac.alerts_7d, 0) as alerts_7d,
          case
            when lm.data_hora is null then 'sem-comm'
            when lm.data_hora < now() - interval '10 minutes' then 'sem-comm'
            else 'online'
          end as status
        from ${schema}.veiculos v
        left join latest_msg lm on lm.veiculo_id = v.veiculo_id
        left join latest_report lr on lr.veiculo_id = v.veiculo_id
        left join alert_counts ac on ac.veiculo_id = v.veiculo_id
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
        count(distinct veiculo_id)::int as vehicles,
        coalesce(sum(distancia), 0)::numeric as total_distance,
        coalesce(avg(velocidade_media), 0)::numeric as avg_speed,
        coalesce(avg(media_consumo), 0)::numeric as avg_fuel,
        coalesce(sum(extract(epoch from total_motor_lig_par) / 3600), 0)::numeric as total_idle_h
      from ${schema}.telemetria_relatorio
      where data_referencia >= current_date - interval '6 days'
        and data_referencia < current_date + interval '1 day'
      `,
    );
    return camelize(result.rows[0] ?? {});
  }

  async gamificationDrivers(schemaName: string, filter: GamificationDriverFilter) {
    const schema = quoteIdent(schemaName);
    const params: unknown[] = [];
    const where: string[] = [`nullif(trim(coalesce(v.nome_motorista, '')), '') is not null`];

    if (filter.search) {
      params.push(`%${filter.search.toLowerCase()}%`);
      where.push(`lower(v.nome_motorista) like $${params.length}`);
    }

    params.push(filter.limit);

    const result = await this.db.query(
      `
      with recent as (
        select
          veiculo_id,
          coalesce(sum(distancia), 0)::numeric as distance_30d,
          coalesce(avg(media_consumo), 0)::numeric as fuel_30d,
          max(data_referencia) as last_reference
        from ${schema}.telemetria_relatorio
        where data_referencia >= current_date - interval '30 days'
          and data_referencia < current_date + interval '1 day'
        group by veiculo_id
      )
      select
        v.nome_motorista as name,
        count(distinct v.veiculo_id)::int as vehicles,
        string_agg(distinct v.placa, ', ' order by v.placa) as plates,
        coalesce(sum(r.distance_30d), 0)::numeric as distance_30d,
        coalesce(avg(nullif(r.fuel_30d, 0)), 0)::numeric as fuel_30d,
        max(r.last_reference) as last_reference
      from ${schema}.veiculos v
      left join recent r on r.veiculo_id = v.veiculo_id
      where ${where.join(' and ')}
      group by v.nome_motorista
      order by distance_30d desc, name
      limit $${params.length}
      `,
      params,
    );

    return result.rows.map((row) => ({
      name: row.name,
      vehicles: Number(row.vehicles || 0),
      plates: String(row.plates || ''),
      distance30d: toNumber(row.distance_30d),
      fuel30d: toNumber(row.fuel_30d),
      lastReference: row.last_reference,
    }));
  }

  async driverGamificationReport(schemaName: string, driver: string, period: GamificationPeriod) {
    const start = dateParam(period.start, 'Data inicial invalida');
    const end = dateParam(period.end, 'Data final invalida');
    if (!start || !end) {
      throw new BadRequestException('Informe data inicial e final');
    }
    if (start > end) {
      throw new BadRequestException('Data inicial deve ser menor ou igual a data final');
    }

    const schema = quoteIdent(schemaName);
    const result = await this.db.query(
      `
      select
        r.data_referencia,
        v.nome_motorista as driver,
        v.placa,
        coalesce(v.identificacao_equipamento, v.veiculo_id::text) as fleet,
        coalesce(r.distancia, 0)::numeric as distance,
        coalesce(r.velocidade_media, 0)::numeric as avg_speed,
        coalesce(r.velocidade_max, 0)::numeric as max_speed,
        coalesce(r.media_consumo, 0)::numeric as avg_fuel,
        coalesce(r.rpm_medio, 0)::numeric as avg_rpm,
        coalesce(r.rpm_max, 0)::numeric as max_rpm,
        coalesce(extract(epoch from r.total_motor_lig) / 3600, 0)::numeric as motor_on_h,
        coalesce(extract(epoch from r.total_motor_lig_par) / 3600, 0)::numeric as idle_h
      from ${schema}.telemetria_relatorio r
      join ${schema}.veiculos v on v.veiculo_id = r.veiculo_id
      where lower(v.nome_motorista) = lower($1)
        and r.data_referencia >= $2::date
        and r.data_referencia <= $3::date
      order by r.data_referencia, v.placa
      `,
      [driver, start, end],
    );

    const rows = result.rows.map((row) => {
      const distance = Number(row.distance || 0);
      const avgSpeed = Number(row.avg_speed || 0);
      const maxSpeed = Number(row.max_speed || 0);
      const avgFuel = Number(row.avg_fuel || 0);
      const avgRpm = Number(row.avg_rpm || 0);
      const maxRpm = Number(row.max_rpm || 0);
      const motorOnH = Number(row.motor_on_h || 0);
      const idleH = Number(row.idle_h || 0);
      const idleRatio = motorOnH > 0 ? idleH / motorOnH : 0;
      const scores = scoreTrip({ avgSpeed, maxSpeed, avgFuel, avgRpm, maxRpm, idleRatio });

      return {
        date: row.data_referencia,
        startAt: `${formatDateOnly(row.data_referencia)} 00:00`,
        endAt: `${formatDateOnly(row.data_referencia)} 23:59`,
        driver: row.driver,
        plate: row.placa,
        fleet: row.fleet,
        distance,
        avgSpeed,
        maxSpeed,
        avgFuel,
        avgRpm,
        maxRpm,
        motorOnH,
        idleH,
        idleRatio,
        ...scores,
      };
    });

    const totalDistance = rows.reduce((sum, row) => sum + row.distance, 0);
    const avg = (key: keyof (typeof rows)[number]) =>
      rows.length ? rows.reduce((sum, row) => sum + Number(row[key] || 0), 0) / rows.length : 0;

    return {
      driver,
      start,
      end,
      totals: {
        trips: rows.length,
        distance: totalDistance,
        avgFuel: avg('avgFuel'),
        idleHours: rows.reduce((sum, row) => sum + row.idleH, 0),
        score: Math.round(avg('score')),
        greenBandScore: Math.round(avg('greenBandScore')),
        coastScore: Math.round(avg('coastScore')),
        idleScore: Math.round(avg('idleScore')),
        speedScore: Math.round(avg('speedScore')),
      },
      rows,
    };
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

  async forceIntegrationJob(auth: AuthContext, jobId: string) {
    if (!auth.isPlatformAdmin && !FORCE_JOB_ROLES.has(auth.role)) {
      throw new ForbiddenException('Usuario sem permissao para forcar jobs');
    }

    if (!/^[a-z][a-z0-9_]*$/.test(jobId)) {
      throw new BadRequestException('Job invalido');
    }

    const schema = quoteIdent(auth.schemaName);
    const result = await this.db.query(
      `
      update ${schema}.integration_jobs
      set next_run_at = now(),
          last_status = case when last_status = 'error' then last_status else 'queued' end,
          updated_at = now()
      where job_name = $1
        and enabled = true
      returning
        job_name as id,
        request_type,
        interval_seconds,
        next_run_at,
        last_status
      `,
      [jobId],
    );

    if (!result.rowCount) {
      throw new NotFoundException('Job nao encontrado ou desabilitado');
    }

    return camelize(result.rows[0]);
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
      with ordered as (
        select
          data_hora,
          coalesce(evt2_sirene_acionada, false) as evt2,
          coalesce(evt3_veiculo_bloqueado, false) as evt3,
          coalesce(evt12_porta_carona_aberta, false) as evt12,
          coalesce(evt13_porta_motorista_aberta, false) as evt13,
          coalesce(evt27_desengate_carreta2, false) as evt27,
          coalesce(velocidade, 0) as velocidade,
          coalesce(rpm, 0) as rpm,
          lag(coalesce(evt2_sirene_acionada, false), 1, false) over (partition by veiculo_id order by data_hora) as prev_evt2,
          lag(coalesce(evt3_veiculo_bloqueado, false), 1, false) over (partition by veiculo_id order by data_hora) as prev_evt3,
          lag(coalesce(evt12_porta_carona_aberta, false), 1, false) over (partition by veiculo_id order by data_hora) as prev_evt12,
          lag(coalesce(evt13_porta_motorista_aberta, false), 1, false) over (partition by veiculo_id order by data_hora) as prev_evt13,
          lag(coalesce(evt27_desengate_carreta2, false), 1, false) over (partition by veiculo_id order by data_hora) as prev_evt27,
          lag(coalesce(velocidade, 0), 1, 0) over (partition by veiculo_id order by data_hora) as prev_velocidade,
          lag(coalesce(rpm, 0), 1, 0) over (partition by veiculo_id order by data_hora) as prev_rpm,
          nullif(alerta_telemetria, '') as alerta_telemetria
        from ${schema}.mensagens_cb
        where data_hora >= now() - interval '25 hours'
      ),
      events as (
        select 'crit' as severity from ordered where data_hora >= now() - interval '24 hours' and evt2 and not prev_evt2
        union all select 'crit' from ordered where data_hora >= now() - interval '24 hours' and evt3 and not prev_evt3
        union all select 'crit' from ordered where data_hora >= now() - interval '24 hours' and evt27 and not prev_evt27
        union all select 'info' from ordered where data_hora >= now() - interval '24 hours' and evt12 and not prev_evt12
        union all select 'info' from ordered where data_hora >= now() - interval '24 hours' and evt13 and not prev_evt13
        union all select 'warn' from ordered where data_hora >= now() - interval '24 hours' and velocidade >= 90 and prev_velocidade < 90
        union all select 'warn' from ordered where data_hora >= now() - interval '24 hours' and rpm >= 2200 and prev_rpm < 2200
        union all select 'info' from ordered where data_hora >= now() - interval '24 hours' and alerta_telemetria is not null
      )
      select
        count(*)::int as total_24h,
        count(*) filter (where severity = 'crit')::int as critical_24h
      from events
      `,
    );
    return camelize(result.rows[0] ?? {});
  }

  private async dailyActivity(schemaName: string) {
    const schema = quoteIdent(schemaName);
    const result = await this.db.query(
      `
      select
        data_referencia::text as date,
        to_char(data_referencia, 'Dy') as day,
        coalesce(sum(distancia), 0)::numeric as km,
        coalesce(avg(media_consumo), 0)::numeric as fuel
      from ${schema}.telemetria_relatorio
      where data_referencia >= current_date - interval '6 days'
        and data_referencia < current_date + interval '1 day'
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
        with ordered as (
          select
            data_hora,
            coalesce(evt2_sirene_acionada, false) as evt2,
            coalesce(evt3_veiculo_bloqueado, false) as evt3,
            coalesce(evt12_porta_carona_aberta, false) as evt12,
            coalesce(evt13_porta_motorista_aberta, false) as evt13,
            coalesce(evt27_desengate_carreta2, false) as evt27,
            coalesce(velocidade, 0) as velocidade,
            coalesce(rpm, 0) as rpm,
            lag(coalesce(evt2_sirene_acionada, false), 1, false) over (partition by veiculo_id order by data_hora) as prev_evt2,
            lag(coalesce(evt3_veiculo_bloqueado, false), 1, false) over (partition by veiculo_id order by data_hora) as prev_evt3,
            lag(coalesce(evt12_porta_carona_aberta, false), 1, false) over (partition by veiculo_id order by data_hora) as prev_evt12,
            lag(coalesce(evt13_porta_motorista_aberta, false), 1, false) over (partition by veiculo_id order by data_hora) as prev_evt13,
            lag(coalesce(evt27_desengate_carreta2, false), 1, false) over (partition by veiculo_id order by data_hora) as prev_evt27,
            lag(coalesce(velocidade, 0), 1, 0) over (partition by veiculo_id order by data_hora) as prev_velocidade,
            lag(coalesce(rpm, 0), 1, 0) over (partition by veiculo_id order by data_hora) as prev_rpm,
            nullif(alerta_telemetria, '') as alerta_telemetria
          from ${schema}.mensagens_cb
          where data_hora >= now() - interval '25 hours'
        )
        select 'Sirene acionada' as label, 'crit' as severity from ordered where data_hora >= now() - interval '24 hours' and evt2 and not prev_evt2
        union all select 'Veiculo bloqueado', 'crit' from ordered where data_hora >= now() - interval '24 hours' and evt3 and not prev_evt3
        union all select 'Desengate de carreta', 'crit' from ordered where data_hora >= now() - interval '24 hours' and evt27 and not prev_evt27
        union all select 'Porta carona aberta', 'info' from ordered where data_hora >= now() - interval '24 hours' and evt12 and not prev_evt12
        union all select 'Porta motorista aberta', 'info' from ordered where data_hora >= now() - interval '24 hours' and evt13 and not prev_evt13
        union all select 'Excesso de velocidade', 'warn' from ordered where data_hora >= now() - interval '24 hours' and velocidade >= 90 and prev_velocidade < 90
        union all select 'RPM elevado', 'warn' from ordered where data_hora >= now() - interval '24 hours' and rpm >= 2200 and prev_rpm < 2200
        union all select alerta_telemetria, 'info' from ordered where data_hora >= now() - interval '24 hours' and alerta_telemetria is not null
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
      alerts7d: toNumber(row.alerts_7d),
      avgSpeed: toNumber(row.avg_speed),
      maxSpeed: toNumber(row.max_speed),
      fuel: toNumber(row.fuel),
      motorOnH: toNumber(row.motor_on_h),
      motorOffH: toNumber(row.motor_off_h),
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

function scoreTrip(input: {
  avgSpeed: number;
  maxSpeed: number;
  avgFuel: number;
  avgRpm: number;
  maxRpm: number;
  idleRatio: number;
}) {
  const greenBandScore = clampScore(100 - Math.abs(input.avgRpm - 1450) / 8 - Math.max(0, input.maxRpm - 1900) / 12);
  const coastScore = clampScore(56 + input.avgFuel * 8 - Math.max(0, input.avgSpeed - 72) * 0.8);
  const idleScore = clampScore(100 - input.idleRatio * 180);
  const speedScore = clampScore(100 - Math.max(0, input.maxSpeed - 80) * 2 - Math.max(0, input.avgSpeed - 70));
  const score = Math.round(
    greenBandScore * 0.3 +
      coastScore * 0.25 +
      idleScore * 0.25 +
      speedScore * 0.2,
  );

  return {
    score,
    greenBandScore: Math.round(greenBandScore),
    coastScore: Math.round(coastScore),
    idleScore: Math.round(idleScore),
    speedScore: Math.round(speedScore),
  };
}

function clampScore(value: number) {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(100, value));
}

function dateParam(value: string | undefined, message: string) {
  if (!value) return '';
  const text = String(value).trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    throw new BadRequestException(message);
  }
  return text;
}

function formatDateOnly(value: unknown) {
  if (!value) return '';
  const date = new Date(String(value));
  if (Number.isNaN(date.getTime())) return String(value).slice(0, 10);
  const day = String(date.getUTCDate()).padStart(2, '0');
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  const year = date.getUTCFullYear();
  return `${day}/${month}/${year}`;
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

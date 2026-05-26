import { Controller, Get, Param, Query } from '@nestjs/common';
import { TelemetryService } from './telemetry.service';

@Controller('api')
export class TelemetryController {
  constructor(private readonly telemetry: TelemetryService) {}

  @Get('dashboard')
  dashboard() {
    return this.telemetry.dashboard();
  }

  @Get('vehicles')
  vehicles(
    @Query('search') search?: string,
    @Query('limit') limit?: string,
  ) {
    return this.telemetry.vehicles({ search, limit: toInt(limit, 200) });
  }

  @Get('vehicles/:plate')
  vehicle(@Param('plate') plate: string) {
    return this.telemetry.vehicle(plate);
  }

  @Get('vehicles/:plate/timeline')
  vehicleTimeline(@Param('plate') plate: string, @Query('limit') limit?: string) {
    return this.telemetry.vehicleTimeline(plate, toInt(limit, 50));
  }

  @Get('vehicles/:plate/positions')
  vehiclePositions(@Param('plate') plate: string, @Query('hours') hours?: string) {
    return this.telemetry.vehiclePositions(plate, toInt(hours, 24));
  }

  @Get('alerts')
  alerts(
    @Query('period') period?: string,
    @Query('severity') severity?: string,
    @Query('search') search?: string,
    @Query('limit') limit?: string,
  ) {
    return this.telemetry.alerts({
      period,
      severity,
      search,
      limit: toInt(limit, 200),
    });
  }

  @Get('reports/summary')
  reportsSummary() {
    return this.telemetry.reportsSummary();
  }

  @Get('integration')
  integration() {
    return this.telemetry.integration();
  }
}

function toInt(value: string | undefined, fallback: number) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.min(parsed, 1000) : fallback;
}

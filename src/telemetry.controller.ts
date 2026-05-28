import { Controller, Get, Param, Query, Req, UseGuards } from '@nestjs/common';
import { AuthGuard } from './auth.guard';
import { RequestWithAuth } from './auth.types';
import { TelemetryService } from './telemetry.service';

@Controller('api')
@UseGuards(AuthGuard)
export class TelemetryController {
  constructor(private readonly telemetry: TelemetryService) {}

  @Get('dashboard')
  dashboard(@Req() request: RequestWithAuth) {
    return this.telemetry.dashboard(request.auth!.schemaName);
  }

  @Get('vehicles')
  vehicles(
    @Req() request: RequestWithAuth,
    @Query('search') search?: string,
    @Query('limit') limit?: string,
  ) {
    return this.telemetry.vehicles(request.auth!.schemaName, { search, limit: toInt(limit, 200) });
  }

  @Get('vehicles/:plate')
  vehicle(@Req() request: RequestWithAuth, @Param('plate') plate: string) {
    return this.telemetry.vehicle(request.auth!.schemaName, plate);
  }

  @Get('vehicles/:plate/timeline')
  vehicleTimeline(@Req() request: RequestWithAuth, @Param('plate') plate: string, @Query('limit') limit?: string) {
    return this.telemetry.vehicleTimeline(request.auth!.schemaName, plate, toInt(limit, 50));
  }

  @Get('vehicles/:plate/positions')
  vehiclePositions(@Req() request: RequestWithAuth, @Param('plate') plate: string, @Query('hours') hours?: string) {
    return this.telemetry.vehiclePositions(request.auth!.schemaName, plate, toInt(hours, 24));
  }

  @Get('alerts')
  alerts(
    @Req() request: RequestWithAuth,
    @Query('period') period?: string,
    @Query('severity') severity?: string,
    @Query('search') search?: string,
    @Query('limit') limit?: string,
  ) {
    return this.telemetry.alerts(request.auth!.schemaName, {
      period,
      severity,
      search,
      limit: toInt(limit, 200, 5000),
    });
  }

  @Get('reports/summary')
  reportsSummary(@Req() request: RequestWithAuth) {
    return this.telemetry.reportsSummary(request.auth!.schemaName);
  }

  @Get('integration')
  integration(@Req() request: RequestWithAuth) {
    return this.telemetry.integration(request.auth!.schemaName);
  }
}

function toInt(value: string | undefined, fallback: number, max = 1000) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.min(parsed, max) : fallback;
}

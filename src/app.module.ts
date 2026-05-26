import { Module } from '@nestjs/common';
import { HealthController } from './health.controller';
import { DatabaseService } from './database.service';
import { TelemetryController } from './telemetry.controller';
import { TelemetryService } from './telemetry.service';

@Module({
  controllers: [HealthController, TelemetryController],
  providers: [DatabaseService, TelemetryService],
})
export class AppModule {}

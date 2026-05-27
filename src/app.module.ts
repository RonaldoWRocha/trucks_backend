import { Module } from '@nestjs/common';
import { HealthController } from './health.controller';
import { DatabaseService } from './database.service';
import { TelemetryController } from './telemetry.controller';
import { TelemetryService } from './telemetry.service';
import { AuthController } from './auth.controller';
import { AuthGuard } from './auth.guard';
import { AuthService } from './auth.service';
import { CredentialsController } from './credentials.controller';
import { CredentialsService } from './credentials.service';
import { ClientsController } from './clients.controller';
import { ClientsService } from './clients.service';
import { UsersController } from './users.controller';
import { UsersService } from './users.service';

@Module({
  controllers: [HealthController, TelemetryController, AuthController, CredentialsController, ClientsController, UsersController],
  providers: [DatabaseService, TelemetryService, AuthService, AuthGuard, CredentialsService, ClientsService, UsersService],
})
export class AppModule {}

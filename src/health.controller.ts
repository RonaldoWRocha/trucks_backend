import { Controller, Get } from '@nestjs/common';
import { DatabaseService } from './database.service';

@Controller('health')
export class HealthController {
  constructor(private readonly db: DatabaseService) {}

  @Get()
  async health() {
    const result = await this.db.query<{ ok: number }>('select 1 as ok');
    return {
      ok: result.rows[0]?.ok === 1,
      database: 'connected',
      service: 'telemetria-api',
    };
  }
}

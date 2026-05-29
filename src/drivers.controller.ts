import { Body, Controller, Delete, Get, Param, Patch, Post, Req, UseGuards } from '@nestjs/common';
import { AuthGuard } from './auth.guard';
import { RequestWithAuth } from './auth.types';
import { DriversService } from './drivers.service';

@Controller('api/drivers')
@UseGuards(AuthGuard)
export class DriversController {
  constructor(private readonly drivers: DriversService) {}

  @Get()
  list(@Req() request: RequestWithAuth) {
    return this.drivers.list(request.auth!);
  }

  @Post()
  create(@Req() request: RequestWithAuth, @Body() body: Record<string, unknown>) {
    return this.drivers.create(request.auth!, body);
  }

  @Patch(':id')
  update(@Req() request: RequestWithAuth, @Param('id') id: string, @Body() body: Record<string, unknown>) {
    return this.drivers.update(request.auth!, Number(id), body);
  }

  @Delete(':id')
  remove(@Req() request: RequestWithAuth, @Param('id') id: string) {
    return this.drivers.remove(request.auth!, Number(id));
  }

  @Post('import')
  import(@Req() request: RequestWithAuth, @Body() body: Record<string, unknown>) {
    return this.drivers.import(request.auth!, Array.isArray(body.rows) ? body.rows : []);
  }
}

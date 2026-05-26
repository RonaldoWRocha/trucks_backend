import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { loadEnvironment } from './support/env';

async function bootstrap() {
  loadEnvironment();

  const app = await NestFactory.create(AppModule);
  const origin =
    process.env.CORS_ORIGIN || 'http://127.0.0.1:3000,http://localhost:3000';

  app.enableCors({
    origin: origin.split(',').map((item) => item.trim()),
    credentials: true,
  });

  const port = Number(process.env.PORT || 3333);
  // Escutar em 0.0.0.0 permite conexões externas (ex.: quando rodando em Docker/EasyPanel)
  await app.listen(port, '0.0.0.0');
  console.log(`Telemetria API em http://0.0.0.0:${port}`);
}

bootstrap();

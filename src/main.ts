import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { loadEnvironment } from './support/env';

async function bootstrap() {
  loadEnvironment();

  const app = await NestFactory.create(AppModule);
  const originEnv = process.env.CORS_ORIGIN || 'http://127.0.0.1:3000,http://localhost:3000';

  // Allow flexible CORS configuration:
  // - If CORS_ORIGIN='*' we enable a permissive origin handler (useful for debug).
  // - Otherwise split a comma-separated list of allowed origins.
  const allowedOrigins = originEnv === '*' ? [] : originEnv.split(',').map((item) => item.trim());

  console.log('CORS origin configured:', originEnv);

  app.enableCors({
    origin: (requestOrigin: string | undefined, callback: (err: Error | null, allow?: boolean) => void) => {
      if (!requestOrigin) {
        return callback(null, true);
      }
      if (originEnv === '*') {
        return callback(null, true);
      }
      if (allowedOrigins.includes(requestOrigin)) {
        return callback(null, true);
      }
      console.warn('CORS request rejected:', requestOrigin);
      return callback(new Error('Not allowed by CORS'));
    },
    credentials: true,
    methods: 'GET,HEAD,PUT,PATCH,POST,DELETE,OPTIONS',
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With', 'Accept'],
  });

  const port = Number(process.env.PORT || 3333);
  // Escutar em 0.0.0.0 permite conexões externas (ex.: quando rodando em Docker/EasyPanel)
  await app.listen(port, '0.0.0.0');
  console.log(`Telemetria API em http://0.0.0.0:${port}`);
}

bootstrap();

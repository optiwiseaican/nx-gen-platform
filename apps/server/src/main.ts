import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule);
  app.setGlobalPrefix('api');
  app.useBodyParser('json', { limit: '256kb' });

  // Dev: the Next.js dev server runs on another origin. In packaged builds the
  // UI is served from the same origin (or loaded by Electron), so no CORS.
  if (process.env.NODE_ENV !== 'production') {
    app.enableCors({
      credentials: true,
      origin: [/^http:\/\/localhost:\d+$/, /^http:\/\/127\.0\.0\.1:\d+$/],
    });
  }

  // Local-only by default: the standalone workstation API must not be exposed on the network.
  await app.listen(
    Number(process.env.PORT ?? 4000),
    process.env.HOST ?? '127.0.0.1',
  );
}
void bootstrap();

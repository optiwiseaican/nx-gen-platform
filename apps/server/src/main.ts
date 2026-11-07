import { NestFactory } from '@nestjs/core';
import { raw } from 'express';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module';
import { ModuleManagerService } from './modules/module-manager.service';
import { AUDIT_EXPORT_HASH_HEADER } from './audit/audit.service';
import {
  SERVER_TIME_HEADER,
  SESSION_IDLE_HEADER,
  SESSION_MAX_HEADER,
} from './auth/auth.types';

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule);
  app.setGlobalPrefix('api');
  app.useBodyParser('json', { limit: '256kb' });
  // Signed module packages are uploaded as raw bytes (verified before anything is written).
  app.use(
    '/api/modules/install/upload',
    raw({ type: 'application/octet-stream', limit: '60mb' }),
  );

  // Module screens: /modules/<id>/… served from the verified copies of the module's UI files.
  const modules = app.get(ModuleManagerService);
  app.use(
    '/modules',
    (
      req: import('express').Request,
      res: import('express').Response,
      next: () => void,
    ) => {
      if (req.method !== 'GET' && req.method !== 'HEAD') return next();
      const [, id, ...rest] = req.path.split('/');
      if (!id) return next();
      if (!rest.length && !req.originalUrl.split('?')[0].endsWith('/'))
        return res.redirect(301, `/modules/${id}/`);
      const file = modules.uiFile(id, rest.join('/'));
      if (!file)
        return res
          .status(404)
          .type('text/plain')
          .send(
            'Module page not found. The module may be disabled or not installed.',
          );
      res.setHeader('Content-Type', file.type);
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Cache-Control', 'no-cache');
      return res.send(file.data);
    },
  );

  // Dev: the Next.js dev server runs on another origin. In packaged builds the
  // UI is served from the same origin (or loaded by Electron), so no CORS.
  if (process.env.NODE_ENV !== 'production') {
    app.enableCors({
      credentials: true,
      origin: [/^http:\/\/localhost:\d+$/, /^http:\/\/127\.0\.0\.1:\d+$/],
      exposedHeaders: [
        SESSION_IDLE_HEADER,
        SESSION_MAX_HEADER,
        SERVER_TIME_HEADER,
        AUDIT_EXPORT_HASH_HEADER,
        'Content-Disposition',
      ],
    });
  }

  // Local-only by default: the standalone workstation API must not be exposed on the network.
  await app.listen(
    Number(process.env.PORT ?? 4000),
    process.env.HOST ?? '127.0.0.1',
  );
}
void bootstrap();

import 'reflect-metadata';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { NextFunction, Request, Response } from 'express';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module.js';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule);
  const clientDirectory = join(fileURLToPath(new URL('.', import.meta.url)), 'client');
  app.useStaticAssets(clientDirectory);
  app.use((request: Request, response: Response, next: NextFunction) => {
    if (request.method !== 'GET' || request.path === '/api' || request.path.startsWith('/api/')
      || extname(request.path)) {
      next();
      return;
    }
    response.sendFile(join(clientDirectory, 'index.html'), (error) => {
      if (error) next(error);
    });
  });
  app.setGlobalPrefix('api');
  const port = Number(process.env['PORT'] ?? 3000);
  const host = process.env['QUERYDOCK_SERVER_HOST']
    ?? (process.env['NODE_ENV'] === 'production' ? '0.0.0.0' : '127.0.0.1');
  await app.listen(port, host);
}

void bootstrap();

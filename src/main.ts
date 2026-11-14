import 'reflect-metadata';
import { Logger, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import helmet from 'helmet';
import { AppModule } from './app.module';
import { config } from './config';
import { accessLog } from './logging/access-log.middleware';
import { JsonNestLogger } from './logging/logger';

// BigInt ids (stock movements, loyalty history) are sent to clients as strings.
(BigInt.prototype as any).toJSON = function () {
  return this.toString();
};

async function bootstrap() {
  // JSON logs (stdout + logs/pos-api.log) in the format the ML detector reads.
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { logger: new JsonNestLogger() });
  // Behind Cloudflare + nginx: take the customer's real IP from X-Forwarded-For (rate limits, audit log).
  // TRUST_PROXY = number of proxies in front of the API (2 = Cloudflare Tunnel + nginx).
  if (process.env.TRUST_PROXY) app.set('trust proxy', /^\d+$/.test(process.env.TRUST_PROXY) ? Number(process.env.TRUST_PROXY) : process.env.TRUST_PROXY);
  // 2 MB: a pasted BROWN menu (Stores > Sync BROWN menu) or a big products/bulk import is larger than the 100 KB default.
  app.useBodyParser('json', { limit: '2mb' });
  app.setGlobalPrefix('api/v1', { exclude: ['health'] });
  app.use(accessLog); // one event=http_request line per request, X-Request-Id
  app.use(helmet());
  app.enableCors({ origin: config.corsOrigins.includes('*') ? true : config.corsOrigins });
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
  app.enableShutdownHooks();

  const doc = new DocumentBuilder()
    .setTitle('POS System API')
    .setDescription(
      'Multi-store Point of Sale API.\n\n' +
        '**Staff apps** log in with `POST /api/v1/auth/login` and send `Authorization: Bearer <token>`.\n\n' +
        '**Other systems** use an API key (created by a super admin) in the `X-API-Key` header. ' +
        'Each key has scopes such as `products:read` or `sales:write`, and can be limited to one store.\n\n' +
        'Money values are returned as strings (e.g. `"12.50"`) to avoid rounding errors.',
    )
    .setVersion('1.0')
    .addBearerAuth()
    .addApiKey({ type: 'apiKey', name: 'X-API-Key', in: 'header' }, 'api-key')
    .build();
  SwaggerModule.setup('docs', app, SwaggerModule.createDocument(app, doc), {
    swaggerOptions: { persistAuthorization: true },
  });

  await app.listen(config.port);
  Logger.log(`API running on http://localhost:${config.port}/api/v1  |  Docs: http://localhost:${config.port}/docs`, 'Bootstrap');
}

bootstrap();

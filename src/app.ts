import Fastify from 'fastify';
import fjwt from '@fastify/jwt';
import fstatic from '@fastify/static';
import fs from 'node:fs';
import { config } from './config.ts';
import { AppError } from './util.ts';
import { authRoutes } from './routes/auth.ts';
import { dataRoutes } from './routes/data.ts';
import { financeRoutes } from './routes/finance.ts';

export async function buildApp(opts: { logger?: boolean; serveWeb?: boolean } = {}) {
  const app = Fastify({ logger: opts.logger ?? false, bodyLimit: 2 * 1024 * 1024 });
  await app.register(fjwt, { secret: config.jwtSecret });

  // Frontend alohida domenda bo'lsa — faqat ruxsat berilgan manzillarga CORS
  if (config.corsOrigins.length) {
    app.addHook('onRequest', async (req, reply) => {
      const origin = req.headers.origin;
      if (origin && config.corsOrigins.includes(origin)) {
        reply.header('Access-Control-Allow-Origin', origin);
        reply.header('Vary', 'Origin');
        reply.header('Access-Control-Allow-Headers', 'Authorization, Content-Type');
        reply.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
        reply.header('Access-Control-Max-Age', '86400');
      }
      if (req.method === 'OPTIONS') return reply.code(204).send();
    });
  }

  app.setErrorHandler((err: any, req, reply) => {
    if (err instanceof AppError) return reply.code(err.status).send({ error: err.message, code: err.code });
    if (err.validation || err.statusCode === 400) return reply.code(400).send({ error: 'So‘rov noto‘g‘ri' });
    if (err.statusCode === 413) return reply.code(413).send({ error: 'Ma’lumot hajmi juda katta' });
    req.log.error(err);
    // Ichki xato tafsilotlari foydalanuvchiga ko'rsatilmaydi
    return reply.code(500).send({ error: 'Serverda kutilmagan xato yuz berdi' });
  });

  await app.register(authRoutes);
  await app.register(dataRoutes);
  await app.register(financeRoutes);
  app.get('/api/health', async () => ({ ok: true }));

  if (opts.serveWeb && fs.existsSync(config.webDist)) {
    await app.register(fstatic, {
      root: config.webDist,
      setHeaders(res, filePath) {
        if (/[\\/]assets[\\/]/.test(filePath)) res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
        else res.setHeader('Cache-Control', 'no-cache');
      },
    });
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith('/api/')) return reply.code(404).send({ error: 'Topilmadi' });
      return reply.sendFile('index.html');
    });
  }
  return app;
}

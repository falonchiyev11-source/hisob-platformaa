import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { config } from '../src/config.ts';
import { initPool, closePool } from '../src/db.ts';
import { migrate } from '../src/migrate.ts';
import { startLocalDb } from '../src/local-db.ts';
import { buildApp } from '../src/app.ts';

export const uuid = () => randomUUID();

/** Alohida "savdo_test" bazasini noldan yaratadi — ishchi ma'lumotlarga tegmaydi. */
export async function setupTestApp() {
  let url: string;
  if (process.env.TEST_DATABASE_URL) {
    url = process.env.TEST_DATABASE_URL;
  } else {
    const base = await startLocalDb({ dataDir: config.dataDir, port: config.localDbPort, password: config.localDbPassword, database: 'postgres' });
    const c = new pg.Client({ connectionString: base });
    await c.connect();
    await c.query('DROP DATABASE IF EXISTS savdo_test WITH (FORCE)');
    await c.query('CREATE DATABASE savdo_test');
    await c.end();
    url = base.replace(/\/postgres$/, '/savdo_test');
  }
  initPool(url);
  await migrate(() => {});
  const app = await buildApp();

  async function call(method: string, path: string, token?: string, body?: unknown) {
    const res = await app.inject({ method: method as any, url: path, headers: token ? { authorization: `Bearer ${token}` } : {}, payload: body as any });
    const json = res.body ? JSON.parse(res.body) : null;
    return { status: res.statusCode, body: json };
  }

  const setup = await call('POST', '/api/setup', undefined, { username: 'admin', fullName: 'Admin', password: 'admin123' });
  const adminToken: string = setup.body.token;
  await call('POST', '/api/users', adminToken, { username: 'sotuvchi', fullName: 'Sotuvchi', password: 'sotuv123', role: 'seller' });
  const sellerToken: string = (await call('POST', '/api/auth/login', undefined, { username: 'sotuvchi', password: 'sotuv123' })).body.token;

  /** Bitta amalni /api/ops orqali yuboradi (brauzer ham aynan shunday qiladi). */
  async function op(token: string, type: string, payload: any, opId = uuid()) {
    const r = await call('POST', '/api/ops', token, { id: opId, type, payload });
    return r.body as { status: string; result?: any; error?: string };
  }

  return {
    app, call, op, adminToken, sellerToken,
    async close() { await app.close(); await closePool(); },
  };
}

import { assertConfig, config } from './config.ts';
import { closePool, initPool } from './db.ts';
import { migrate } from './migrate.ts';
import { startLocalDb, stopLocalDb } from './local-db.ts';
import { buildApp } from './app.ts';

async function main() {
  assertConfig();
  let url = config.databaseUrl;
  if (config.localDb) {
    console.log('Mahalliy PostgreSQL ishga tushirilmoqda...');
    url = await startLocalDb({ dataDir: config.dataDir, port: config.localDbPort, password: config.localDbPassword, database: 'savdo' });
  }
  initPool(url);
  await migrate();
  const app = await buildApp({ logger: process.env.NODE_ENV !== 'test', serveWeb: true });
  await app.listen({ port: config.port, host: config.host });
  console.log(`\nPlatforma ishga tushdi: http://localhost:${config.port}\n`);

  const shutdown = async () => {
    await app.close();
    await closePool();
    if (config.localDb) stopLocalDb(config.dataDir);
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((e) => {
  console.error('Ishga tushirishda xato:', e.message ?? e);
  process.exit(1);
});

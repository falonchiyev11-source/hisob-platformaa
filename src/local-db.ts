/**
 * Local PostgreSQL for a single-computer setup (LOCAL_DB=true).
 * Uses the PostgreSQL binaries from the @embedded-postgres package, started through pg_ctl
 * (pg_ctl drops administrator rights on Windows, which plain postgres.exe refuses to run with).
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';
import pg from 'pg';

const exe = process.platform === 'win32' ? '.exe' : '';

function binDir(): string {
  const req = createRequire(import.meta.url);
  const pkg = `@embedded-postgres/${process.platform === 'win32' ? 'windows' : process.platform}-${process.arch}`;
  const entry = req.resolve(pkg); // .../dist/index.js
  return path.join(path.dirname(entry), '..', 'native', 'bin');
}

function run(cmd: string, args: string[], detached = false) {
  // pg_ctl start: postgres jarayoni chiqish kanallarini meros qilib oladi, shuning uchun ularni ochmaymiz (log faylga yoziladi).
  const r = spawnSync(path.join(binDir(), cmd + exe), args, { encoding: 'utf8', stdio: detached ? 'ignore' : ['ignore', 'pipe', 'pipe'], windowsHide: true });
  if (r.status !== 0) throw new Error(`${cmd} xatosi: ${r.stderr || r.stdout || r.error || 'kod ' + r.status}`);
  return r.stdout;
}

export interface LocalDbOptions { dataDir: string; port: number; password: string; database: string }

export async function startLocalDb(o: LocalDbOptions): Promise<string> {
  if (!o.password) throw new Error('LOCAL_DB_PASSWORD .env faylida ko‘rsatilmagan');
  const pgData = path.join(o.dataDir, 'pg');
  if (!fs.existsSync(path.join(pgData, 'PG_VERSION'))) {
    fs.mkdirSync(pgData, { recursive: true });
    const pwFile = path.join(os.tmpdir(), `pgpw-${process.pid}`);
    fs.writeFileSync(pwFile, o.password);
    try {
      run('initdb', ['-D', pgData, '-U', 'postgres', `--pwfile=${pwFile}`, '--auth=scram-sha-256', '--encoding=UTF8', '--locale=C']);
    } finally {
      fs.rmSync(pwFile, { force: true });
    }
  }
  const url = (db: string) => `postgres://postgres:${encodeURIComponent(o.password)}@127.0.0.1:${o.port}/${db}`;
  if (!(await canConnect(url('postgres')))) {
    run('pg_ctl', ['start', '-D', pgData, '-o', `-p ${o.port} -c listen_addresses=127.0.0.1`, '-l', path.join(o.dataDir, 'postgres.log'), '-w', '-t', '60'], true);
  }
  const c = new pg.Client({ connectionString: url('postgres') });
  await c.connect();
  const exists = await c.query('select 1 from pg_database where datname=$1', [o.database]);
  if (!exists.rowCount) await c.query(`create database "${o.database}"`);
  await c.end();
  return url(o.database);
}

export function stopLocalDb(dataDir: string) {
  try { run('pg_ctl', ['stop', '-D', path.join(dataDir, 'pg'), '-m', 'fast', '-w']); } catch { /* already stopped */ }
}

async function canConnect(url: string) {
  const c = new pg.Client({ connectionString: url, connectionTimeoutMillis: 1500 });
  try { await c.connect(); await c.end(); return true; } catch { return false; }
}

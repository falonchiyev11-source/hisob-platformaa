import pg from 'pg';

// DATE ustunlari "YYYY-MM-DD" matn bo'lib qaytsin (vaqt mintaqasi siljishi bo'lmasin).
pg.types.setTypeParser(1082, (v) => v);

export type Client = pg.PoolClient;
let pool: pg.Pool | null = null;

export function initPool(connectionString: string) {
  pool = new pg.Pool({ connectionString, max: 10 });
  return pool;
}

export function getPool(): pg.Pool {
  if (!pool) throw new Error('DB pool not initialised');
  return pool;
}

export async function q<T extends pg.QueryResultRow = any>(text: string, params: unknown[] = []) {
  return getPool().query<T>(text, params);
}

/** Runs fn inside a single transaction. Everything succeeds together or nothing is written. */
export async function tx<T>(fn: (c: Client) => Promise<T>): Promise<T> {
  const c = await getPool().connect();
  try {
    await c.query('BEGIN');
    const r = await fn(c);
    await c.query('COMMIT');
    return r;
  } catch (e) {
    await c.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    c.release();
  }
}

export async function closePool() {
  if (pool) await pool.end();
  pool = null;
}

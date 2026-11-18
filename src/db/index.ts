import { drizzle, NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import * as schema from './schema.ts';

export type PersistenceMode = 'json' | 'postgres';

declare global {
  // eslint-disable-next-line no-var
  var _movilogPostgresPool: Pool | undefined;
}

export function getPersistenceMode(): PersistenceMode {
  const raw = (process.env.PERSISTENCE_MODE || 'json').trim().toLowerCase();
  return raw === 'postgres' ? 'postgres' : 'json';
}

export function isPostgresConfigured(): boolean {
  return Boolean(
    process.env.SQL_HOST &&
      process.env.SQL_USER &&
      process.env.SQL_PASSWORD &&
      process.env.SQL_DB_NAME
  );
}

/**
 * Lazy pg.Pool factory using the Object Method (compatible with Cloud SQL Auth Proxy
 * Unix domain sockets e.g. /cloudsql/PROJECT:REGION:INSTANCE as well as TCP hosts).
 * Never runs eager startup probes or reconnect loops.
 */
export const createPool = (): Pool => {
  if (!global._movilogPostgresPool) {
    const sqlHost = process.env.SQL_HOST;
    const sqlUser = process.env.SQL_USER;
    const sqlPassword = process.env.SQL_PASSWORD;
    const sqlDbName = process.env.SQL_DB_NAME;

    if (!sqlHost || !sqlUser || !sqlPassword || !sqlDbName) {
      throw new Error(
        'Configuração PostgreSQL incompleta: SQL_HOST, SQL_USER, SQL_PASSWORD e SQL_DB_NAME são obrigatórios.'
      );
    }

    const isUnixSocket = sqlHost.startsWith('/');
    global._movilogPostgresPool = new Pool({
      host: sqlHost,
      port: isUnixSocket ? undefined : Number(process.env.SQL_PORT || 5432),
      user: sqlUser,
      password: sqlPassword,
      database: sqlDbName,
      max: Number(process.env.SQL_POOL_MAX || 10),
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 15000,
    });

    global._movilogPostgresPool.on('error', (err) => {
      console.error('[PostgreSQL Pool] Unexpected idle client error:', err.message);
    });
  }

  return global._movilogPostgresPool;
};

let _pgDbInstance: NodePgDatabase<typeof schema> | undefined;

export const getPgDb = (): NodePgDatabase<typeof schema> => {
  if (!_pgDbInstance) {
    _pgDbInstance = drizzle(createPool(), { schema });
  }
  return _pgDbInstance;
};

/**
 * Allows injecting an isolated/test Drizzle instance (e.g., for local verification suites
 * without touching Cloud SQL or production resources).
 */
export const setPgDbForTesting = (
  testDb: NodePgDatabase<typeof schema> | undefined
): void => {
  _pgDbInstance = testDb;
};

export { schema };

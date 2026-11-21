import { drizzle, NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import * as schema from './schema.ts';
import { createMockDb } from './mock.ts';

declare global {
  var _postgresPool: Pool | undefined;
}

const hasDatabaseConfig = Boolean(
  process.env.DATABASE_URL ||
    (process.env.SQL_HOST && process.env.SQL_DB_NAME && process.env.SQL_USER)
);

const useSslForConnectionString = Boolean(
  process.env.DATABASE_URL &&
    (process.env.DATABASE_SSL === 'true' ||
      process.env.DATABASE_URL.includes('supabase.co') ||
      process.env.DATABASE_URL.includes('supabase.com') ||
      process.env.DATABASE_URL.includes('sslmode=require'))
);

export const createPool = () => {
  if (!hasDatabaseConfig) return undefined;
  if (!global._postgresPool) {
    global._postgresPool = new Pool(
      process.env.DATABASE_URL
        ? {
            connectionString: process.env.DATABASE_URL,
            ssl: useSslForConnectionString ? { rejectUnauthorized: false } : undefined,
            max: 10,
            connectionTimeoutMillis: 15000,
          }
        : {
            host: process.env.SQL_HOST,
            user: process.env.SQL_USER,
            password: process.env.SQL_PASSWORD,
            database: process.env.SQL_DB_NAME,
            max: 10,
            connectionTimeoutMillis: 15000,
          }
    );

    global._postgresPool.on('error', (err) => {
      console.error('Unexpected error on idle SQL pool client:', err);
    });
  }
  return global._postgresPool;
};

let db: NodePgDatabase<typeof schema>;
let cloudDbConnected = false;
let lastDbError: string | null = null;

export function isCloudDatabaseConfigured(): boolean {
  return hasDatabaseConfig;
}

export function isCloudDbReady(): boolean {
  return hasDatabaseConfig && cloudDbConnected;
}

export function getLastDbError(): string | null {
  return lastDbError;
}

export async function verifyCloudDatabaseConnection(): Promise<boolean> {
  if (!hasDatabaseConfig) {
    cloudDbConnected = false;
    lastDbError = 'DATABASE_URL or SQL_HOST is not configured.';
    return false;
  }
  const pool = createPool();
  if (!pool) {
    cloudDbConnected = false;
    lastDbError = 'PostgreSQL connection pool could not be initialized.';
    return false;
  }
  try {
    await pool.query('SELECT 1');
    cloudDbConnected = true;
    lastDbError = null;
    return true;
  } catch (err: any) {
    cloudDbConnected = false;
    lastDbError = err?.message || 'Unable to connect to Supabase PostgreSQL.';
    return false;
  }
}

if (hasDatabaseConfig) {
  const pool = createPool();
  if (!pool) {
    throw new Error('Supabase PostgreSQL pool failed to initialize.');
  }
  db = drizzle(pool, { schema });
  cloudDbConnected = true;
} else {
  console.warn(
    '[NexusTekFusion] DATABASE_URL not configured — business write routes will return 503 until Supabase PostgreSQL is connected.'
  );
  db = createMockDb();
  cloudDbConnected = false;
  lastDbError = 'Supabase PostgreSQL database environment variables are not configured.';
}

export { db };


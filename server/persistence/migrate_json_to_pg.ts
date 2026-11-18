import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { pathToFileURL } from 'url';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { eq } from 'drizzle-orm';
import { getPgDb, schema } from '../../src/db/index.ts';
import type { DatabaseSchema, User } from '../db.ts';
import {
  ALL_COLLECTION_KEYS,
  hashSessionToken,
  readCollectionFromPg,
  upsertCollectionItemInTx,
  upsertSystemConfigInTx,
  type CollectionKey,
} from './repository.ts';

export const MASTER_OWNER_ID = '312f0489-d5ba-4a34-b493-4ffe7318cf2e';
export const MASTER_OWNER_EMAIL = 'Alifermadeiro@hotmail.com';

export interface SnapshotResult {
  snapshotDir: string;
  dbSnapshotPath: string;
  sessionsSnapshotPath: string;
  dbSha256: string;
  sessionsSha256: string;
  checksumFilePath: string;
  manifestPath: string;
  counts: Record<string, number>;
}

export interface ParityCollectionReport {
  collection: string;
  jsonCount: number;
  pgCount: number;
  match: boolean;
}

export interface ParityReport {
  passed: boolean;
  executedAt: string;
  sourceDbSha256: string;
  sourceSessionsSha256: string;
  masterOwnerPreserved: boolean;
  hashesAndSaltsIdentical: boolean;
  sessionsMigrated: number;
  activeSessionsPreserved: number;
  collections: ParityCollectionReport[];
  mismatches: string[];
}

export function sha256File(filePath: string): string {
  const buf = fs.readFileSync(filePath);
  return crypto.createHash('sha256').update(buf).digest('hex');
}

export function createImmutableSnapshot(params: {
  dbFilePath: string;
  sessionsFilePath: string;
  snapshotBaseDir?: string;
}): SnapshotResult {
  const { dbFilePath, sessionsFilePath } = params;
  if (!fs.existsSync(dbFilePath)) {
    throw new Error(`Arquivo JSON principal não encontrado: ${dbFilePath}`);
  }
  if (!fs.existsSync(sessionsFilePath)) {
    throw new Error(`Arquivo JSON de sessões não encontrado: ${sessionsFilePath}`);
  }

  const timestampSlug = new Date().toISOString().replace(/[:.]/g, '-');
  const baseDir =
    params.snapshotBaseDir || path.resolve(process.cwd(), 'data', 'snapshots');
  const snapshotDir = path.resolve(baseDir, `snapshot_${timestampSlug}`);
  fs.mkdirSync(snapshotDir, { recursive: true });

  const dbSnapshotPath = path.join(snapshotDir, 'db.snapshot.json');
  const sessionsSnapshotPath = path.join(snapshotDir, 'sessions.snapshot.json');

  fs.copyFileSync(dbFilePath, dbSnapshotPath);
  fs.copyFileSync(sessionsFilePath, sessionsSnapshotPath);

  const dbSha256 = sha256File(dbSnapshotPath);
  const sessionsSha256 = sha256File(sessionsSnapshotPath);

  const parsedDb = JSON.parse(fs.readFileSync(dbSnapshotPath, 'utf-8')) as Partial<DatabaseSchema>;
  const parsedSessions = JSON.parse(
    fs.readFileSync(sessionsSnapshotPath, 'utf-8')
  ) as Record<string, { userId: string; expiresAt: number }>;

  const counts: Record<string, number> = {
    systemConfig: parsedDb.systemConfig ? 1 : 0,
    sessions: Object.keys(parsedSessions).length,
  };
  for (const key of ALL_COLLECTION_KEYS) {
    const arr = (parsedDb as any)[key];
    counts[key] = Array.isArray(arr) ? arr.length : 0;
  }

  const checksumFilePath = path.join(snapshotDir, 'checksums.sha256');
  const checksumContent = [
    `${dbSha256}  db.snapshot.json`,
    `${sessionsSha256}  sessions.snapshot.json`,
    '',
  ].join('\n');
  fs.writeFileSync(checksumFilePath, checksumContent, 'utf-8');

  const manifestPath = path.join(snapshotDir, 'manifest.json');
  fs.writeFileSync(
    manifestPath,
    JSON.stringify(
      {
        createdAt: new Date().toISOString(),
        sourceDbPath: path.resolve(dbFilePath),
        sourceSessionsPath: path.resolve(sessionsFilePath),
        dbSha256,
        sessionsSha256,
        counts,
      },
      null,
      2
    ),
    'utf-8'
  );

  // Mark snapshot files read-only for immutability
  for (const f of [dbSnapshotPath, sessionsSnapshotPath, checksumFilePath, manifestPath]) {
    try {
      fs.chmodSync(f, 0o444);
    } catch {
      // Ignore chmod failures on restricted filesystems
    }
  }

  return {
    snapshotDir,
    dbSnapshotPath,
    sessionsSnapshotPath,
    dbSha256,
    sessionsSha256,
    checksumFilePath,
    manifestPath,
    counts,
  };
}

export async function verifyParityAgainstPg(params: {
  pg: NodePgDatabase<typeof schema>;
  sourceDb: Partial<DatabaseSchema>;
  sourceSessions: Record<string, { userId: string; expiresAt: number }>;
  sourceDbSha256: string;
  sourceSessionsSha256: string;
  referenceNowMs?: number;
}): Promise<ParityReport> {
  const { pg, sourceDb, sourceSessions, sourceDbSha256, sourceSessionsSha256 } = params;
  const nowMs = params.referenceNowMs ?? Date.now();
  const mismatches: string[] = [];
  const collections: ParityCollectionReport[] = [];

  // 1. Check systemConfig
  const pgCfgRows = await pg
    .select()
    .from(schema.systemConfig)
    .where(eq(schema.systemConfig.id, 'default'));
  const jsonCfgCount = sourceDb.systemConfig ? 1 : 0;
  const pgCfgCount = pgCfgRows.length;
  collections.push({
    collection: 'systemConfig',
    jsonCount: jsonCfgCount,
    pgCount: pgCfgCount,
    match: jsonCfgCount === pgCfgCount,
  });
  if (jsonCfgCount !== pgCfgCount) {
    mismatches.push(`systemConfig: JSON=${jsonCfgCount}, PG=${pgCfgCount}`);
  }

  // 2. Check all 41 array collections
  for (const key of ALL_COLLECTION_KEYS) {
    const jsonArr = Array.isArray((sourceDb as any)[key]) ? ((sourceDb as any)[key] as any[]) : [];
    const pgArr = await readCollectionFromPg(pg, key);
    const match = jsonArr.length === pgArr.length;
    collections.push({
      collection: key,
      jsonCount: jsonArr.length,
      pgCount: pgArr.length,
      match,
    });
    if (!match) {
      mismatches.push(`${key}: JSON=${jsonArr.length}, PG=${pgArr.length}`);
    }
  }

  // 3. Verify users' passwordHash & salt identity + MASTER_OWNER preservation
  const jsonUsers = (sourceDb.users || []) as User[];
  const pgUsers = (await readCollectionFromPg(pg, 'users')) as User[];
  const pgUserById = new Map(pgUsers.map((u) => [u.id, u]));

  let hashesAndSaltsIdentical = true;
  for (const ju of jsonUsers) {
    const pu = pgUserById.get(ju.id);
    if (!pu) {
      hashesAndSaltsIdentical = false;
      mismatches.push(`Usuário ausente no PG: ${ju.id} (${ju.email})`);
      continue;
    }
    if (
      pu.passwordHash !== ju.passwordHash ||
      pu.salt !== ju.salt ||
      pu.email !== ju.email ||
      pu.role !== ju.role ||
      (pu.companyId ?? null) !== (ju.companyId ?? null)
    ) {
      hashesAndSaltsIdentical = false;
      mismatches.push(`Divergência de credencial/perfil no usuário ${ju.id} (${ju.email})`);
    }
  }

  const jsonMaster = jsonUsers.find((u) => u.id === MASTER_OWNER_ID);
  const pgMaster = pgUserById.get(MASTER_OWNER_ID);
  const masterOwnerPreserved = Boolean(
    (!jsonMaster ||
      (pgMaster &&
        pgMaster.email.toLowerCase() === MASTER_OWNER_EMAIL.toLowerCase() &&
        pgMaster.role === 'master_owner' &&
        pgMaster.passwordHash === jsonMaster.passwordHash &&
        pgMaster.salt === jsonMaster.salt))
  );
  if (!masterOwnerPreserved) {
    mismatches.push(`MASTER_OWNER (${MASTER_OWNER_ID}) não preservado integralmente no PG.`);
  }

  // 4. Verify SHA-256 session tokens
  const pgSessions = await pg.select().from(schema.sessions);
  const pgSessionMap = new Map(pgSessions.map((s) => [s.tokenHash, s]));
  const sessionEntries = Object.entries(sourceSessions);
  let activeSessionsPreserved = 0;

  for (const [rawToken, sess] of sessionEntries) {
    const tokenHash = hashSessionToken(rawToken);
    const pgSess = pgSessionMap.get(tokenHash);
    if (!pgSess || pgSess.userId !== sess.userId || Number(pgSess.expiresAt) !== Number(sess.expiresAt)) {
      mismatches.push(`Sessão não migrada corretamente para userId=${sess.userId}`);
    } else if (sess.expiresAt > nowMs && !pgSess.revokedAt) {
      activeSessionsPreserved++;
    }
  }

  collections.push({
    collection: 'sessions',
    jsonCount: sessionEntries.length,
    pgCount: pgSessions.length,
    match: sessionEntries.length === pgSessions.length,
  });

  const passed =
    mismatches.length === 0 && masterOwnerPreserved && hashesAndSaltsIdentical;

  return {
    passed,
    executedAt: new Date().toISOString(),
    sourceDbSha256,
    sourceSessionsSha256,
    masterOwnerPreserved,
    hashesAndSaltsIdentical,
    sessionsMigrated: pgSessions.length,
    activeSessionsPreserved,
    collections,
    mismatches,
  };
}

export async function migrateJsonToPostgres(options: {
  dbFilePath: string;
  sessionsFilePath: string;
  snapshotBaseDir?: string;
  dryRun?: boolean;
  pg?: NodePgDatabase<typeof schema>;
}): Promise<{ snapshot: SnapshotResult; parity: ParityReport | null; dryRun: boolean }> {
  const snapshot = createImmutableSnapshot({
    dbFilePath: options.dbFilePath,
    sessionsFilePath: options.sessionsFilePath,
    snapshotBaseDir: options.snapshotBaseDir,
  });

  const sourceDb = JSON.parse(
    fs.readFileSync(snapshot.dbSnapshotPath, 'utf-8')
  ) as Partial<DatabaseSchema>;
  const sourceSessions = JSON.parse(
    fs.readFileSync(snapshot.sessionsSnapshotPath, 'utf-8')
  ) as Record<string, { userId: string; expiresAt: number }>;

  // Pre-flight check for MASTER_OWNER integrity before any DB write
  const usersArr = (sourceDb.users || []) as User[];
  const master = usersArr.find((u) => u.id === MASTER_OWNER_ID);
  if (master && master.role !== 'master_owner') {
    throw new Error(`Conta MASTER_OWNER ${MASTER_OWNER_ID} com role inválida: ${master.role}`);
  }

  if (options.dryRun) {
    return { snapshot, parity: null, dryRun: true };
  }

  const pg = options.pg || getPgDb();

  // Ordered migration inside a single ACID PostgreSQL transaction
  const orderedKeys: CollectionKey[] = [
    'plans',
    'companies',
    'users',
    ...ALL_COLLECTION_KEYS.filter((k) => k !== 'plans' && k !== 'companies' && k !== 'users'),
  ];

  await pg.transaction(async (tx) => {
    if (sourceDb.systemConfig) {
      await upsertSystemConfigInTx(tx, sourceDb.systemConfig);
    }

    for (const key of orderedKeys) {
      const arr = Array.isArray((sourceDb as any)[key]) ? ((sourceDb as any)[key] as any[]) : [];
      for (const item of arr) {
        if (!item || !item.id) continue;
        await upsertCollectionItemInTx(tx, key, item);
      }
    }

    for (const [rawToken, sess] of Object.entries(sourceSessions)) {
      if (!rawToken || !sess?.userId) continue;
      const tokenHash = hashSessionToken(rawToken);
      await tx
        .insert(schema.sessions)
        .values({
          tokenHash,
          userId: sess.userId,
          expiresAt: Number(sess.expiresAt),
          revokedAt: null,
        })
        .onConflictDoUpdate({
          target: schema.sessions.tokenHash,
          set: {
            userId: sess.userId,
            expiresAt: Number(sess.expiresAt),
          },
        });
    }
  });

  const parity = await verifyParityAgainstPg({
    pg,
    sourceDb,
    sourceSessions,
    sourceDbSha256: snapshot.dbSha256,
    sourceSessionsSha256: snapshot.sessionsSha256,
  });

  await pg.insert(schema.migrationCheckpoints).values({
    id: crypto.randomUUID(),
    sourceDbSha256: snapshot.dbSha256,
    sourceSessionsSha256: snapshot.sessionsSha256,
    parityVerified: parity.passed,
    summary: parity as any,
  });

  return { snapshot, parity, dryRun: false };
}

// CLI entry point (only executed when invoked directly)
const isDirectCli =
  typeof process !== 'undefined' &&
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (isDirectCli) {
  const args = process.argv.slice(2);
  const getArg = (flag: string, fallback: string) => {
    const idx = args.indexOf(flag);
    return idx >= 0 && args[idx + 1] ? args[idx + 1] : fallback;
  };
  const dbFilePath = getArg('--db-file', path.resolve(process.cwd(), 'data', 'db.json'));
  const sessionsFilePath = getArg(
    '--sessions-file',
    path.resolve(process.cwd(), 'data', 'sessions.json')
  );
  const dryRun = args.includes('--dry-run');

  migrateJsonToPostgres({ dbFilePath, sessionsFilePath, dryRun })
    .then((res) => {
      console.log(JSON.stringify(res, null, 2));
      process.exit(res.parity && !res.parity.passed ? 1 : 0);
    })
    .catch((err) => {
      console.error('Migration failed:', err);
      process.exit(1);
    });
}

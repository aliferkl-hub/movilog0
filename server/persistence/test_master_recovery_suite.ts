import assert from 'assert';
import { execFileSync } from 'child_process';
import crypto from 'crypto';
import express from 'express';
import fs from 'fs';
import http from 'http';
import os from 'os';
import path from 'path';
import { drizzle } from 'drizzle-orm/node-postgres';
import * as schema from '../../src/db/schema.ts';

const MASTER_ID = '312f0489-d5ba-4a34-b493-4ffe7318cf2e';
const MASTER_EMAIL = 'Alifermadeiro@hotmail.com';
const SECONDARY_MASTER_EMAIL = 'alifergael76@gmail.com';
const TEST_RECOVERY_KEY = 'TestAdminRecoveryKey#MoviLog2026!';
const NEW_STRONG_PASS = 'NovaSenha#Master2026!';

function sha256File(filePath: string): string {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

class IsolatedPgRecoveryHarness {
  public tables = new Map<string, Map<string, any>>();
  public txLog: string[] = [];
  private snapshotBeforeTx: Map<string, Map<string, any>> | null = null;

  constructor() {
    for (const t of ['system_config', 'plans', 'companies', 'users', 'sessions', 'audit_logs']) {
      this.tables.set(t, new Map());
    }
  }

  private cloneTables(): Map<string, Map<string, any>> {
    const out = new Map<string, Map<string, any>>();
    for (const [k, m] of this.tables.entries()) {
      out.set(k, new Map(Array.from(m.entries()).map(([rk, rv]) => [rk, structuredClone(rv)])));
    }
    return out;
  }

  private getTable(name: string): Map<string, any> {
    if (!this.tables.has(name)) this.tables.set(name, new Map());
    return this.tables.get(name)!;
  }

  private parsePkColumn(tableName: string): string {
    return tableName === 'sessions' ? 'token_hash' : 'id';
  }

  private getSchemaColumns(tableName: string): { pgName: string; jsName: string }[] {
    for (const val of Object.values(schema)) {
      if (val && typeof val === 'object') {
        const sym = Object.getOwnPropertySymbols(val).find((s) =>
          s.toString().includes('drizzle:Name')
        );
        if (sym && (val as any)[sym] === tableName) {
          const cols: { pgName: string; jsName: string }[] = [];
          for (const [jsName, col] of Object.entries(val as Record<string, any>)) {
            if (col && typeof col === 'object' && col.name) {
              cols.push({ pgName: col.name, jsName });
            }
          }
          return cols;
        }
      }
    }
    return [];
  }

  public createMockPool(): any {
    const self = this;
    const exec = async (textOrConfig: any, values?: any[]) => {
      const sqlText = (typeof textOrConfig === 'string' ? textOrConfig : textOrConfig.text).trim();
      const params =
        values ?? (typeof textOrConfig === 'object' && textOrConfig.values ? textOrConfig.values : []);
      const rowMode = typeof textOrConfig === 'object' ? textOrConfig.rowMode : undefined;
      const upper = sqlText.toUpperCase();

      if (upper === 'BEGIN' || upper.startsWith('BEGIN ')) {
        self.snapshotBeforeTx = self.cloneTables();
        self.txLog.push('BEGIN');
        return { rows: [], rowCount: 0 };
      }
      if (upper === 'COMMIT') {
        self.snapshotBeforeTx = null;
        self.txLog.push('COMMIT');
        return { rows: [], rowCount: 0 };
      }
      if (upper === 'ROLLBACK') {
        if (self.snapshotBeforeTx) self.tables = self.snapshotBeforeTx;
        self.snapshotBeforeTx = null;
        self.txLog.push('ROLLBACK');
        return { rows: [], rowCount: 0 };
      }

      if (upper.startsWith('INSERT INTO ')) {
        const m = sqlText.match(
          /^insert into "([^"]+)"\s*\(([^)]+)\)\s*values\s*(.+?)(?:\s+on conflict|\s+returning|$)/i
        );
        if (!m) throw new Error(`Unsupported INSERT SQL: ${sqlText}`);
        const tableName = m[1];
        const colNames = m[2].split(',').map((c: string) => c.trim().replace(/"/g, ''));
        const table = self.getTable(tableName);
        const pkCol = self.parsePkColumn(tableName);
        const colDefs = self.getSchemaColumns(tableName);
        const row: Record<string, any> = {};
        for (let i = 0; i < colNames.length; i++) {
          const col = colNames[i];
          let val = params[i];
          if (typeof val === 'string' && (val.startsWith('{') || val.startsWith('['))) {
            const def = colDefs.find((d) => d.pgName === col);
            if (def && ['modulos', 'modulos_permitidos', 'limites', 'recursos'].includes(col)) {
              try {
                val = JSON.parse(val);
              } catch {
                // ignore
              }
            }
          }
          row[col] = val === undefined ? null : val;
        }
        table.set(String(row[pkCol]), row);
        return { rows: [], rowCount: 1 };
      }

      if (upper.startsWith('SELECT ')) {
        const fromMatch = sqlText.match(/\bfrom "([^"]+)"/i);
        if (!fromMatch) throw new Error(`Unsupported SELECT SQL: ${sqlText}`);
        const baseTableName = fromMatch[1];
        const selectPart = sqlText.slice(7, sqlText.toLowerCase().indexOf(' from '));
        const selectedCols = selectPart
          .split(',')
          .map((s: string) => s.trim().replace(/^"[^"]+"\./, '').replace(/"/g, ''));

        const joinMatch = sqlText.match(
          /\binner join "([^"]+)" on "[^"]+"\."([^"]+)" = "[^"]+"\."([^"]+)"/i
        );
        if (joinMatch && baseTableName === 'sessions' && joinMatch[1] === 'users') {
          const sess = self.getTable('sessions').get(params[0]);
          if (!sess || sess.revoked_at !== null) return { rows: [], rowCount: 0 };
          const user = self.getTable('users').get(sess.user_id);
          if (!user) return { rows: [], rowCount: 0 };
          const sessCols = self.getSchemaColumns('sessions').map((c) => sess[c.pgName]);
          const userCols = self.getSchemaColumns('users').map((c) => user[c.pgName]);
          const combined = [...sessCols, ...userCols];
          return { rows: rowMode === 'array' ? [combined] : [{ ...sess, ...user }], rowCount: 1 };
        }

        const baseRows = Array.from(self.getTable(baseTableName).values());
        let filtered = baseRows;
        if (sqlText.toLowerCase().includes(' where ')) {
          const whereClause = sqlText
            .slice(sqlText.toLowerCase().indexOf(' where ') + 7)
            .toLowerCase();
          if (whereClause.includes('"id" = $1')) {
            filtered = filtered.filter((r) => r.id === params[0]);
          } else if (whereClause.includes('lower("users"."email") = $1')) {
            filtered = filtered.filter(
              (r) => String(r.email).toLowerCase() === String(params[0]).toLowerCase()
            );
          } else if (whereClause.includes('"token_hash" = $1')) {
            filtered = filtered.filter((r) => r.token_hash === params[0]);
          }
        }

        const outRows = filtered.map((r) => {
          if (rowMode === 'array') {
            return selectedCols.map((c: string) => (r[c] !== undefined ? r[c] : null));
          }
          const obj: Record<string, any> = {};
          selectedCols.forEach((c: string) => {
            obj[c] = r[c];
          });
          return obj;
        });
        return { rows: outRows, rowCount: outRows.length };
      }

      if (upper.startsWith('UPDATE ')) {
        const m = sqlText.match(/^update "([^"]+)" set (.+?) where (.+)$/i);
        if (!m) throw new Error(`Unsupported UPDATE SQL: ${sqlText}`);
        const tableName = m[1];
        const table = self.getTable(tableName);

        if (tableName === 'users') {
          const passwordHash = params[0];
          const salt = params[1];
          const userId = params[2];
          const role = params[3];
          const row = table.get(userId);
          if (row && (!role || row.role === role)) {
            row.password_hash = passwordHash;
            row.salt = salt;
          }
          return { rows: [], rowCount: row ? 1 : 0 };
        }

        if (tableName === 'sessions') {
          if (m[3].includes('"token_hash"')) {
            const row = table.get(params[1]);
            if (row) row.revoked_at = params[0];
          } else if (m[3].includes('"user_id"')) {
            const revokedAt = params[0];
            const userId = params[1];
            for (const row of table.values()) {
              if (row.user_id === userId && row.revoked_at === null) {
                row.revoked_at = revokedAt;
              }
            }
          }
          return { rows: [], rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
      }

      return { rows: [], rowCount: 0 };
    };

    const client = {
      query: exec,
      release: () => undefined,
    };
    return {
      query: exec,
      connect: async () => client,
      end: async () => undefined,
    };
  }
}

async function startIsolatedHttpServer() {
  const { apiRouter, _resetMasterRecoveryRateLimitForTesting } = await import('../api.ts');
  const app = express();
  app.use(express.json({ limit: '2mb' }));
  app.use('/api', apiRouter);

  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const addr = server.address();
  assert(addr && typeof addr !== 'string');
  return {
    baseUrl: `http://127.0.0.1:${addr.port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
    resetRateLimit: _resetMasterRecoveryRateLimitForTesting,
  };
}

async function postJson(
  url: string,
  body: Record<string, any>,
  headers: Record<string, string> = {}
) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  const data = (await res.json().catch(() => ({}))) as any;
  return { status: res.status, headers: res.headers, data };
}

async function runJsonWorkerPhaseA() {
  const dataDir = process.env.MOVILOG_DATA_DIR!;
  const dbPath = path.join(dataDir, 'db.json');
  const beforeData = JSON.parse(fs.readFileSync(dbPath, 'utf-8'));
  const beforeMaster = beforeData.users.find((u: any) => u.id === MASTER_ID);
  assert(beforeMaster, 'Original MASTER_OWNER missing in db.json');
  const otherUser = beforeData.users.find(
    (u: any) => u.id !== MASTER_ID && u.role === 'company_admin' && u.active
  );
  assert(otherUser, 'Expected at least one active company_admin in db.json');

  const { createSessionAsync } = await import('../db.ts');
  const oldMasterSessionToken = await createSessionAsync(MASTER_ID);
  const otherUserSessionToken = await createSessionAsync(otherUser.id);

  delete process.env.MASTER_RECOVERY_KEY;
  const srv = await startIsolatedHttpServer();
  try {
    // 1. Missing MASTER_RECOVERY_KEY -> 503
    const rMissingKey = await postJson(`${srv.baseUrl}/api/auth/master-recovery`, {
      email: MASTER_EMAIL,
      recoveryKey: TEST_RECOVERY_KEY,
      newPassword: NEW_STRONG_PASS,
      confirmPassword: NEW_STRONG_PASS,
    });
    assert.strictEqual(rMissingKey.status, 503, 'Expected 503 when MASTER_RECOVERY_KEY is unset');

    // Configure key for backend
    process.env.MASTER_RECOVERY_KEY = TEST_RECOVERY_KEY;

    // 2. Invalid Origin / Referer -> 403
    const rBadOrigin = await postJson(
      `${srv.baseUrl}/api/auth/master-recovery`,
      {
        email: MASTER_EMAIL,
        recoveryKey: TEST_RECOVERY_KEY,
        newPassword: NEW_STRONG_PASS,
        confirmPassword: NEW_STRONG_PASS,
      },
      { Origin: 'https://attacker.example.com' }
    );
    assert.strictEqual(rBadOrigin.status, 403, 'Expected 403 for untrusted Origin');

    const rBadReferer = await postJson(
      `${srv.baseUrl}/api/auth/master-recovery`,
      {
        email: MASTER_EMAIL,
        recoveryKey: TEST_RECOVERY_KEY,
        newPassword: NEW_STRONG_PASS,
        confirmPassword: NEW_STRONG_PASS,
      },
      { Referer: 'https://evil.example.com/reset' }
    );
    assert.strictEqual(rBadReferer.status, 403, 'Expected 403 for untrusted Referer');

    // Reset limiter before testing validation matrix
    srv.resetRateLimit();

    // 3. Secondary master email & regular user email -> 403
    const rSecondaryEmail = await postJson(`${srv.baseUrl}/api/auth/master-recovery`, {
      email: SECONDARY_MASTER_EMAIL,
      recoveryKey: TEST_RECOVERY_KEY,
      newPassword: NEW_STRONG_PASS,
      confirmPassword: NEW_STRONG_PASS,
    });
    assert.strictEqual(rSecondaryEmail.status, 403, 'Secondary master email must be rejected');

    const rCompanyEmail = await postJson(`${srv.baseUrl}/api/auth/master-recovery`, {
      email: otherUser.email,
      recoveryKey: TEST_RECOVERY_KEY,
      newPassword: NEW_STRONG_PASS,
      confirmPassword: NEW_STRONG_PASS,
    });
    assert.strictEqual(rCompanyEmail.status, 403, 'Non-master email must be rejected');

    // 4. Invalid recovery key -> 401
    const rWrongKey = await postJson(`${srv.baseUrl}/api/auth/master-recovery`, {
      email: MASTER_EMAIL,
      recoveryKey: 'WRONG-KEY-123',
      newPassword: NEW_STRONG_PASS,
      confirmPassword: NEW_STRONG_PASS,
    });
    assert.strictEqual(rWrongKey.status, 401, 'Invalid recovery key must return 401');

    // 5. Weak passwords & confirmation mismatch -> 400
    srv.resetRateLimit();
    for (const weak of [
      'Short#1A',
      'alllowercase123!',
      'ALLUPPERCASE123!',
      'NoNumbersHere!@#',
      'NoSpecialChars1234',
    ]) {
      const rWeak = await postJson(`${srv.baseUrl}/api/auth/master-recovery`, {
        email: MASTER_EMAIL,
        recoveryKey: TEST_RECOVERY_KEY,
        newPassword: weak,
        confirmPassword: weak,
      });
      assert.strictEqual(rWeak.status, 400, `Expected 400 for weak password: ${weak}`);
    }

    const rMismatch = await postJson(`${srv.baseUrl}/api/auth/master-recovery`, {
      email: MASTER_EMAIL,
      recoveryKey: TEST_RECOVERY_KEY,
      newPassword: NEW_STRONG_PASS,
      confirmPassword: 'Different#Password123',
    });
    assert.strictEqual(rMismatch.status, 400, 'Expected 400 for confirmation mismatch');

    // 6. Rate limiting -> 5 invalid key attempts, 6th blocked with 429
    srv.resetRateLimit();
    for (let i = 0; i < 5; i++) {
      const rAttempt = await postJson(`${srv.baseUrl}/api/auth/master-recovery`, {
        email: MASTER_EMAIL,
        recoveryKey: `bad-key-${i}`,
        newPassword: NEW_STRONG_PASS,
        confirmPassword: NEW_STRONG_PASS,
      });
      assert.strictEqual(rAttempt.status, 401);
    }
    const rLocked = await postJson(`${srv.baseUrl}/api/auth/master-recovery`, {
      email: MASTER_EMAIL,
      recoveryKey: TEST_RECOVERY_KEY,
      newPassword: NEW_STRONG_PASS,
      confirmPassword: NEW_STRONG_PASS,
    });
    assert.strictEqual(rLocked.status, 429, '6th attempt must be rate limited with 429');
    assert(rLocked.headers.get('retry-after'), '429 response must include Retry-After header');

    // 7. Valid recovery with matching Origin
    srv.resetRateLimit();
    const rOk = await postJson(
      `${srv.baseUrl}/api/auth/master-recovery`,
      {
        email: MASTER_EMAIL.toLowerCase(), // verify case-insensitive email matching
        recoveryKey: TEST_RECOVERY_KEY,
        newPassword: NEW_STRONG_PASS,
        confirmPassword: NEW_STRONG_PASS,
      },
      { Origin: srv.baseUrl }
    );
    assert.strictEqual(rOk.status, 200, `Expected 200 on valid recovery, got ${JSON.stringify(rOk)}`);
    assert.strictEqual(rOk.data.success, true);
    assert(!('token' in rOk.data), 'Recovery response must not bypass login with an auto-token');
    const serializedRes = JSON.stringify(rOk.data);
    assert(!serializedRes.includes(TEST_RECOVERY_KEY), 'Response leaked recoveryKey');
    assert(!serializedRes.includes(NEW_STRONG_PASS), 'Response leaked newPassword');

    // Verify db.json atomic update and preservation of all other data
    const afterData = JSON.parse(fs.readFileSync(dbPath, 'utf-8'));
    assert.strictEqual(afterData.users.length, beforeData.users.length, 'User count must not change');
    const afterMaster = afterData.users.find((u: any) => u.id === MASTER_ID);
    assert(afterMaster);
    assert.strictEqual(afterMaster.id, beforeMaster.id);
    assert.strictEqual(afterMaster.email, beforeMaster.email);
    assert.strictEqual(afterMaster.role, 'master_owner');
    assert.strictEqual(afterMaster.active, true);
    assert.strictEqual(afterMaster.companyId, null);
    assert.notStrictEqual(afterMaster.salt, beforeMaster.salt, 'Recovery must generate a new salt');
    assert.notStrictEqual(
      afterMaster.passwordHash,
      beforeMaster.passwordHash,
      'Recovery must update passwordHash'
    );

    // Every other user (including secondary master) must remain byte-for-byte identical
    for (const oldU of beforeData.users) {
      if (oldU.id === MASTER_ID) continue;
      const newU = afterData.users.find((u: any) => u.id === oldU.id);
      assert.deepStrictEqual(newU, oldU, `Non-target user ${oldU.email} was altered!`);
    }

    // Verify sanitized audit log
    const recLog = afterData.auditLogs.find((l: any) => l.acao === 'RECUPERACAO_MASTER');
    assert(recLog, 'Expected RECUPERACAO_MASTER audit entry');
    const serializedAudit = JSON.stringify(afterData.auditLogs);
    assert(!serializedAudit.includes(TEST_RECOVERY_KEY), 'Audit logs leaked MASTER_RECOVERY_KEY');
    assert(!serializedAudit.includes(NEW_STRONG_PASS), 'Audit logs leaked newPassword');
    assert(!serializedAudit.includes(afterMaster.passwordHash), 'Audit logs leaked passwordHash');
    assert(!serializedAudit.includes(afterMaster.salt), 'Audit logs leaked salt');

    // Verify old MASTER_OWNER session is revoked while other user session remains valid
    const meOldMaster = await fetch(`${srv.baseUrl}/api/auth/me`, {
      headers: { Authorization: `Bearer ${oldMasterSessionToken}` },
    });
    assert.strictEqual(meOldMaster.status, 401, 'Old MASTER_OWNER session must be revoked');

    const meOtherUser = await fetch(`${srv.baseUrl}/api/auth/me`, {
      headers: { Authorization: `Bearer ${otherUserSessionToken}` },
    });
    assert.strictEqual(meOtherUser.status, 200, 'Other user sessions must remain intact');

    // Verify immediate login with new password succeeds
    const loginNew = await postJson(`${srv.baseUrl}/api/auth/login`, {
      email: MASTER_EMAIL,
      password: NEW_STRONG_PASS,
    });
    assert.strictEqual(loginNew.status, 200, 'Login with new password must succeed immediately');
    assert.strictEqual(loginNew.data.user.id, MASTER_ID);
    assert.strictEqual(loginNew.data.user.role, 'master_owner');
    assert(loginNew.data.token);

    // Save tokens for restart survival check in phase B
    fs.writeFileSync(
      path.join(dataDir, '_phase_tokens.json'),
      JSON.stringify({ oldMasterSessionToken, otherUserSessionToken })
    );
  } finally {
    await srv.close();
  }
}

async function runJsonWorkerPhaseB() {
  const dataDir = process.env.MOVILOG_DATA_DIR!;
  const { oldMasterSessionToken, otherUserSessionToken } = JSON.parse(
    fs.readFileSync(path.join(dataDir, '_phase_tokens.json'), 'utf-8')
  );

  const srv = await startIsolatedHttpServer();
  try {
    // Old session remains revoked across restart
    const meOld = await fetch(`${srv.baseUrl}/api/auth/me`, {
      headers: { Authorization: `Bearer ${oldMasterSessionToken}` },
    });
    assert.strictEqual(meOld.status, 401, 'Old MASTER_OWNER session must remain revoked after restart');

    // Other user session still valid
    const meOther = await fetch(`${srv.baseUrl}/api/auth/me`, {
      headers: { Authorization: `Bearer ${otherUserSessionToken}` },
    });
    assert.strictEqual(meOther.status, 200);

    // Login with new password succeeds after fresh reload from disk
    const loginAfterRestart = await postJson(`${srv.baseUrl}/api/auth/login`, {
      email: MASTER_EMAIL,
      password: NEW_STRONG_PASS,
    });
    assert.strictEqual(loginAfterRestart.status, 200, 'New password must survive restart in JSON mode');
    assert.strictEqual(loginAfterRestart.data.user.id, MASTER_ID);
  } finally {
    await srv.close();
  }
}

async function runPgWorkerPhase() {
  const dataDir = process.env.MOVILOG_DATA_DIR!;
  const dbPath = path.join(dataDir, 'db.json');
  const sessionsPath = path.join(dataDir, 'sessions.json');
  const jsonDbShaBefore = sha256File(dbPath);
  const jsonSessionsShaBefore = sha256File(sessionsPath);

  const rawJson = JSON.parse(fs.readFileSync(dbPath, 'utf-8'));
  const harness = new IsolatedPgRecoveryHarness();
  const mockPool = harness.createMockPool();
  const pgDb = drizzle(mockPool, { schema });

  const { setPgDbForTesting } = await import('../../src/db/index.ts');
  setPgDbForTesting(pgDb);

  const { upsertCollectionItemInTx, upsertSystemConfigInTx, pgRepo, hashSessionToken } =
    await import('./repository.ts');

  // Seed PG tables cleanly
  await pgDb.transaction(async (tx) => {
    await upsertSystemConfigInTx(tx, rawJson.systemConfig);
    for (const p of rawJson.plans) await upsertCollectionItemInTx(tx, 'plans', p);
    for (const c of rawJson.companies) await upsertCollectionItemInTx(tx, 'companies', c);
    for (const u of rawJson.users) await upsertCollectionItemInTx(tx, 'users', u);
  });

  const beforeMasterRow = structuredClone(harness.tables.get('users')!.get(MASTER_ID));
  const otherUser = rawJson.users.find(
    (u: any) => u.id !== MASTER_ID && u.role === 'company_admin' && u.active
  );
  const beforeOtherRow = structuredClone(harness.tables.get('users')!.get(otherUser.id));

  const oldMasterPgToken = await pgRepo.createSession(MASTER_ID);
  const otherPgToken = await pgRepo.createSession(otherUser.id);
  harness.txLog.length = 0;

  process.env.MASTER_RECOVERY_KEY = TEST_RECOVERY_KEY;
  const srv = await startIsolatedHttpServer();
  try {
    // Reject wrong key & non-original email in PG mode
    const rBadEmail = await postJson(`${srv.baseUrl}/api/auth/master-recovery`, {
      email: SECONDARY_MASTER_EMAIL,
      recoveryKey: TEST_RECOVERY_KEY,
      newPassword: NEW_STRONG_PASS,
      confirmPassword: NEW_STRONG_PASS,
    });
    assert.strictEqual(rBadEmail.status, 403);

    const rBadKey = await postJson(`${srv.baseUrl}/api/auth/master-recovery`, {
      email: MASTER_EMAIL,
      recoveryKey: 'wrong-pg-key',
      newPassword: NEW_STRONG_PASS,
      confirmPassword: NEW_STRONG_PASS,
    });
    assert.strictEqual(rBadKey.status, 401);

    srv.resetRateLimit();
    const rOk = await postJson(`${srv.baseUrl}/api/auth/master-recovery`, {
      email: MASTER_EMAIL,
      recoveryKey: TEST_RECOVERY_KEY,
      newPassword: NEW_STRONG_PASS,
      confirmPassword: NEW_STRONG_PASS,
    });
    assert.strictEqual(rOk.status, 200, `PG recovery failed: ${JSON.stringify(rOk)}`);
    assert(harness.txLog.includes('BEGIN') && harness.txLog.includes('COMMIT'), 'Expected ACID TX');

    const afterMasterRow = harness.tables.get('users')!.get(MASTER_ID);
    assert.strictEqual(afterMasterRow.id, beforeMasterRow.id);
    assert.strictEqual(afterMasterRow.email, beforeMasterRow.email);
    assert.strictEqual(afterMasterRow.role, 'master_owner');
    assert.strictEqual(afterMasterRow.active, true);
    assert.notStrictEqual(afterMasterRow.salt, beforeMasterRow.salt);
    assert.notStrictEqual(afterMasterRow.password_hash, beforeMasterRow.password_hash);
    assert.deepStrictEqual(harness.tables.get('users')!.get(otherUser.id), beforeOtherRow);

    // Verify PG session revocation (only MASTER_OWNER revoked)
    const masterSessRow = harness.tables
      .get('sessions')!
      .get(hashSessionToken(oldMasterPgToken));
    const otherSessRow = harness.tables.get('sessions')!.get(hashSessionToken(otherPgToken));
    assert(masterSessRow.revoked_at !== null, 'PG master session must be revoked');
    assert.strictEqual(otherSessRow.revoked_at, null, 'PG other user session must remain active');

    const meOldPg = await fetch(`${srv.baseUrl}/api/auth/me`, {
      headers: { Authorization: `Bearer ${oldMasterPgToken}` },
    });
    assert.strictEqual(meOldPg.status, 401);

    const meOtherPg = await fetch(`${srv.baseUrl}/api/auth/me`, {
      headers: { Authorization: `Bearer ${otherPgToken}` },
    });
    assert.strictEqual(meOtherPg.status, 200);

    // Verify immediate login in PG mode with new password
    const loginPg = await postJson(`${srv.baseUrl}/api/auth/login`, {
      email: MASTER_EMAIL,
      password: NEW_STRONG_PASS,
    });
    assert.strictEqual(loginPg.status, 200);
    assert.strictEqual(loginPg.data.user.id, MASTER_ID);

    // Verify PG audit logs are sanitized
    const pgAudits = Array.from(harness.tables.get('audit_logs')!.values());
    assert(pgAudits.some((a) => a.acao === 'RECUPERACAO_MASTER'));
    const auditBlob = JSON.stringify(pgAudits);
    assert(!auditBlob.includes(TEST_RECOVERY_KEY), 'PG audit leaked MASTER_RECOVERY_KEY');
    assert(!auditBlob.includes(NEW_STRONG_PASS), 'PG audit leaked newPassword');
    assert(!auditBlob.includes(afterMasterRow.password_hash), 'PG audit leaked hash');
    assert(!auditBlob.includes(afterMasterRow.salt), 'PG audit leaked salt');

    // Verify JSON files were NEVER touched when PERSISTENCE_MODE=postgres
    assert.strictEqual(sha256File(dbPath), jsonDbShaBefore, 'PG mode must never write db.json');
    assert.strictEqual(
      sha256File(sessionsPath),
      jsonSessionsShaBefore,
      'PG mode must never write sessions.json'
    );
  } finally {
    await srv.close();
  }
}

function verifyFrontendNoSecretLeak() {
  const srcFiles = [
    'src/components/auth/LoginModal.tsx',
    'src/context/AuthContext.tsx',
    'src/lib/api.ts',
  ];
  for (const rel of srcFiles) {
    const content = fs.readFileSync(path.resolve(process.cwd(), rel), 'utf-8');
    assert(
      !content.includes('MASTER_RECOVERY_KEY'),
      `${rel} must never reference MASTER_RECOVERY_KEY`
    );
  }
  const loginModal = fs.readFileSync(
    path.resolve(process.cwd(), 'src/components/auth/LoginModal.tsx'),
    'utf-8'
  );
  assert(loginModal.includes('Esqueci minha senha'), 'LoginModal must include "Esqueci minha senha"');
  assert(
    loginModal.includes('E-mail da conta MASTER_OWNER'),
    'LoginModal must include MASTER_OWNER email field'
  );
  assert(
    loginModal.includes('Chave de recuperação administrativa'),
    'LoginModal must include administrative recovery key field'
  );
  assert(loginModal.includes('Nova senha'), 'LoginModal must include new password field');
  assert(
    loginModal.includes('Confirmar nova senha'),
    'LoginModal must include confirm password field'
  );
}

async function runOrchestrator() {
  const realDbPath = path.resolve(process.cwd(), 'data/db.json');
  const realSessionsPath = path.resolve(process.cwd(), 'data/sessions.json');
  const realDbShaBefore = sha256File(realDbPath);
  const realSessionsShaBefore = sha256File(realSessionsPath);

  verifyFrontendNoSecretLeak();
  console.log('[OK] Frontend static secret hygiene & UI fields check passed');

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'movilog-master-recovery-'));
  try {
    fs.copyFileSync(realDbPath, path.join(tempDir, 'db.json'));
    fs.copyFileSync(realSessionsPath, path.join(tempDir, 'sessions.json'));

    const tsxBin = path.resolve(process.cwd(), 'node_modules/.bin/tsx');
    const selfFile = path.resolve(process.cwd(), 'server/persistence/test_master_recovery_suite.ts');

    execFileSync(tsxBin, [selfFile], {
      stdio: 'inherit',
      env: {
        ...process.env,
        RECOVERY_TEST_WORKER: 'json_a',
        MOVILOG_DATA_DIR: tempDir,
        PERSISTENCE_MODE: 'json',
      },
    });
    console.log('[OK] JSON mode recovery, security matrix, session revocation & immediate login passed');

    execFileSync(tsxBin, [selfFile], {
      stdio: 'inherit',
      env: {
        ...process.env,
        RECOVERY_TEST_WORKER: 'json_b',
        MOVILOG_DATA_DIR: tempDir,
        PERSISTENCE_MODE: 'json',
      },
    });
    console.log('[OK] JSON mode persistence survival across restart passed');

    // Reset temp json copy cleanly before PG worker so we verify PG mode never mutates JSON
    fs.copyFileSync(realDbPath, path.join(tempDir, 'db.json'));
    fs.copyFileSync(realSessionsPath, path.join(tempDir, 'sessions.json'));

    execFileSync(tsxBin, [selfFile], {
      stdio: 'inherit',
      env: {
        ...process.env,
        RECOVERY_TEST_WORKER: 'pg_http',
        MOVILOG_DATA_DIR: tempDir,
        PERSISTENCE_MODE: 'postgres',
      },
    });
    console.log('[OK] PostgreSQL mode transactional recovery, session revocation & JSON isolation passed');
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
    assert.strictEqual(
      sha256File(realDbPath),
      realDbShaBefore,
      'Real data/db.json was modified during isolated tests!'
    );
    assert.strictEqual(
      sha256File(realSessionsPath),
      realSessionsShaBefore,
      'Real data/sessions.json was modified during isolated tests!'
    );
  }

  console.log('ALL MASTER_OWNER RECOVERY TESTS PASSED WITH REAL DATA UNTOUCHED.');
}

const worker = process.env.RECOVERY_TEST_WORKER;
if (worker === 'json_a') {
  runJsonWorkerPhaseA().catch((err) => {
    console.error(err);
    process.exit(1);
  });
} else if (worker === 'json_b') {
  runJsonWorkerPhaseB().catch((err) => {
    console.error(err);
    process.exit(1);
  });
} else if (worker === 'pg_http') {
  runPgWorkerPhase().catch((err) => {
    console.error(err);
    process.exit(1);
  });
} else {
  runOrchestrator().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

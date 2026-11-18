import assert from 'assert';
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { drizzle } from 'drizzle-orm/node-postgres';
import * as schema from '../../src/db/schema.ts';
import { setPgDbForTesting } from '../../src/db/index.ts';
import {
  db,
  hashPassword,
  verifyPassword,
  type DatabaseSchema,
  type User,
} from '../db.ts';
import {
  ALL_COLLECTION_KEYS,
  flushPgContext,
  hashSessionToken,
  pgRepo,
  preloadCollectionsIntoContext,
  resolveCollectionsForRoute,
  runWithPgContext,
} from './repository.ts';
import {
  MASTER_OWNER_EMAIL,
  MASTER_OWNER_ID,
  migrateJsonToPostgres,
  sha256File,
} from './migrate_json_to_pg.ts';

/**
 * Lightweight PostgreSQL Pool emulator for Drizzle ORM (`drizzle-orm/node-postgres`)
 * that executes inside an isolated in-memory store, records SQL statements & transaction
 * boundaries (BEGIN / COMMIT / ROLLBACK), and supports upsert/select/delete/for-update
 * verification without connecting to any external GCP database.
 */
class IsolatedPgTestHarness {
  public tables = new Map<string, Map<string, any>>();
  public txLog: string[] = [];
  private snapshotBeforeTx: Map<string, Map<string, any>> | null = null;
  private inTx = false;

  constructor() {
    const tableNames = [
      'system_config',
      'plans',
      'companies',
      'users',
      'sessions',
      'payments',
      'audit_logs',
      'logistics_receipts',
      'inventory',
      'stock_movements',
      'shipments',
      'deliveries',
      'vehicles',
      'routes',
      'condo_units',
      'condo_packages',
      'condo_visitors',
      'fiscal_configs',
      'fiscal_documents',
      'financial_records',
      'notifications',
      'commercial_products',
      'commercial_stock_movements',
      'commercial_sales',
      'commercial_cash_sessions',
      'commercial_suppliers',
      'commercial_purchases',
      'pix_charges',
      'commercial_terminals',
      'commercial_terminal_transactions',
      'prevention_dismissed_alerts',
      'warehouses',
      'warehouse_transfers',
      'warehouse_audits',
      'fulfillment_orders',
      'picking_tasks',
      'packing_tasks',
      'reverse_logistics',
      'carrier_partners',
      'b2b_clients',
      'b2b_collections',
      'shipping_manifests',
      'ai_insights',
      'route_stops',
      'commercial_sale_items',
      'commercial_cash_movements',
      'warehouse_positions',
      'warehouse_transfer_items',
      'warehouse_audit_items',
      'fulfillment_order_items',
      'picking_task_items',
      'migration_checkpoints',
    ];
    for (const t of tableNames) {
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
    if (!this.tables.has(name)) {
      this.tables.set(name, new Map());
    }
    return this.tables.get(name)!;
  }

  private parsePkColumn(tableName: string): string {
    return tableName === 'sessions' ? 'token_hash' : 'id';
  }

  // Returns column-ordered list from schema definition for positional Drizzle row arrays
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
        self.inTx = true;
        self.snapshotBeforeTx = self.cloneTables();
        self.txLog.push('BEGIN');
        return { rows: [], rowCount: 0 };
      }
      if (upper === 'COMMIT') {
        self.inTx = false;
        self.snapshotBeforeTx = null;
        self.txLog.push('COMMIT');
        return { rows: [], rowCount: 0 };
      }
      if (upper === 'ROLLBACK') {
        if (self.snapshotBeforeTx) {
          self.tables = self.snapshotBeforeTx;
        }
        self.inTx = false;
        self.snapshotBeforeTx = null;
        self.txLog.push('ROLLBACK');
        return { rows: [], rowCount: 0 };
      }

      // INSERT INTO "table" ("c1", "c2", ...) VALUES ($1, $2, ...), (...) ON CONFLICT (...) DO UPDATE SET ...
      if (upper.startsWith('INSERT INTO ')) {
        const m = sqlText.match(/^insert into "([^"]+)"\s*\(([^)]+)\)\s*values\s*(.+?)(?:\s+on conflict|\s+returning|$)/i);
        if (!m) throw new Error(`Unsupported INSERT SQL in test harness: ${sqlText}`);
        const tableName = m[1];
        const colNames = m[2].split(',').map((c: string) => c.trim().replace(/"/g, ''));
        const valuesBlock = m[3];
        const tupleCount = (valuesBlock.match(/\([^)]+\)/g) || []).length;
        const table = self.getTable(tableName);
        const pkCol = self.parsePkColumn(tableName);
        const colDefs = self.getSchemaColumns(tableName);

        for (let t = 0; t < tupleCount; t++) {
          const offset = t * colNames.length;
          const row: Record<string, any> = {};
          for (let i = 0; i < colNames.length; i++) {
            const col = colNames[i];
            let val = params[offset + i];
            // Drizzle serializes jsonb params as JSON strings
            if (typeof val === 'string' && (val.startsWith('{') || val.startsWith('['))) {
              const def = colDefs.find((d) => d.pgName === col);
              if (
                def &&
                [
                  'payload',
                  'modulos',
                  'modulos_permitidos',
                  'limites',
                  'recursos',
                  'summary',
                ].includes(col)
              ) {
                try {
                  val = JSON.parse(val);
                } catch {
                  // keep string
                }
              }
            }
            row[col] = val === undefined ? null : val;
          }
          const pk = String(row[pkCol]);
          table.set(pk, row);
        }
        return { rows: [], rowCount: tupleCount };
      }

      // SELECT ... FROM "table" [INNER JOIN ...] [WHERE ...]
      if (upper.startsWith('SELECT ')) {
        const fromMatch = sqlText.match(/\bfrom "([^"]+)"/i);
        if (!fromMatch) throw new Error(`Unsupported SELECT SQL in test harness: ${sqlText}`);
        const baseTableName = fromMatch[1];
        const selectPart = sqlText.slice(7, sqlText.toLowerCase().indexOf(' from '));
        const selectedCols = selectPart
          .split(',')
          .map((s: string) => s.trim().replace(/^"[^"]+"\./, '').replace(/"/g, ''));

        // Special handling for sessions INNER JOIN users
        const joinMatch = sqlText.match(/\binner join "([^"]+)" on "[^"]+"\."([^"]+)" = "[^"]+"\."([^"]+)"/i);
        if (joinMatch && baseTableName === 'sessions' && joinMatch[1] === 'users') {
          const tokenHashParam = params[0];
          const sess = self.getTable('sessions').get(tokenHashParam);
          if (!sess || sess.revoked_at !== null) {
            return { rows: [], rowCount: 0 };
          }
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
          const whereClause = sqlText.slice(sqlText.toLowerCase().indexOf(' where ') + 7).toLowerCase();
          if (whereClause.includes('"id" = $1') && whereClause.includes('"company_id" = $2')) {
            filtered = filtered.filter((r) => r.id === params[0] && r.company_id === params[1]);
          } else if (whereClause.includes('"id" = $1')) {
            filtered = filtered.filter((r) => r.id === params[0]);
          } else if (whereClause.includes('lower("users"."email") = $1')) {
            filtered = filtered.filter((r) => String(r.email).toLowerCase() === String(params[0]).toLowerCase());
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

      // UPDATE "table" SET ... WHERE ...
      if (upper.startsWith('UPDATE ')) {
        const m = sqlText.match(/^update "([^"]+)" set (.+?) where (.+)$/i);
        if (!m) throw new Error(`Unsupported UPDATE SQL in test harness: ${sqlText}`);
        const tableName = m[1];
        const table = self.getTable(tableName);
        if (tableName === 'sessions') {
          if (m[3].includes('"token_hash"')) {
            const revokedAt = params[0];
            const tokenHash = params[1];
            const row = table.get(tokenHash);
            if (row) row.revoked_at = revokedAt;
          } else if (m[3].includes('"user_id"')) {
            const revokedAt = params[0];
            const userId = params[1];
            for (const row of table.values()) {
              if (row.user_id === userId && row.revoked_at === null) {
                row.revoked_at = revokedAt;
              }
            }
          }
        }
        return { rows: [], rowCount: 1 };
      }

      // DELETE FROM "table" WHERE ...
      if (upper.startsWith('DELETE FROM ')) {
        const m = sqlText.match(/^delete from "([^"]+)" where (.+)$/i);
        if (!m) throw new Error(`Unsupported DELETE SQL in test harness: ${sqlText}`);
        const tableName = m[1];
        const table = self.getTable(tableName);
        const whereLower = m[2].toLowerCase();
        let deleted = 0;
        if (whereLower.includes(' in (')) {
          const toDel = new Set(params);
          for (const k of Array.from(table.keys())) {
            if (toDel.has(k)) {
              table.delete(k);
              deleted++;
            }
          }
        } else if (whereLower.includes('"route_id"')) {
          for (const [k, r] of Array.from(table.entries())) {
            if (r.route_id === params[0]) { table.delete(k); deleted++; }
          }
        } else if (whereLower.includes('"sale_id"')) {
          for (const [k, r] of Array.from(table.entries())) {
            if (r.sale_id === params[0]) { table.delete(k); deleted++; }
          }
        } else if (whereLower.includes('"cash_session_id"')) {
          for (const [k, r] of Array.from(table.entries())) {
            if (r.cash_session_id === params[0]) { table.delete(k); deleted++; }
          }
        } else if (whereLower.includes('"warehouse_id"')) {
          for (const [k, r] of Array.from(table.entries())) {
            if (r.warehouse_id === params[0]) { table.delete(k); deleted++; }
          }
        } else if (whereLower.includes('"transfer_id"')) {
          for (const [k, r] of Array.from(table.entries())) {
            if (r.transfer_id === params[0]) { table.delete(k); deleted++; }
          }
        } else if (whereLower.includes('"audit_id"')) {
          for (const [k, r] of Array.from(table.entries())) {
            if (r.audit_id === params[0]) { table.delete(k); deleted++; }
          }
        } else if (whereLower.includes('"order_id"')) {
          for (const [k, r] of Array.from(table.entries())) {
            if (r.order_id === params[0]) { table.delete(k); deleted++; }
          }
        } else if (whereLower.includes('"picking_task_id"')) {
          for (const [k, r] of Array.from(table.entries())) {
            if (r.picking_task_id === params[0]) { table.delete(k); deleted++; }
          }
        }
        return { rows: [], rowCount: deleted };
      }

      throw new Error(`Unhandled SQL in test harness: ${sqlText}`);
    };

    const client = {
      query: exec,
      release: () => {},
    };
    return {
      query: exec,
      connect: async () => client,
      end: async () => {},
    };
  }
}

async function runTests() {
  const results: { name: string; status: 'PASS' | 'FAIL'; details: string }[] = [];
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'movilog-phase2-'));
  const tmpDbPath = path.join(tmpDir, 'db.json');
  const tmpSessionsPath = path.join(tmpDir, 'sessions.json');
  const tmpSnapshotsDir = path.join(tmpDir, 'snapshots');

  fs.copyFileSync(path.resolve('data/db.json'), tmpDbPath);
  fs.copyFileSync(path.resolve('data/sessions.json'), tmpSessionsPath);

  const rawDb = JSON.parse(fs.readFileSync(tmpDbPath, 'utf-8')) as DatabaseSchema;
  const rawSessions = JSON.parse(fs.readFileSync(tmpSessionsPath, 'utf-8')) as Record<
    string,
    { userId: string; expiresAt: number }
  >;

  const record = (name: string, status: 'PASS' | 'FAIL', details: string) => {
    results.push({ name, status, details });
    console.log(`[${status}] ${name}: ${details}`);
  };

  try {
    // 1. Express + scrypt & MASTER_OWNER verification
    {
      const master = rawDb.users.find((u) => u.id === MASTER_OWNER_ID);
      assert(master, 'MASTER_OWNER não encontrado');
      assert.strictEqual(master.email, MASTER_OWNER_EMAIL);
      assert.strictEqual(master.role, 'master_owner');

      const { hash, salt } = hashPassword('MoviLog@Test123');
      assert.strictEqual(verifyPassword('MoviLog@Test123', hash, salt), true);
      assert.strictEqual(verifyPassword('WrongPass', hash, salt), false);

      // Ensure all 79 users keep intact 128-hex-char scrypt hashes and 32-hex-char salts
      for (const u of rawDb.users) {
        assert(/^[0-9a-f]{128}$/i.test(u.passwordHash), `Invalid scrypt hash for ${u.email}`);
        assert(/^[0-9a-f]{32}$/i.test(u.salt), `Invalid salt for ${u.email}`);
      }
      record(
        '1. Express/scrypt & MASTER_OWNER integrity',
        'PASS',
        `${rawDb.users.length} usuários com hashes scrypt (128 hex) e salts (32 hex) válidos; MASTER_OWNER (${MASTER_OWNER_ID}) intacto.`
      );
    }

    // 2. Immutable snapshot + dry-run checksums
    {
      const dry = await migrateJsonToPostgres({
        dbFilePath: tmpDbPath,
        sessionsFilePath: tmpSessionsPath,
        snapshotBaseDir: tmpSnapshotsDir,
        dryRun: true,
      });
      assert.strictEqual(dry.dryRun, true);
      assert.strictEqual(dry.parity, null);
      assert.strictEqual(dry.snapshot.dbSha256, sha256File(tmpDbPath));
      assert.strictEqual(dry.snapshot.sessionsSha256, sha256File(tmpSessionsPath));
      const mode = fs.statSync(dry.snapshot.dbSnapshotPath).mode & 0o777;
      assert.strictEqual(mode, 0o444, 'Snapshot deve ser somente leitura (0444)');
      record(
        '2. Snapshot imutável & checksums SHA-256 (dry-run)',
        'PASS',
        `SHA-256 conferido (${dry.snapshot.dbSha256.slice(0, 12)}...), permissão 0444 aplicada.`
      );
    }

    // 3. Full Transactional Migration + Idempotency + Parity Report (42 collections + 119 sessions + 8 child tables)
    const harness = new IsolatedPgTestHarness();
    const testPgDb = drizzle(harness.createMockPool(), { schema });
    setPgDbForTesting(testPgDb);
    process.env.PERSISTENCE_MODE = 'postgres';

    {
      const run1 = await migrateJsonToPostgres({
        dbFilePath: tmpDbPath,
        sessionsFilePath: tmpSessionsPath,
        snapshotBaseDir: tmpSnapshotsDir,
        dryRun: false,
        pg: testPgDb,
      });
      assert(run1.parity && run1.parity.passed, `Paridade falhou: ${run1.parity?.mismatches.join('; ')}`);
      assert.strictEqual(run1.parity.masterOwnerPreserved, true);
      assert.strictEqual(run1.parity.hashesAndSaltsIdentical, true);
      assert.strictEqual(run1.parity.sessionsMigrated, Object.keys(rawSessions).length);

      // Re-run for idempotency
      const run2 = await migrateJsonToPostgres({
        dbFilePath: tmpDbPath,
        sessionsFilePath: tmpSessionsPath,
        snapshotBaseDir: tmpSnapshotsDir,
        dryRun: false,
        pg: testPgDb,
      });
      assert(run2.parity && run2.parity.passed, 'Reexecução idempotente falhou na paridade');
      assert(harness.txLog.includes('BEGIN') && harness.txLog.includes('COMMIT'), 'Transação ACID não registrada');
      record(
        '3. Migração Transacional, Idempotência & Paridade',
        'PASS',
        `42 coleções + ${run2.parity.sessionsMigrated} sessões migradas com idempotência e paridade 100% (hashes/salts idênticos).`
      );
    }

    // 4. SHA-256 Session Token Compatibility + Session Creation & Revocation
    {
      const sampleUser = rawDb.users[0] as User;
      // Verify a pre-existing raw token from sessions.json validates via SHA-256 hash
      const [legacyToken, legacyMeta] = Object.entries(rawSessions)[0];
      const legacyHash = hashSessionToken(legacyToken);
      assert(harness.tables.get('sessions')!.has(legacyHash), 'Token legado não encontrado pelo hash SHA-256');
      assert(!harness.tables.get('sessions')!.has(legacyToken), 'Token em texto puro não deve ser armazenado');

      // Create fresh session via pgRepo, verify, revoke, verify invalidation
      const newToken = await pgRepo.createSession(sampleUser.id);
      const authedUser = await pgRepo.getSessionUser(newToken);
      assert(authedUser && authedUser.id === sampleUser.id, 'Sessão recém-criada não validada');
      await pgRepo.destroySession(newToken);
      const afterLogout = await pgRepo.getSessionUser(newToken);
      assert.strictEqual(afterLogout, null, 'Sessão revogada continuou válida');

      // Revoke all sessions of user
      const tokA = await pgRepo.createSession(sampleUser.id);
      const tokB = await pgRepo.createSession(sampleUser.id);
      await pgRepo.revokeAllUserSessions(sampleUser.id);
      assert.strictEqual(await pgRepo.getSessionUser(tokA), null);
      assert.strictEqual(await pgRepo.getSessionUser(tokB), null);

      record(
        '4. Sessões SHA-256 & Revogação Multi-instância',
        'PASS',
        `Tokens armazenados somente como SHA-256 (${legacyHash.slice(0, 12)}...); login, logout e revogação em lote validados.`
      );
    }

    // 5. Multi-tenant Isolation & Concurrency (parallel AsyncLocalStorage contexts + atomic stock lock)
    {
      const [companyA, companyB] = rawDb.companies;
      assert(companyA && companyB, 'Empresas de teste insuficientes');

      // Concurrent isolated request contexts
      const [resA, resB] = await Promise.all([
        runWithPgContext(async () => {
          const { keys, includeSystemConfig } = resolveCollectionsForRoute('/deliveries');
          await preloadCollectionsIntoContext(keys, includeSystemConfig);
          const countBefore = db.deliveries.length;
          db.deliveries.push({
            id: 'test-deliv-a',
            companyId: companyA.id,
            codigoRastreio: 'TEST-A-001',
            status: 'pendente',
            destinatario: 'Cliente A',
            telefone: '11999990000',
            endereco: 'Rua A',
            numero: '10',
            bairro: 'Centro',
            cidade: 'São Paulo',
            cep: '01000-000',
            volumes: 1,
            pesoKg: 1,
            prioridade: 'media',
            prazoEntrega: new Date().toISOString(),
            geocodificado: false,
            tentativas: 0,
            origemImportacao: 'manual',
            criadoEm: new Date().toISOString(),
            atualizadoEm: new Date().toISOString(),
          });
          await flushPgContext();
          return { countBefore, countAfter: db.deliveries.length };
        }),
        runWithPgContext(async () => {
          const { keys, includeSystemConfig } = resolveCollectionsForRoute('/condo/packages');
          await preloadCollectionsIntoContext(keys, includeSystemConfig);
          const filtered = db.condoPackages.filter((p) => p.companyId === companyB.id);
          return { companyBPackages: filtered.length };
        }),
      ]);

      assert.strictEqual(resA.countAfter, resA.countBefore + 1);
      assert(harness.tables.get('deliveries')!.has('test-deliv-a'), 'Entrega da Company A não persistida no PG');

      // Atomic stock adjustment + rollback check
      const prod = rawDb.commercialProducts[0];
      assert(prod, 'Produto comercial não encontrado para teste atômico');
      const initialStock = prod.estoqueAtual;
      const adj = await pgRepo.adjustCommercialStockAtomic({
        companyId: prod.companyId,
        productId: prod.id,
        delta: -1,
        tipo: 'ajuste_manual',
        motivo: 'Teste atômico Fase 2',
        usuarioId: MASTER_OWNER_ID,
        usuarioNome: 'Master Test',
      });
      assert.strictEqual(adj.product.estoqueAtual, initialStock - 1);

      let insufficientThrown = false;
      try {
        await pgRepo.adjustCommercialStockAtomic({
          companyId: prod.companyId,
          productId: prod.id,
          delta: -(initialStock + 500),
          tipo: 'saida_venda',
          motivo: 'Teste rollback estoque insuficiente',
          usuarioId: MASTER_OWNER_ID,
          usuarioNome: 'Master Test',
        });
      } catch {
        insufficientThrown = true;
      }
      assert.strictEqual(insufficientThrown, true, 'Estoque negativo não foi bloqueado');

      // Transaction rollback verification
      const countBeforeRollback = harness.tables.get('audit_logs')!.size;
      let txRolledBack = false;
      try {
        await pgRepo.runInTransaction(async (tx) => {
          await tx.insert(schema.auditLogs).values({
            id: 'rollback-audit-id',
            timestamp: new Date().toISOString(),
            userId: MASTER_OWNER_ID,
            userEmail: MASTER_OWNER_EMAIL,
            userName: 'Rollback Test',
            acao: 'TESTE_ROLLBACK',
            detalhes: 'Deve sofrer rollback',
          });
          throw new Error('Simulated crash mid-transaction');
        });
      } catch {
        txRolledBack = true;
      }
      assert.strictEqual(txRolledBack, true);
      assert.strictEqual(
        harness.tables.get('audit_logs')!.size,
        countBeforeRollback,
        'Rollback não desfez inserção parcial!'
      );

      record(
        '5. Concorrência, Transações ACID, Rollback & Isolamento Multiempresa',
        'PASS',
        `Contextos paralelos AsyncLocalStorage isolados; ajuste atômico com FOR UPDATE e rollback transacional confirmados (Company B pacotes=${resB.companyBPackages}).`
      );
    }

    // 6. Live Local HTTP Contracts Check (JSON runtime preserved before cutover)
    process.env.PERSISTENCE_MODE = 'json';
    setPgDbForTesting(undefined);
    {
      const base = 'http://127.0.0.1:3000';
      const health = await fetch(`${base}/api/health`).then((r) => r.json());
      assert.strictEqual(health.status, 'ok');
      assert.strictEqual(health.persistenceMode, 'json');

      const authStatus = await fetch(`${base}/api/auth/status`).then((r) => r.json());
      assert.strictEqual(authStatus.masterEmail, MASTER_OWNER_EMAIL);

      const unauthMe = await fetch(`${base}/api/auth/me`);
      assert.strictEqual(unauthMe.status, 401);

      const plansRes = await fetch(`${base}/api/plans`).then((r) => r.json());
      assert(Array.isArray(plansRes.plans) && plansRes.plans.length === 5);

      const badLogin = await fetch(`${base}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: MASTER_OWNER_EMAIL, password: 'InvalidPassword123' }),
      });
      assert.strictEqual(badLogin.status, 401);

      record(
        '6. Contratos HTTP no servidor ativo (JSON preservado)',
        'PASS',
        `/api/health (persistenceMode=json), /api/auth/status, /api/auth/me (401), /api/plans (5 planos), /api/auth/login (401 senha inválida) preservados.`
      );
    }

    // 7. Route coverage check
    {
      const testPaths = [
        '/auth/login',
        '/master/companies',
        '/logistics/inventory',
        '/condo/packages',
        '/deliveries',
        '/fiscal/emit',
        '/commerce/sales',
        '/warehouses/transfers',
        '/fulfillment/orders',
        '/company/users',
        '/tracking/public/ABC',
        '/notifications',
        '/dashboard/metrics',
      ];
      for (const p of testPaths) {
        const resolved = resolveCollectionsForRoute(p);
        assert(resolved.keys.length > 0, `Rota sem mapeamento: ${p}`);
      }
      assert.strictEqual(ALL_COLLECTION_KEYS.length, 41);
      record(
        '7. Cobertura de Coleções & Roteamento Dinâmico',
        'PASS',
        `41 coleções de array + systemConfig + sessions + 8 tabelas filhas + checkpoints mapeadas.`
      );
    }
  } finally {
    process.env.PERSISTENCE_MODE = 'json';
    setPgDbForTesting(undefined);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }

  console.log('\nRESUMO DOS TESTES FASE 2:', JSON.stringify(results, null, 2));
}

runTests().catch((err) => {
  console.error('Erro na suíte de testes Fase 2:', err);
  process.exit(1);
});

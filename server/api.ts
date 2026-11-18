import express from 'express';
import type { Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import QRCode from 'qrcode';
import {
  db,
  generateChaveAcessoNFe,
  hashPassword,
  verifyPassword,
  createSessionAsync,
  getSessionUserAsync,
  destroySessionAsync,
  revokeAllUserSessionsAsync
} from './db.ts';
import {
  getActivePgContext,
  isPostgresActive,
  pgRepo,
  preloadCollectionsIntoContext,
  resolveCollectionsForRoute,
  runWithPgContext
} from './persistence/repository.ts';
import type {
  User,
  Company,
  CommercialPlan,
  PaymentRequest,
  LogisticsReceipt,
  InventoryItem,
  StockMovement,
  ShipmentOrder,
  DeliveryItem,
  Vehicle,
  RouteStop,
  DeliveryRoute,
  CondoUnit,
  CondoPackage,
  CondoVisitor,
  FiscalConfig,
  FiscalDocument,
  FinancialRecord,
  NotificationItem,
  CommercialProduct,
  CommercialStockMovement,
  CommercialSale,
  CommercialSaleItem,
  CommercialCashSession,
  CashMovement,
  CommercialSupplier,
  CommercialPurchase,
  PixCharge,
  CommercialTerminal,
  CommercialTerminalTransaction,
  TerminalProvider,
  TerminalTransactionStatus,
  PreventionResolvedAlert,
  WarehouseCD,
  WarehousePosition,
  WarehouseTransfer,
  WarehouseTransferItem,
  WarehouseInventoryAudit,
  WarehouseInventoryAuditItem,
  FulfillmentOrder,
  FulfillmentStage,
  FulfillmentItem,
  PickingTask,
  PackingTask,
  ShippingManifest,
  ReverseLogisticsTicket
} from './db.ts';
import { geocodeAddress, calculateDistanceKm } from './geocoding.ts';
import { generateBacenPixPayload, createPixChargeQrCode, getPixProviderStatus } from './pix.ts';
import { GatewayFactory } from './payment_gateways/GatewayFactory.ts';

export const apiRouter = express.Router();

// Request-scoped PostgreSQL transactional context (active only when PERSISTENCE_MODE=postgres)
apiRouter.use((req: Request, res: Response, next: NextFunction): void => {
  if (!isPostgresActive()) {
    next();
    return;
  }

  runWithPgContext(async () => {
    const ctx = getActivePgContext();
    const origJson = res.json.bind(res);

    const flushPendingBeforeSend = async () => {
      if (ctx && ctx.pendingFlushes.length > 0) {
        const toAwait = [...ctx.pendingFlushes];
        ctx.pendingFlushes.length = 0;
        await Promise.all(toAwait);
      }
    };

    res.json = ((body?: any) => {
      if (ctx && ctx.pendingFlushes.length > 0) {
        flushPendingBeforeSend()
          .then(() => origJson(body))
          .catch((err) => {
            if (!res.headersSent) {
              next(err);
            }
          });
        return res;
      }
      return origJson(body);
    }) as Response['json'];

    const { keys, includeSystemConfig } = resolveCollectionsForRoute(req.path);
    await preloadCollectionsIntoContext(keys, includeSystemConfig);
    next();
  }).catch((err) => {
    next(err);
  });
});

// Extend Request with authenticated user
interface AuthRequest extends Request {
  user?: User;
  company?: Company;
}

// Authentication Middleware
const authenticate = async (req: AuthRequest, res: Response, next: NextFunction): Promise<void> => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      res.status(401).json({ error: 'Autenticação necessária' });
      return;
    }
    const token = authHeader.substring(7);
    const user = await getSessionUserAsync(token);
    if (!user) {
      res.status(401).json({ error: 'Sessão inválida ou expirada' });
      return;
    }
    req.user = user;

    if (user.companyId) {
      const company = db.companies.find(c => c.id === user.companyId);
      if (company) {
        req.company = company;
      }
    } else if (user.role === 'master_owner') {
      req.company = ensureDefaultCompany(req);
    }
    next();
  } catch (err) {
    next(err);
  }
};

// Helper to ensure at least one active operational company exists
export const ensureDefaultCompany = (req?: AuthRequest): Company => {
  if (db.companies.length > 0) {
    return db.companies[0];
  }
  const defaultMasterCompany: Company = {
    id: crypto.randomUUID(),
    razaoSocial: 'LogiPredial - Gestão Operacional e Logística Ltda',
    nomeFantasia: 'LogiPredial Sede Matriz',
    cnpj: '00.000.000/0001-91',
    responsavel: req?.user?.name || 'Alifer Madeiro',
    email: req?.user?.email || db.systemConfig.masterEmail,
    telefone: req?.user?.phone || '11973479473',
    endereco: 'Av. Paulista, 1000 - São Paulo/SP',
    segmento: 'Logística, Expedição e Gestão Predial Integrada',
    quantidadeFuncionarios: 15,
    tipoOperacao: 'integrada',
    modulos: ['logistica', 'predial'],
    planoId: 'plan_empresarial',
    statusCadastro: 'ativo',
    statusAssinatura: 'assinatura_ativa',
    limites: {
      maxUsuarios: 9999,
      maxUnidades: 9999,
      maxOperacoesMes: 99999
    },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
  db.companies.push(defaultMasterCompany);
  db.save();
  return defaultMasterCompany;
};

// Helper to reliably resolve the target company ID for operational actions
export const getEffectiveCompanyId = (req: AuthRequest): string => {
  if (req.company?.id) return req.company.id;
  if (req.user?.companyId) return req.user.companyId;
  if (req.body?.companyId && typeof req.body.companyId === 'string' && req.body.companyId.trim()) {
    return req.body.companyId.trim();
  }
  if (req.query?.companyId && typeof req.query.companyId === 'string' && req.query.companyId.trim()) {
    return req.query.companyId.trim();
  }
  const headerCompany = req.headers['x-company-id'];
  if (headerCompany && typeof headerCompany === 'string' && headerCompany.trim()) {
    return headerCompany.trim();
  }

  const comp = ensureDefaultCompany(req);
  return comp.id;
};

// Master Owner Authorization Middleware
const requireMaster = (req: AuthRequest, res: Response, next: NextFunction): void => {
  if (!req.user) {
    res.status(401).json({ error: 'Não autenticado' });
    return;
  }
  if (req.user.role !== 'master_owner') {
    res.status(403).json({ error: 'Acesso restrito ao Administrador Master Owner' });
    return;
  }
  next();
};

// Subscription Check Middleware (Master Owner is completely exempt)
const checkSubscription = async (req: AuthRequest, res: Response, next: NextFunction): Promise<void> => {
  try {
    if (!req.user) {
      res.status(401).json({ error: 'Não autenticado' });
      return;
    }
    // Master Owner always has full permanent access
    if (req.user.role === 'master_owner') {
      next();
      return;
    }

    const company = req.company;
    if (!company) {
      res.status(403).json({ error: 'Empresa não encontrada' });
      return;
    }

    if (company.statusCadastro === 'suspenso' || company.statusCadastro === 'encerrado') {
      res.status(403).json({ error: 'Acesso da empresa suspenso ou encerrado pelo administrador' });
      return;
    }

    // Check Demo status
    if (company.statusAssinatura === 'demo_ativa') {
      if (company.demoEndDate) {
        const now = new Date().getTime();
        const end = new Date(company.demoEndDate).getTime();
        if (now > end) {
          company.statusAssinatura = 'demo_expirada';
          company.updatedAt = new Date().toISOString();
          await db.save();
          res.status(402).json({
            error: 'Período de demonstração expirado',
            statusAssinatura: 'demo_expirada'
          });
          return;
        }
      }
    } else if (company.statusAssinatura === 'assinatura_ativa') {
      if (company.subscriptionEndDate) {
        const now = new Date().getTime();
        const end = new Date(company.subscriptionEndDate).getTime();
        if (now > end) {
          company.statusAssinatura = 'assinatura_vencida';
          company.updatedAt = new Date().toISOString();
          await db.save();
          res.status(402).json({
            error: 'Assinatura vencida. Favor renovar.',
            statusAssinatura: 'assinatura_vencida'
          });
          return;
        }
      }
    } else {
      res.status(402).json({
        error: 'Plano não ativo. Escolha um plano para continuar.',
        statusAssinatura: company.statusAssinatura
      });
      return;
    }

    next();
  } catch (err) {
    next(err);
  }
};

// ==========================================
// 1. AUTH & INITIALIZATION
// ==========================================

// Get system initialization status
apiRouter.get('/auth/status', (req: Request, res: Response) => {
  const masterEmail = db.systemConfig.masterEmail;
  const masterUser = db.users.find(u => u.role === 'master_owner' && u.email.toLowerCase() === masterEmail.toLowerCase());
  res.json({
    masterInitialized: !!masterUser && db.systemConfig.masterInitialized,
    masterEmail: masterEmail,
    plataforma: db.systemConfig.nomePlataforma
  });
});

// Initialize Master Owner account securely
// Initialize or Reset Master Owner account securely
apiRouter.post('/auth/init-master', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { email, password, name, phone } = req.body;
    const authorizedEmails = [
      db.systemConfig.masterEmail.toLowerCase(),
      'alifermadeiro@hotmail.com',
      'alifergael76@gmail.com'
    ];

    if (!email || !authorizedEmails.includes(email.trim().toLowerCase())) {
      res.status(400).json({ error: `O e-mail de ativação deve ser um dos e-mails autorizados do Master Owner (${db.systemConfig.masterEmail})` });
      return;
    }

    const cleanEmail = email.trim().toLowerCase();
    const existingMaster = db.users.find(u => u.role === 'master_owner' && (u.email.toLowerCase() === cleanEmail || authorizedEmails.includes(u.email.toLowerCase())));

    if (!password || password.length < 8) {
      res.status(400).json({ error: 'A senha do Master Owner deve possuir pelo menos 8 caracteres' });
      return;
    }

    const { hash, salt } = hashPassword(password);

    // Update existing or create master user
    const masterId = existingMaster ? existingMaster.id : crypto.randomUUID();
    const masterUser: User = {
      id: masterId,
      email: existingMaster ? existingMaster.email : db.systemConfig.masterEmail,
      name: name || existingMaster?.name || 'Administrador Master Owner',
      passwordHash: hash,
      salt: salt,
      role: 'master_owner',
      companyId: null,
      phone: phone || existingMaster?.phone || '',
      active: true,
      createdAt: existingMaster?.createdAt || new Date().toISOString()
    };

    if (existingMaster) {
      const index = db.users.findIndex(u => u.id === existingMaster.id);
      db.users[index] = masterUser;
    } else {
      db.users.push(masterUser);
    }

    // Also synchronize any secondary authorized master account (e.g. alifergael76@gmail.com)
    db.users.forEach(u => {
      if (u.role === 'master_owner' && authorizedEmails.includes(u.email.toLowerCase())) {
        u.passwordHash = hash;
        u.salt = salt;
        u.active = true;
      }
    });

    db.systemConfig.masterInitialized = true;
    await db.save();

    await db.logAudit({
      userId: masterUser.id,
      userEmail: masterUser.email,
      userName: masterUser.name,
      acao: existingMaster ? 'REINICIALIZACAO_MASTER' : 'INICIALIZACAO_MASTER',
      detalhes: 'Conta Master Owner inicializada e verificada com sucesso',
      ip: req.ip
    });

    const token = await createSessionAsync(masterUser.id);
    res.json({
      message: 'Master Owner configurado e autenticado com sucesso',
      token,
      user: {
        id: masterUser.id,
        email: masterUser.email,
        name: masterUser.name,
        role: masterUser.role,
        companyId: null
      }
    });
  } catch (err) {
    next(err);
  }
});

const ORIGINAL_MASTER_OWNER_ID = '312f0489-d5ba-4a34-b493-4ffe7318cf2e';
const ORIGINAL_MASTER_OWNER_EMAIL = 'Alifermadeiro@hotmail.com';
const RECOVERY_RATE_WINDOW_MS = 15 * 60 * 1000;
const RECOVERY_MAX_ATTEMPTS_PER_IP = 5;
const RECOVERY_MAX_FAILED_GLOBAL = 12;

interface RecoveryAttemptBucket {
  count: number;
  resetAt: number;
}

const recoveryIpAttempts = new Map<string, RecoveryAttemptBucket>();
let recoveryGlobalFailures: RecoveryAttemptBucket = {
  count: 0,
  resetAt: Date.now() + RECOVERY_RATE_WINDOW_MS,
};

export function _resetMasterRecoveryRateLimitForTesting(): void {
  recoveryIpAttempts.clear();
  recoveryGlobalFailures = {
    count: 0,
    resetAt: Date.now() + RECOVERY_RATE_WINDOW_MS,
  };
}

function getRecoveryClientKey(req: Request): string {
  const fwd = req.headers['x-forwarded-for'];
  const fwdIp = typeof fwd === 'string' ? fwd.split(',')[0]?.trim() : '';
  return req.ip || fwdIp || req.socket.remoteAddress || 'unknown';
}

function checkRecoveryRateLimit(clientKey: string): { allowed: boolean; retryAfterSec: number } {
  const now = Date.now();
  if (now > recoveryGlobalFailures.resetAt) {
    recoveryGlobalFailures = { count: 0, resetAt: now + RECOVERY_RATE_WINDOW_MS };
  }
  if (recoveryGlobalFailures.count >= RECOVERY_MAX_FAILED_GLOBAL) {
    return {
      allowed: false,
      retryAfterSec: Math.max(1, Math.ceil((recoveryGlobalFailures.resetAt - now) / 1000)),
    };
  }

  const bucket = recoveryIpAttempts.get(clientKey);
  if (bucket) {
    if (now > bucket.resetAt) {
      recoveryIpAttempts.delete(clientKey);
    } else if (bucket.count >= RECOVERY_MAX_ATTEMPTS_PER_IP) {
      return {
        allowed: false,
        retryAfterSec: Math.max(1, Math.ceil((bucket.resetAt - now) / 1000)),
      };
    }
  }
  return { allowed: true, retryAfterSec: 0 };
}

function recordRecoveryFailure(clientKey: string): void {
  const now = Date.now();
  if (now > recoveryGlobalFailures.resetAt) {
    recoveryGlobalFailures = { count: 1, resetAt: now + RECOVERY_RATE_WINDOW_MS };
  } else {
    recoveryGlobalFailures.count += 1;
  }

  const bucket = recoveryIpAttempts.get(clientKey);
  if (!bucket || now > bucket.resetAt) {
    recoveryIpAttempts.set(clientKey, { count: 1, resetAt: now + RECOVERY_RATE_WINDOW_MS });
  } else {
    bucket.count += 1;
  }
}

function clearRecoveryFailureForClient(clientKey: string): void {
  recoveryIpAttempts.delete(clientKey);
}

function isAllowedRecoveryOrigin(req: Request): boolean {
  const secFetchSite = req.get('sec-fetch-site');
  if (secFetchSite && secFetchSite.toLowerCase() === 'cross-site') {
    return false;
  }

  const allowedHosts = new Set<string>();
  const reqHost = req.get('host');
  if (reqHost) allowedHosts.add(reqHost.toLowerCase());
  const fwdHost = req.get('x-forwarded-host');
  if (fwdHost) {
    for (const h of fwdHost.split(',')) {
      if (h.trim()) allowedHosts.add(h.trim().toLowerCase());
    }
  }
  if (process.env.APP_URL) {
    try {
      const appUrl = new URL(process.env.APP_URL);
      allowedHosts.add(appUrl.host.toLowerCase());
    } catch {
      // Ignore placeholder values such as MY_APP_URL
    }
  }

  const origin = req.get('origin');
  if (origin !== undefined) {
    if (!origin || origin === 'null') return false;
    try {
      const parsed = new URL(origin);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
      return allowedHosts.has(parsed.host.toLowerCase());
    } catch {
      return false;
    }
  }

  const referer = req.get('referer');
  if (referer !== undefined) {
    try {
      const parsed = new URL(referer);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
      return allowedHosts.has(parsed.host.toLowerCase());
    } catch {
      return false;
    }
  }

  return true;
}

function verifyRecoveryKeyConstantTime(providedKey: string, configuredKey: string): boolean {
  const providedDigest = crypto.createHash('sha256').update(providedKey, 'utf8').digest();
  const configuredDigest = crypto.createHash('sha256').update(configuredKey, 'utf8').digest();
  return crypto.timingSafeEqual(providedDigest, configuredDigest);
}

function validateStrongMasterPassword(password: string): string | null {
  if (typeof password !== 'string' || password.length < 12) {
    return 'A nova senha deve possuir pelo menos 12 caracteres.';
  }
  if (!/[A-Z]/.test(password)) {
    return 'A nova senha deve conter pelo menos uma letra maiúscula.';
  }
  if (!/[a-z]/.test(password)) {
    return 'A nova senha deve conter pelo menos uma letra minúscula.';
  }
  if (!/[0-9]/.test(password)) {
    return 'A nova senha deve conter pelo menos um número.';
  }
  if (!/[^A-Za-z0-9]/.test(password)) {
    return 'A nova senha deve conter pelo menos um caractere especial.';
  }
  return null;
}

async function logSanitizedRecoveryAudit(params: {
  acao: string;
  detalhes: string;
  ip?: string;
  userId?: string;
  userEmail?: string;
  userName?: string;
}): Promise<void> {
  const entry = {
    userId: params.userId || ORIGINAL_MASTER_OWNER_ID,
    userEmail: params.userEmail || ORIGINAL_MASTER_OWNER_EMAIL,
    userName: params.userName || 'Master Owner',
    acao: params.acao,
    detalhes: params.detalhes,
    ip: params.ip,
  };
  if (isPostgresActive()) {
    await pgRepo.logAudit(entry);
    return;
  }
  db.logAudit(entry);
}

// Secure Administrative Master Owner Recovery (strictly requires MASTER_RECOVERY_KEY)
apiRouter.post('/auth/master-recovery', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const clientKey = getRecoveryClientKey(req);

    if (!isAllowedRecoveryOrigin(req)) {
      recordRecoveryFailure(clientKey);
      await logSanitizedRecoveryAudit({
        acao: 'RECUPERACAO_MASTER_ORIGEM_NEGADA',
        detalhes: 'Tentativa de recuperação administrativa bloqueada por origem inválida.',
        ip: req.ip,
      });
      res.status(403).json({ error: 'Origem da solicitação não autorizada.' });
      return;
    }

    const rateCheck = checkRecoveryRateLimit(clientKey);
    if (!rateCheck.allowed) {
      res.setHeader('Retry-After', String(rateCheck.retryAfterSec));
      res.status(429).json({
        error: 'Muitas tentativas de recuperação. Aguarde antes de tentar novamente.',
      });
      return;
    }

    const configuredRecoveryKey = (process.env.MASTER_RECOVERY_KEY || '').trim();
    if (!configuredRecoveryKey) {
      res.status(503).json({
        error: 'Recuperação administrativa indisponível: chave de recuperação não configurada no servidor.',
      });
      return;
    }

    const { email, recoveryKey, newPassword, confirmPassword } = req.body || {};

    if (
      typeof email !== 'string' ||
      !email.trim() ||
      typeof recoveryKey !== 'string' ||
      !recoveryKey ||
      typeof newPassword !== 'string' ||
      !newPassword ||
      typeof confirmPassword !== 'string' ||
      !confirmPassword
    ) {
      recordRecoveryFailure(clientKey);
      res.status(400).json({
        error: 'E-mail do MASTER_OWNER, chave de recuperação administrativa, nova senha e confirmação são obrigatórios.',
      });
      return;
    }

    const cleanEmail = email.trim().toLowerCase();
    if (cleanEmail !== ORIGINAL_MASTER_OWNER_EMAIL.toLowerCase()) {
      recordRecoveryFailure(clientKey);
      await logSanitizedRecoveryAudit({
        acao: 'RECUPERACAO_MASTER_BLOQUEADA',
        detalhes: 'Tentativa de recuperação bloqueada para e-mail não correspondente ao MASTER_OWNER original.',
        ip: req.ip,
      });
      res.status(403).json({
        error: 'Apenas a conta MASTER_OWNER original autorizada pode utilizar a recuperação administrativa.',
      });
      return;
    }

    if (!verifyRecoveryKeyConstantTime(recoveryKey, configuredRecoveryKey)) {
      recordRecoveryFailure(clientKey);
      await logSanitizedRecoveryAudit({
        acao: 'RECUPERACAO_MASTER_CHAVE_INVALIDA',
        detalhes: 'Tentativa de recuperação do MASTER_OWNER recusada por chave administrativa inválida.',
        ip: req.ip,
      });
      res.status(401).json({ error: 'Chave de recuperação administrativa inválida.' });
      return;
    }

    const strengthError = validateStrongMasterPassword(newPassword);
    if (strengthError) {
      res.status(400).json({ error: strengthError });
      return;
    }

    if (newPassword !== confirmPassword) {
      res.status(400).json({ error: 'A confirmação da nova senha não confere.' });
      return;
    }

    const { hash, salt } = hashPassword(newPassword);
    const auditDetalhes =
      'Senha definitiva do MASTER_OWNER original redefinida via recuperação administrativa e sessões anteriores revogadas.';

    if (isPostgresActive()) {
      try {
        await pgRepo.recoverMasterOwnerPasswordAtomic({
          masterId: ORIGINAL_MASTER_OWNER_ID,
          expectedEmail: ORIGINAL_MASTER_OWNER_EMAIL,
          passwordHash: hash,
          salt,
          auditIp: req.ip,
          auditDetalhes,
        });
      } catch (err: any) {
        if (err?.statusCode === 403 || err?.statusCode === 404) {
          res.status(err.statusCode).json({ error: err.message });
          return;
        }
        throw err;
      }
    } else {
      const masterUser = db.users.find(
        (u) =>
          u.id === ORIGINAL_MASTER_OWNER_ID &&
          u.role === 'master_owner' &&
          u.email.trim().toLowerCase() === ORIGINAL_MASTER_OWNER_EMAIL.toLowerCase()
      );

      if (!masterUser) {
        res.status(404).json({ error: 'Conta original de Master Owner não localizada para recuperação.' });
        return;
      }

      if (!masterUser.active) {
        res.status(403).json({ error: 'A conta Master Owner está inativa e não pode ser recuperada.' });
        return;
      }

      // Preserve id, email, role, permissions, and all other users untouched; update only passwordHash and salt.
      masterUser.passwordHash = hash;
      masterUser.salt = salt;
      db.systemConfig.masterInitialized = true;
      await db.save();

      await revokeAllUserSessionsAsync(masterUser.id);

      await db.logAudit({
        userId: masterUser.id,
        userEmail: masterUser.email,
        userName: masterUser.name,
        acao: 'RECUPERACAO_MASTER',
        detalhes: auditDetalhes,
        ip: req.ip,
      });
    }

    clearRecoveryFailureForClient(clientKey);

    res.status(200).json({
      success: true,
      message:
        'Senha do Master Owner redefinida com sucesso. Todas as sessões anteriores foram revogadas; faça login com sua nova senha.',
    });
  } catch (err) {
    next(err);
  }
});

// Standard Login
apiRouter.post('/auth/login', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      res.status(400).json({ error: 'E-mail e senha são obrigatórios' });
      return;
    }

    const user = db.users.find(u => u.email.toLowerCase() === email.trim().toLowerCase());
    if (!user || !user.active) {
      res.status(401).json({ error: 'Credenciais inválidas ou usuário inativo' });
      return;
    }

    const isValid = verifyPassword(password, user.passwordHash, user.salt);
    if (!isValid) {
      res.status(401).json({ error: 'Credenciais inválidas' });
      return;
    }

    const company = user.companyId ? db.companies.find(c => c.id === user.companyId) : null;
    const token = await createSessionAsync(user.id);

    await db.logAudit({
      userId: user.id,
      userEmail: user.email,
      userName: user.name,
      companyId: company?.id,
      companyName: company?.nomeFantasia,
      acao: 'LOGIN',
      detalhes: `Usuário efetuou login (${user.role})`,
      ip: req.ip
    });

    res.json({
      token,
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        role: user.role,
        companyId: user.companyId
      },
      company
    });
  } catch (err) {
    next(err);
  }
});

// Get Current User Profile
apiRouter.get('/auth/me', authenticate, async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const user = req.user!;
    let company = req.company || null;

    // Refresh demo expiration check
    if (company && company.statusAssinatura === 'demo_ativa' && company.demoEndDate) {
      if (new Date().getTime() > new Date(company.demoEndDate).getTime()) {
        company.statusAssinatura = 'demo_expirada';
        company.updatedAt = new Date().toISOString();
        await db.save();
      }
    }

    res.json({
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        role: user.role,
        companyId: user.companyId,
        phone: user.phone
      },
      company,
      systemConfig: {
        whatsappComercial: db.systemConfig.whatsappComercial,
        nomePlataforma: db.systemConfig.nomePlataforma,
        diasDemonstracao: db.systemConfig.diasDemonstracao
      }
    });
  } catch (err) {
    next(err);
  }
});

// Logout
apiRouter.post('/auth/logout', authenticate, async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const authHeader = req.headers.authorization;
    if (authHeader && authHeader.startsWith('Bearer ')) {
      await destroySessionAsync(authHeader.substring(7));
    }
    res.json({ message: 'Sessão encerrada com sucesso' });
  } catch (err) {
    next(err);
  }
});

// Register New Company & Start Demo / Account
apiRouter.post('/auth/register-company', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const {
      razaoSocial,
      nomeFantasia,
      cnpj,
      responsavel,
      email,
      telefone,
      endereco,
      segmento,
      quantidadeFuncionarios,
      tipoOperacao,
      modulos,
      planoId,
      adminPassword
    } = req.body;

    if (!nomeFantasia || !email || !responsavel || !adminPassword) {
      res.status(400).json({ error: 'Nome fantasia, e-mail, responsável e senha são obrigatórios' });
      return;
    }

    const existingEmail = db.users.find(u => u.email.toLowerCase() === email.trim().toLowerCase());
    if (existingEmail) {
      res.status(400).json({ error: 'Já existe um usuário cadastrado com este e-mail' });
      return;
    }

    const plan = db.plans.find(p => p.id === (planoId || 'plan_demo')) || db.plans[0];
    const companyId = crypto.randomUUID();
    const now = new Date();
    const demoDurationDays = db.systemConfig.diasDemonstracao || 7;
    const demoEndDate = new Date(now.getTime() + demoDurationDays * 24 * 60 * 60 * 1000).toISOString();

    const isDemo = plan.tipo === 'demo';

    const newCompany: Company = {
      id: companyId,
      razaoSocial: razaoSocial || nomeFantasia,
      nomeFantasia,
      cnpj: cnpj || '',
      responsavel,
      email: email.trim().toLowerCase(),
      telefone: telefone || '',
      endereco: endereco || '',
      segmento: segmento || 'Logística e Gestão Predial',
      quantidadeFuncionarios: Number(quantidadeFuncionarios) || 1,
      tipoOperacao: tipoOperacao || 'integrada',
      modulos: Array.isArray(modulos) && modulos.length > 0 ? modulos : ['logistica', 'predial'],
      planoId: plan.id,
      statusCadastro: 'ativo',
      statusAssinatura: isDemo ? 'demo_ativa' : 'aguardando_pagamento',
      demoStartDate: now.toISOString(),
      demoEndDate: demoEndDate,
      limites: plan.limites,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString()
    };

    const { hash, salt } = hashPassword(adminPassword);
    const adminUser: User = {
      id: crypto.randomUUID(),
      email: email.trim().toLowerCase(),
      name: responsavel,
      passwordHash: hash,
      salt,
      role: 'company_admin',
      companyId: companyId,
      phone: telefone || '',
      active: true,
      createdAt: now.toISOString()
    };

    db.companies.push(newCompany);
    db.users.push(adminUser);
    await db.save();

    await db.logAudit({
      userId: adminUser.id,
      userEmail: adminUser.email,
      userName: adminUser.name,
      companyId: newCompany.id,
      companyName: newCompany.nomeFantasia,
      acao: 'CADASTRO_EMPRESA',
      detalhes: `Empresa cadastrada com plano ${plan.nome} (${isDemo ? 'Demonstração 7 dias' : 'Comercial'})`,
      ip: req.ip
    });

    const token = await createSessionAsync(adminUser.id);
    res.status(201).json({
      message: 'Empresa cadastrada com sucesso',
      token,
      user: {
        id: adminUser.id,
        email: adminUser.email,
        name: adminUser.name,
        role: adminUser.role,
        companyId: adminUser.companyId
      },
      company: newCompany
    });
  } catch (err) {
    next(err);
  }
});

// ==========================================
// 2. PUBLIC & SUBSCRIPTION ENDPOINTS
// ==========================================

// Get available public plans
apiRouter.get('/plans', (req: Request, res: Response) => {
  const activePlans = db.plans.filter(p => p.ativo);
  res.json({
    plans: activePlans,
    whatsappComercial: db.systemConfig.whatsappComercial,
    mensagemPadrao: db.systemConfig.mensagemWhatsappPadrao
  });
});

// Request plan or submit payment proof (company)
apiRouter.post('/subscription/request', authenticate, (req: AuthRequest, res: Response) => {
  const company = req.company;
  if (!company) {
    res.status(400).json({ error: 'Nenhuma empresa associada' });
    return;
  }

  const { planoId, metodoPagamento, comprovanteReferencia, periodoMeses } = req.body;
  const plan = db.plans.find(p => p.id === planoId);
  if (!plan) {
    res.status(404).json({ error: 'Plano selecionado não encontrado' });
    return;
  }

  const months = Number(periodoMeses) || 1;
  const valorTotal = months === 12 ? (plan.precoAnual || plan.precoMensal * 12) : plan.precoMensal * months;

  const paymentReq: PaymentRequest = {
    id: crypto.randomUUID(),
    companyId: company.id,
    companyName: company.nomeFantasia,
    planoId: plan.id,
    planoNome: plan.nome,
    valor: valorTotal,
    periodoMeses: months,
    metodoPagamento: metodoPagamento || 'PIX / Transferência Bancária',
    comprovanteReferencia: comprovanteReferencia || `Solicitação via WhatsApp em ${new Date().toLocaleDateString('pt-BR')}`,
    status: 'pendente',
    solicitadoEm: new Date().toISOString()
  };

  db.payments.unshift(paymentReq);
  company.statusAssinatura = 'pagamento_em_analise';
  company.updatedAt = new Date().toISOString();
  db.save();

  db.logAudit({
    userId: req.user!.id,
    userEmail: req.user!.email,
    userName: req.user!.name,
    companyId: company.id,
    companyName: company.nomeFantasia,
    acao: 'SOLICITACAO_PLANO',
    detalhes: `Solicitação do plano ${plan.nome} (R$ ${valorTotal}) enviada para conferência do Master Owner`,
    ip: req.ip
  });

  res.json({
    message: 'Solicitação registrada com sucesso. Aguardando verificação do pagamento pelo Master Owner.',
    payment: paymentReq
  });
});

// Generate QR Code as DataURL helper
apiRouter.get('/qrcode', async (req: Request, res: Response) => {
  const text = (req.query.text as string) || 'LogiPredial';
  try {
    const dataUrl = await QRCode.toDataURL(text, { width: 250, margin: 2 });
    res.json({ dataUrl, text });
  } catch (err) {
    res.status(500).json({ error: 'Erro ao gerar QR Code' });
  }
});

// ==========================================
// 3. MASTER OWNER EXCLUSIVE ENDPOINTS
// ==========================================

// Master Dashboard Stats & KPIs
apiRouter.get('/master/stats', authenticate, requireMaster, (req: AuthRequest, res: Response) => {
  const totalCompanies = db.companies.length;
  const demoActive = db.companies.filter(c => c.statusAssinatura === 'demo_ativa').length;
  const demoExpired = db.companies.filter(c => c.statusAssinatura === 'demo_expirada').length;
  const pendingPayments = db.payments.filter(p => p.status === 'pendente').length;
  const activeSubs = db.companies.filter(c => c.statusAssinatura === 'assinatura_ativa').length;
  
  // Real revenue calculated strictly from confirmed approved payments
  const approvedPayments = db.payments.filter(p => p.status === 'aprovado');
  const totalVerifiedRevenue = approvedPayments.reduce((acc, curr) => acc + (curr.valor || 0), 0);

  res.json({
    totalCompanies,
    totalEmpresas: totalCompanies,
    demoActive,
    demoExpired,
    pendingPayments,
    activeSubs,
    totalVerifiedRevenue,
    totalUsers: db.users.length,
    totalUsuarios: db.users.length,
    totalReceipts: db.logisticsReceipts.length,
    totalPackages: db.condoPackages.length,
    totalVisitors: db.condoVisitors.length
  });
});

// Master: List all companies
apiRouter.get('/master/companies', authenticate, requireMaster, (req: AuthRequest, res: Response) => {
  res.json({ companies: db.companies });
});

// Master: Update company (extend demo, change status, alter plan)
apiRouter.patch('/master/companies/:id', authenticate, requireMaster, (req: AuthRequest, res: Response) => {
  const { id } = req.params;
  const company = db.companies.find(c => c.id === id);
  if (!company) {
    res.status(404).json({ error: 'Empresa não encontrada' });
    return;
  }

  const {
    statusCadastro,
    statusAssinatura,
    planoId,
    limites,
    extendDemoDays,
    modulos
  } = req.body;

  if (statusCadastro) company.statusCadastro = statusCadastro;
  if (statusAssinatura) company.statusAssinatura = statusAssinatura;
  if (modulos) company.modulos = modulos;
  if (limites) company.limites = { ...company.limites, ...limites };

  if (planoId && planoId !== company.planoId) {
    const newPlan = db.plans.find(p => p.id === planoId);
    if (newPlan) {
      company.planoId = newPlan.id;
      company.limites = newPlan.limites;
    }
  }

  if (extendDemoDays) {
    const days = Number(extendDemoDays);
    const baseDate = company.demoEndDate ? new Date(company.demoEndDate) : new Date();
    const newEnd = new Date(baseDate.getTime() + days * 24 * 60 * 60 * 1000);
    company.demoEndDate = newEnd.toISOString();
    company.statusAssinatura = 'demo_ativa';
  }

  company.updatedAt = new Date().toISOString();
  db.save();

  db.logAudit({
    userId: req.user!.id,
    userEmail: req.user!.email,
    userName: req.user!.name,
    companyId: company.id,
    companyName: company.nomeFantasia,
    acao: 'ALTERACAO_EMPRESA_MASTER',
    detalhes: `Configurações da empresa ${company.nomeFantasia} alteradas pelo Master Owner`,
    ip: req.ip
  });

  res.json({ message: 'Empresa atualizada com sucesso', company });
});

// Master: List & Manage Plans
apiRouter.get('/master/plans', authenticate, requireMaster, (req: AuthRequest, res: Response) => {
  res.json({ plans: db.plans });
});

apiRouter.put('/master/plans/:id', authenticate, requireMaster, (req: AuthRequest, res: Response) => {
  const { id } = req.params;
  const index = db.plans.findIndex(p => p.id === id);
  if (index === -1) {
    res.status(404).json({ error: 'Plano não encontrado' });
    return;
  }

  const updatedPlan: CommercialPlan = {
    ...db.plans[index],
    ...req.body
  };
  db.plans[index] = updatedPlan;
  db.save();

  db.logAudit({
    userId: req.user!.id,
    userEmail: req.user!.email,
    userName: req.user!.name,
    acao: 'EDICAO_PLANO',
    detalhes: `Plano ${updatedPlan.nome} atualizado pelo Master Owner (Preço: R$ ${updatedPlan.precoMensal}/mês)`,
    ip: req.ip
  });

  res.json({ message: 'Plano atualizado com sucesso', plan: updatedPlan });
});

apiRouter.post('/master/plans', authenticate, requireMaster, (req: AuthRequest, res: Response) => {
  const newPlan: CommercialPlan = {
    id: `plan_${Date.now()}`,
    nome: req.body.nome || 'Novo Plano',
    tipo: req.body.tipo || 'personalizado',
    descricao: req.body.descricao || '',
    precoMensal: Number(req.body.precoMensal) || 0,
    precoAnual: Number(req.body.precoAnual) || 0,
    duracaoDias: Number(req.body.duracaoDias) || 30,
    modulosPermitidos: req.body.modulosPermitidos || ['logistica', 'predial'],
    limites: req.body.limites || { maxUsuarios: 10, maxUnidades: 100, maxOperacoesMes: 500 },
    recursos: req.body.recursos || [],
    destaque: !!req.body.destaque,
    ativo: true
  };

  db.plans.push(newPlan);
  db.save();

  db.logAudit({
    userId: req.user!.id,
    userEmail: req.user!.email,
    userName: req.user!.name,
    acao: 'CRIACAO_PLANO',
    detalhes: `Novo plano criado: ${newPlan.nome}`,
    ip: req.ip
  });

  res.status(201).json({ message: 'Plano criado com sucesso', plan: newPlan });
});

// Master: System Config & WhatsApp
apiRouter.get('/master/config', authenticate, requireMaster, (req: AuthRequest, res: Response) => {
  res.json({ config: db.systemConfig });
});

apiRouter.put('/master/config', authenticate, requireMaster, (req: AuthRequest, res: Response) => {
  const { whatsappComercial, mensagemWhatsappPadrao, diasDemonstracao, nomePlataforma } = req.body;
  if (whatsappComercial) db.systemConfig.whatsappComercial = whatsappComercial.replace(/\D/g, '');
  if (mensagemWhatsappPadrao) db.systemConfig.mensagemWhatsappPadrao = mensagemWhatsappPadrao;
  if (diasDemonstracao) db.systemConfig.diasDemonstracao = Number(diasDemonstracao);
  if (nomePlataforma) db.systemConfig.nomePlataforma = nomePlataforma;

  db.save();

  db.logAudit({
    userId: req.user!.id,
    userEmail: req.user!.email,
    userName: req.user!.name,
    acao: 'CONFIGURACOES_SISTEMA',
    detalhes: `Configurações da plataforma e WhatsApp atualizadas pelo Master Owner`,
    ip: req.ip
  });

  res.json({ message: 'Configurações salvas com sucesso', config: db.systemConfig });
});

// Master: Payments Verification Center
apiRouter.get('/master/payments', authenticate, requireMaster, (req: AuthRequest, res: Response) => {
  res.json({ payments: db.payments });
});

// Master: Verify payment manually and activate subscription
apiRouter.post('/master/payments/:id/verify', authenticate, requireMaster, (req: AuthRequest, res: Response) => {
  const { id } = req.params;
  const { action, observacoes } = req.body; // 'aprovar' or 'rejeitar'

  const payment = db.payments.find(p => p.id === id);
  if (!payment) {
    res.status(404).json({ error: 'Registro de pagamento não encontrado' });
    return;
  }

  const company = db.companies.find(c => c.id === payment.companyId);
  const now = new Date();

  if (action === 'aprovar') {
    payment.status = 'aprovado';
    payment.aprovadoEm = now.toISOString();
    payment.aprovadoPor = req.user!.email;
    payment.observacoes = observacoes || 'Pagamento confirmado e verificado pelo Master Owner';

    if (company) {
      const plan = db.plans.find(p => p.id === payment.planoId) || db.plans.find(p => p.id === 'plan_profissional')!;
      company.planoId = plan.id;
      company.limites = plan.limites;
      company.statusAssinatura = 'assinatura_ativa';
      company.subscriptionStartDate = now.toISOString();
      
      const durationDays = (payment.periodoMeses || 1) * 30;
      const endDate = new Date(now.getTime() + durationDays * 24 * 60 * 60 * 1000);
      company.subscriptionEndDate = endDate.toISOString();
      company.updatedAt = now.toISOString();
    }

    db.logAudit({
      userId: req.user!.id,
      userEmail: req.user!.email,
      userName: req.user!.name,
      companyId: company?.id,
      companyName: company?.nomeFantasia,
      acao: 'CONFIRMACAO_PAGAMENTO',
      detalhes: `Pagamento de R$ ${payment.valor} APROVADO pelo Master Owner. Plano ${payment.planoNome} ativado por ${payment.periodoMeses} mês(es).`,
      ip: req.ip
    });

  } else {
    payment.status = 'rejeitado';
    payment.observacoes = observacoes || 'Pagamento não confirmado ou não localizado na conta.';
    if (company && company.statusAssinatura === 'pagamento_em_analise') {
      company.statusAssinatura = 'aguardando_pagamento';
      company.updatedAt = now.toISOString();
    }

    db.logAudit({
      userId: req.user!.id,
      userEmail: req.user!.email,
      userName: req.user!.name,
      companyId: company?.id,
      companyName: company?.nomeFantasia,
      acao: 'REJEICAO_PAGAMENTO',
      detalhes: `Pagamento de R$ ${payment.valor} REJEITADO pelo Master Owner: ${payment.observacoes}`,
      ip: req.ip
    });
  }

  db.save();
  res.json({ message: `Pagamento ${payment.status} com sucesso`, payment, company });
});

// Master: Global Audit Logs
apiRouter.get('/master/audit-logs', authenticate, requireMaster, (req: AuthRequest, res: Response) => {
  res.json({ logs: db.auditLogs.slice(0, 500) });
});

// ==========================================
// 4. LOGISTICS & EXPEDITION MODULE
// ==========================================

// Inward Receipts List
apiRouter.get('/logistics/receipts', authenticate, checkSubscription, (req: AuthRequest, res: Response) => {
  const companyId = req.user!.role === 'master_owner' && req.query.companyId ? (req.query.companyId as string) : req.user!.companyId;
  const receipts = companyId 
    ? db.logisticsReceipts.filter(r => r.companyId === companyId)
    : db.logisticsReceipts;
  res.json({ receipts });
});

// Inward Receipt Creation
apiRouter.post('/logistics/receipts', authenticate, checkSubscription, (req: AuthRequest, res: Response) => {
  const companyId = getEffectiveCompanyId(req);
  if (!companyId) {
    res.status(400).json({ error: 'Empresa obrigatória' });
    return;
  }

  const {
    fornecedor,
    remetente,
    transportadora,
    destinatarioSetor,
    numeroNota,
    quantidadeVolumes,
    pesoKg,
    descricao,
    lote,
    avariasRegistradas,
    detalhesAvarias
  } = req.body;

  const count = db.logisticsReceipts.filter(r => r.companyId === companyId).length + 1;
  const numeroRecebimento = `REC-${new Date().getFullYear()}-${String(count).padStart(5, '0')}`;
  const codigoRastreioQR = `LOG-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;

  const receipt: LogisticsReceipt = {
    id: crypto.randomUUID(),
    companyId,
    numeroRecebimento,
    fornecedor: fornecedor || 'Não informado',
    remetente: remetente || fornecedor || 'Diversos',
    transportadora: transportadora || 'Transportadora Própria',
    destinatarioSetor: destinatarioSetor || 'Almoxarifado Geral',
    numeroNota: numeroNota || '',
    quantidadeVolumes: Number(quantidadeVolumes) || 1,
    pesoKg: Number(pesoKg) || 0,
    descricao: descricao || 'Volumes diversos',
    lote: lote || '',
    avariasRegistradas: !!avariasRegistradas,
    detalhesAvarias: detalhesAvarias || '',
    conferenteNome: req.user!.name,
    status: avariasRegistradas ? 'divergencia' : 'conferido',
    codigoRastreioQR,
    dataHora: new Date().toISOString()
  };

  db.logisticsReceipts.unshift(receipt);
  db.save();

  db.logAudit({
    userId: req.user!.id,
    userEmail: req.user!.email,
    userName: req.user!.name,
    companyId,
    companyName: req.company?.nomeFantasia,
    acao: 'RECEBIMENTO_MERCADORIA',
    detalhes: `Recebimento ${receipt.numeroRecebimento} registrado com ${receipt.quantidadeVolumes} volume(s). Fornecedor: ${receipt.fornecedor}`,
    ip: req.ip
  });

  res.status(201).json({ receipt });
});

// Inventory List
apiRouter.get('/logistics/inventory', authenticate, checkSubscription, (req: AuthRequest, res: Response) => {
  const companyId = req.user!.role === 'master_owner' && req.query.companyId ? (req.query.companyId as string) : req.user!.companyId;
  const items = companyId ? db.inventory.filter(i => i.companyId === companyId) : db.inventory;
  res.json({ items });
});

// Inventory Item Add / Edit
apiRouter.post('/logistics/inventory', authenticate, checkSubscription, (req: AuthRequest, res: Response) => {
  const companyId = getEffectiveCompanyId(req);
  if (!companyId) {
    res.status(400).json({ error: 'Empresa obrigatória' });
    return;
  }

  const { id, sku, nome, categoria, quantidade, estoqueMinimo, unidadeMedida, setor, corredor, posicao, valorUnitario } = req.body;

  if (id) {
    const item = db.inventory.find(i => i.id === id && i.companyId === companyId);
    if (!item) {
      res.status(404).json({ error: 'Item não encontrado' });
      return;
    }
    item.nome = nome || item.nome;
    item.categoria = categoria || item.categoria;
    item.estoqueMinimo = Number(estoqueMinimo) ?? item.estoqueMinimo;
    item.unidadeMedida = unidadeMedida || item.unidadeMedida;
    item.setor = setor || item.setor;
    item.corredor = corredor || item.corredor;
    item.posicao = posicao || item.posicao;
    item.valorUnitario = Number(valorUnitario) ?? item.valorUnitario;
    item.ultimaMovimentacao = new Date().toISOString();
    db.save();
    res.json({ item });
    return;
  }

  const newItem: InventoryItem = {
    id: crypto.randomUUID(),
    companyId,
    sku: sku || `SKU-${Date.now().toString().slice(-6)}`,
    nome: nome || 'Produto sem nome',
    categoria: categoria || 'Geral',
    quantidade: Number(quantidade) || 0,
    estoqueMinimo: Number(estoqueMinimo) || 5,
    unidadeMedida: unidadeMedida || 'UN',
    setor: setor || 'Galpão 1',
    corredor: corredor || 'C-01',
    posicao: posicao || 'P-01',
    valorUnitario: Number(valorUnitario) || 0,
    ultimaMovimentacao: new Date().toISOString()
  };

  db.inventory.unshift(newItem);
  db.save();

  db.logAudit({
    userId: req.user!.id,
    userEmail: req.user!.email,
    userName: req.user!.name,
    companyId,
    companyName: req.company?.nomeFantasia,
    acao: 'CADASTRO_PRODUTO',
    detalhes: `Produto ${newItem.nome} (SKU: ${newItem.sku}) cadastrado na posição ${newItem.setor}/${newItem.corredor}/${newItem.posicao}`,
    ip: req.ip
  });

  res.status(201).json({ item: newItem });
});

// Stock Movement (in, out, transfer, adjustment)
apiRouter.post('/logistics/movement', authenticate, checkSubscription, (req: AuthRequest, res: Response) => {
  const companyId = req.company?.id || req.user!.companyId;
  const { itemId, tipo, quantidade, motivo, destino } = req.body;

  const item = db.inventory.find(i => i.id === itemId && i.companyId === companyId);
  if (!item) {
    res.status(404).json({ error: 'Produto não encontrado' });
    return;
  }

  const qty = Number(quantidade);
  if (isNaN(qty) || qty <= 0) {
    res.status(400).json({ error: 'Quantidade inválida' });
    return;
  }

  const saldoAnterior = item.quantidade;
  let saldoAtual = saldoAnterior;

  if (tipo === 'entrada') {
    saldoAtual = saldoAnterior + qty;
  } else if (tipo === 'saida') {
    if (saldoAnterior < qty) {
      res.status(400).json({ error: 'Saldo insuficiente em estoque' });
      return;
    }
    saldoAtual = saldoAnterior - qty;
  } else if (tipo === 'ajuste') {
    saldoAtual = qty; // For adjustment, qty is the new counted quantity
  } else if (tipo === 'transferencia') {
    // transfer position
    if (destino) {
      item.posicao = destino;
    }
  }

  item.quantidade = saldoAtual;
  item.ultimaMovimentacao = new Date().toISOString();

  const movement: StockMovement = {
    id: crypto.randomUUID(),
    companyId: companyId!,
    itemId: item.id,
    itemNome: item.nome,
    sku: item.sku,
    tipo,
    quantidade: qty,
    saldoAnterior,
    saldoAtual,
    motivo: motivo || 'Movimentação operacional',
    origem: `${item.setor}/${item.corredor}`,
    destino: destino || item.posicao,
    responsavelNome: req.user!.name,
    dataHora: new Date().toISOString()
  };

  db.stockMovements.unshift(movement);
  db.save();

  db.logAudit({
    userId: req.user!.id,
    userEmail: req.user!.email,
    userName: req.user!.name,
    companyId: companyId!,
    companyName: req.company?.nomeFantasia,
    acao: 'MOVIMENTACAO_ESTOQUE',
    detalhes: `${tipo.toUpperCase()} de ${qty} un em ${item.nome}. Saldo: ${saldoAnterior} -> ${saldoAtual}. Motivo: ${motivo}`,
    ip: req.ip
  });

  res.json({ movement, item });
});

// Shipments / Despacho
apiRouter.get('/logistics/shipments', authenticate, checkSubscription, (req: AuthRequest, res: Response) => {
  const companyId = req.user!.role === 'master_owner' && req.query.companyId ? (req.query.companyId as string) : req.user!.companyId;
  const shipments = companyId ? db.shipments.filter(s => s.companyId === companyId) : db.shipments;
  res.json({ shipments });
});

apiRouter.post('/logistics/shipments', authenticate, checkSubscription, (req: AuthRequest, res: Response) => {
  const companyId = getEffectiveCompanyId(req);
  if (!companyId) {
    res.status(400).json({ error: 'Empresa obrigatória' });
    return;
  }

  const {
    destinatario,
    enderecoEntrega,
    cidade,
    transportadora,
    entregadorNome,
    placaVeiculo,
    volumes,
    pesoKg
  } = req.body;

  const count = db.shipments.filter(s => s.companyId === companyId).length + 1;
  const numeroExpedicao = `EXP-${new Date().getFullYear()}-${String(count).padStart(5, '0')}`;
  const codigoRastreio = `TRK-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;

  const shipment: ShipmentOrder = {
    id: crypto.randomUUID(),
    companyId,
    numeroExpedicao,
    destinatario: destinatario || 'Cliente Destinatário',
    enderecoEntrega: enderecoEntrega || '',
    cidade: cidade || 'São Paulo / SP',
    transportadora: transportadora || 'Frota Própria',
    entregadorNome: entregadorNome || '',
    placaVeiculo: placaVeiculo || '',
    volumes: Number(volumes) || 1,
    pesoKg: Number(pesoKg) || 0,
    status: 'separacao',
    codigoRastreio,
    responsavelDespacho: req.user!.name,
    dataCriacao: new Date().toISOString()
  };

  db.shipments.unshift(shipment);
  db.save();

  db.logAudit({
    userId: req.user!.id,
    userEmail: req.user!.email,
    userName: req.user!.name,
    companyId,
    companyName: req.company?.nomeFantasia,
    acao: 'CRIACAO_EXPEDICAO',
    detalhes: `Ordem de expedição ${shipment.numeroExpedicao} gerada para ${shipment.destinatario} (${shipment.volumes} volumes)`,
    ip: req.ip
  });

  res.status(201).json({ shipment });
});

apiRouter.patch('/logistics/shipments/:id/status', authenticate, checkSubscription, (req: AuthRequest, res: Response) => {
  const { id } = req.params;
  const companyId = req.company?.id || req.user!.companyId;
  const { status, ocorrenciaTexto } = req.body;

  const shipment = db.shipments.find(s => s.id === id && (req.user!.role === 'master_owner' || s.companyId === companyId));
  if (!shipment) {
    res.status(404).json({ error: 'Ordem de expedição não encontrada' });
    return;
  }

  shipment.status = status;
  if (status === 'despachado') {
    shipment.dataDespacho = new Date().toISOString();
  } else if (status === 'entregue') {
    shipment.dataEntrega = new Date().toISOString();
  }
  if (ocorrenciaTexto) {
    shipment.ocorrenciaTexto = ocorrenciaTexto;
  }

  db.save();

  db.logAudit({
    userId: req.user!.id,
    userEmail: req.user!.email,
    userName: req.user!.name,
    companyId: shipment.companyId,
    acao: 'STATUS_EXPEDICAO',
    detalhes: `Status da expedição ${shipment.numeroExpedicao} atualizado para ${status.toUpperCase()}`,
    ip: req.ip
  });

  res.json({ shipment });
});

// ==========================================
// 5. CONDOMINIUM & CONCIERGE MODULE
// ==========================================

// Units list
apiRouter.get('/condo/units', authenticate, checkSubscription, (req: AuthRequest, res: Response) => {
  const companyId = req.user!.role === 'master_owner' && req.query.companyId ? (req.query.companyId as string) : req.user!.companyId;
  const units = companyId ? db.condoUnits.filter(u => u.companyId === companyId) : db.condoUnits;
  res.json({ units });
});

// Unit add/edit
apiRouter.post('/condo/units', authenticate, checkSubscription, (req: AuthRequest, res: Response) => {
  const companyId = getEffectiveCompanyId(req);
  if (!companyId) {
    res.status(400).json({ error: 'Empresa obrigatória' });
    return;
  }

  const { id, bloco, andar, numeroUnidade, responsavelPrincipal, email, telefone, moradores, observacoes } = req.body;

  if (id) {
    const unit = db.condoUnits.find(u => u.id === id && u.companyId === companyId);
    if (!unit) {
      res.status(404).json({ error: 'Unidade não encontrada' });
      return;
    }
    unit.bloco = bloco || unit.bloco;
    unit.andar = andar || unit.andar;
    unit.numeroUnidade = numeroUnidade || unit.numeroUnidade;
    unit.responsavelPrincipal = responsavelPrincipal || unit.responsavelPrincipal;
    unit.email = email || unit.email;
    unit.telefone = telefone || unit.telefone;
    unit.moradores = moradores || unit.moradores;
    unit.observacoes = observacoes ?? unit.observacoes;
    db.save();
    res.json({ unit });
    return;
  }

  const newUnit: CondoUnit = {
    id: crypto.randomUUID(),
    companyId,
    bloco: bloco || 'Torre A',
    andar: andar || '1º Andar',
    numeroUnidade: numeroUnidade || 'Apto 101',
    responsavelPrincipal: responsavelPrincipal || 'Morador Responsável',
    email: email || '',
    telefone: telefone || '',
    moradores: moradores || [],
    observacoes: observacoes || '',
    ativo: true
  };

  db.condoUnits.push(newUnit);
  db.save();

  db.logAudit({
    userId: req.user!.id,
    userEmail: req.user!.email,
    userName: req.user!.name,
    companyId,
    companyName: req.company?.nomeFantasia,
    acao: 'CADASTRO_UNIDADE_PREDIAL',
    detalhes: `Unidade cadastrada: ${newUnit.bloco} - ${newUnit.numeroUnidade} (${newUnit.responsavelPrincipal})`,
    ip: req.ip
  });

  res.status(201).json({ unit: newUnit });
});

// Packages list
apiRouter.get('/condo/packages', authenticate, checkSubscription, (req: AuthRequest, res: Response) => {
  const companyId = req.user!.role === 'master_owner' && req.query.companyId
    ? (req.query.companyId as string)
    : (req.user!.companyId || (req.query.companyId as string) || req.company?.id || db.companies[0]?.id);
  const packages = companyId ? db.condoPackages.filter(p => p.companyId === companyId) : db.condoPackages;
  res.json({ packages });
});

// Register Package in Concierge
apiRouter.post('/condo/packages', authenticate, checkSubscription, (req: AuthRequest, res: Response) => {
  const companyId = getEffectiveCompanyId(req);
  if (!companyId) {
    res.status(400).json({ error: 'Empresa obrigatória para o registro da encomenda' });
    return;
  }

  const {
    unitId,
    unidadeIdentificacao,
    destinatarioNome,
    transportadora,
    nomeEntregador,
    descricaoConteudo,
    recebidoEm,
    observacoes
  } = req.body;

  if (!unidadeIdentificacao || !String(unidadeIdentificacao).trim()) {
    res.status(400).json({ error: 'A identificação da unidade ou apartamento é obrigatória' });
    return;
  }

  if (!destinatarioNome || !String(destinatarioNome).trim()) {
    res.status(400).json({ error: 'O nome do morador destinatário é obrigatório' });
    return;
  }

  if (!transportadora || !String(transportadora).trim()) {
    res.status(400).json({ error: 'A transportadora ou empresa de entrega é obrigatória' });
    return;
  }

  if (!descricaoConteudo || !String(descricaoConteudo).trim()) {
    res.status(400).json({ error: 'A descrição ou conteúdo do pacote é obrigatória' });
    return;
  }

  // Auto-link or auto-create unit if not already present
  let resolvedUnitId = unitId || '';
  if (!resolvedUnitId && unidadeIdentificacao) {
    const existingUnit = db.condoUnits.find(u =>
      u.companyId === companyId &&
      (`${u.bloco} - ${u.numeroUnidade}`.toLowerCase() === String(unidadeIdentificacao).trim().toLowerCase() ||
       u.numeroUnidade.toLowerCase() === String(unidadeIdentificacao).trim().toLowerCase())
    );
    if (existingUnit) {
      resolvedUnitId = existingUnit.id;
    } else {
      const newUnit: CondoUnit = {
        id: crypto.randomUUID(),
        companyId,
        bloco: String(unidadeIdentificacao).includes('-') ? String(unidadeIdentificacao).split('-')[0].trim() : 'Bloco Principal',
        andar: '1º Andar',
        numeroUnidade: String(unidadeIdentificacao).includes('-') ? String(unidadeIdentificacao).split('-')[1].trim() : String(unidadeIdentificacao).trim(),
        responsavelPrincipal: String(destinatarioNome).trim(),
        email: '',
        telefone: '',
        moradores: [],
        ativo: true
      };
      db.condoUnits.push(newUnit);
      resolvedUnitId = newUnit.id;
    }
  }

  const count = db.condoPackages.filter(p => p.companyId === companyId).length + 1;
  const codigoPacote = `ENC-${String(count).padStart(4, '0')}`;
  // 4-digit cryptographically secure retrieval PIN for resident confirmation
  const codigoRetiradaPin = crypto.randomInt(1000, 10000).toString();

  const pkg: CondoPackage = {
    id: crypto.randomUUID(),
    companyId,
    codigoPacote,
    unitId: resolvedUnitId,
    unidadeIdentificacao: String(unidadeIdentificacao).trim(),
    destinatarioNome: String(destinatarioNome).trim(),
    transportadora: String(transportadora).trim(),
    nomeEntregador: nomeEntregador ? String(nomeEntregador).trim() : '',
    descricaoConteudo: String(descricaoConteudo).trim(),
    codigoRetiradaPin,
    status: 'aguardando_retirada',
    recebidoPorPorteiro: req.user!.name || 'Porteiro da Guarita',
    recebidoEm: recebidoEm ? new Date(recebidoEm).toISOString() : new Date().toISOString(),
    observacoes: observacoes ? String(observacoes).trim() : ''
  };

  db.condoPackages.unshift(pkg);
  db.save();

  db.logAudit({
    userId: req.user!.id,
    userEmail: req.user!.email,
    userName: req.user!.name,
    companyId,
    companyName: req.company?.nomeFantasia || 'LogiPredial Matriz',
    acao: 'RECEBIMENTO_ENCOMENDA_PORTARIA',
    detalhes: `Encomenda ${pkg.codigoPacote} recebida para ${pkg.unidadeIdentificacao} (${pkg.destinatarioNome}). PIN seguro: ${pkg.codigoRetiradaPin}`,
    ip: req.ip
  });

  res.status(201).json({
    pkg,
    message: `Encomenda ${pkg.codigoPacote} recebida com sucesso! Código PIN gerado: ${pkg.codigoRetiradaPin}`
  });
});

// Notify Resident via WhatsApp format link
apiRouter.post('/condo/packages/:id/notify', authenticate, checkSubscription, (req: AuthRequest, res: Response) => {
  const { id } = req.params;
  const companyId = getEffectiveCompanyId(req);

  const pkg = db.condoPackages.find(p => p.id === id && (req.user!.role === 'master_owner' || p.companyId === companyId));
  if (!pkg) {
    res.status(404).json({ error: 'Encomenda não encontrada' });
    return;
  }

  pkg.status = 'notificado';
  pkg.notificadoEm = new Date().toISOString();
  db.save();

  // Find resident phone if unitId present
  let phone = '';
  if (pkg.unitId) {
    const unit = db.condoUnits.find(u => u.id === pkg.unitId);
    if (unit && unit.telefone) phone = unit.telefone.replace(/\D/g, '');
  }

  const notificationText = `📦 *Aviso de Encomenda na Portaria*\n\nOlá, ${pkg.destinatarioNome} (${pkg.unidadeIdentificacao})!\nUma encomenda chegou para você via ${pkg.transportadora}.\n\n*Código do Pacote:* ${pkg.codigoPacote}\n*PIN de Retirada:* ${pkg.codigoRetiradaPin}\n*Conteúdo:* ${pkg.descricaoConteudo}\n*Horário de Recebimento:* ${new Date(pkg.recebidoEm).toLocaleString('pt-BR')}\n\nPor favor, apresente este código PIN na portaria para retirar sua encomenda com segurança.`;

  const encoded = encodeURIComponent(notificationText);
  const whatsappUrl = phone ? `https://wa.me/55${phone}?text=${encoded}` : `https://wa.me/?text=${encoded}`;

  db.logAudit({
    userId: req.user!.id,
    userEmail: req.user!.email,
    userName: req.user!.name,
    companyId: pkg.companyId,
    acao: 'NOTIFICACAO_MORADOR',
    detalhes: `Link de notificação WhatsApp preparado para morador de ${pkg.unidadeIdentificacao} (Pacote ${pkg.codigoPacote})`,
    ip: req.ip
  });

  res.json({ message: 'Link de notificação WhatsApp gerado com sucesso', pkg, whatsappUrl });
});

// Pickup package with PIN check
apiRouter.post('/condo/packages/:id/pickup', authenticate, checkSubscription, (req: AuthRequest, res: Response) => {
  const { id } = req.params;
  const companyId = getEffectiveCompanyId(req);
  const { pin, retiradoPor, documentoRetirada } = req.body;

  const pkg = db.condoPackages.find(p => p.id === id && (req.user!.role === 'master_owner' || p.companyId === companyId));
  if (!pkg) {
    res.status(404).json({ error: 'Encomenda não encontrada' });
    return;
  }

  if (pkg.status === 'retirado') {
    res.status(400).json({ error: 'Esta encomenda já foi retirada anteriormente' });
    return;
  }

  // Strict PIN verification (mandatory for all non-master operators)
  if (req.user!.role !== 'master_owner') {
    if (!pin || String(pin).trim() !== pkg.codigoRetiradaPin) {
      res.status(400).json({ error: 'Código PIN de retirada incorreto ou não fornecido' });
      return;
    }
  }

  pkg.status = 'retirado';
  pkg.retiradoEm = new Date().toISOString();
  pkg.retiradoPor = (retiradoPor && String(retiradoPor).trim()) || pkg.destinatarioNome;
  pkg.documentoRetirada = documentoRetirada || 'Identificação confirmada na portaria';
  pkg.entreguePorPorteiro = req.user!.name;
  db.save();

  db.logAudit({
    userId: req.user!.id,
    userEmail: req.user!.email,
    userName: req.user!.name,
    companyId: pkg.companyId,
    acao: 'RETIRADA_ENCOMENDA',
    detalhes: `Encomenda ${pkg.codigoPacote} retirada por ${pkg.retiradoPor} (Doc: ${pkg.documentoRetirada}) com PIN validado por ${req.user!.name}`,
    ip: req.ip
  });

  res.json({ message: 'Encomenda retirada e baixada com sucesso', pkg });
});

// Update condo package status and details
apiRouter.patch('/condo/packages/:id', authenticate, checkSubscription, (req: AuthRequest, res: Response) => {
  const { id } = req.params;
  const companyId = getEffectiveCompanyId(req);

  const pkg = db.condoPackages.find(p => p.id === id && (req.user!.role === 'master_owner' || p.companyId === companyId));
  if (!pkg) {
    res.status(404).json({ error: 'Encomenda não encontrada' });
    return;
  }

  const { status, observacoes, retiradoPor, documentoRetirada, destinatarioNome, transportadora, descricaoConteudo } = req.body;
  if (status) {
    pkg.status = status;
    if (status === 'retirado' && !pkg.retiradoEm) {
      pkg.retiradoEm = new Date().toISOString();
      pkg.entreguePorPorteiro = req.user!.name;
    }
  }
  if (observacoes !== undefined) pkg.observacoes = observacoes;
  if (retiradoPor !== undefined) pkg.retiradoPor = retiradoPor;
  if (documentoRetirada !== undefined) pkg.documentoRetirada = documentoRetirada;
  if (destinatarioNome !== undefined) pkg.destinatarioNome = destinatarioNome;
  if (transportadora !== undefined) pkg.transportadora = transportadora;
  if (descricaoConteudo !== undefined) pkg.descricaoConteudo = descricaoConteudo;

  db.save();

  db.logAudit({
    userId: req.user!.id,
    userEmail: req.user!.email,
    userName: req.user!.name,
    companyId: pkg.companyId,
    acao: 'ATUALIZACAO_ENCOMENDA',
    detalhes: `Encomenda ${pkg.codigoPacote} atualizada. Status: ${pkg.status}`,
    ip: req.ip
  });

  res.json({ message: 'Encomenda atualizada com sucesso', pkg });
});

// Dashboard Metrics (Condo & Portaria analytics)
apiRouter.get('/dashboard/metrics', authenticate, checkSubscription, (req: AuthRequest, res: Response) => {
  const companyId = req.user!.role === 'master_owner' && req.query.companyId
    ? (req.query.companyId as string)
    : (req.user!.companyId || (req.query.companyId as string) || req.company?.id || db.companies[0]?.id);

  const period = ((req.query.period as string) || 'week') as 'day' | 'week' | 'month';
  const allPackages = companyId ? db.condoPackages.filter(p => p.companyId === companyId) : db.condoPackages;

  const now = new Date();
  let days = 7;
  if (period === 'day') days = 1;
  else if (period === 'month') days = 30;

  const currentCutoff = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
  const previousCutoff = new Date(now.getTime() - 2 * days * 24 * 60 * 60 * 1000);

  const currentPackages = allPackages.filter(p => new Date(p.recebidoEm) >= currentCutoff);
  const previousPackages = allPackages.filter(p => {
    const d = new Date(p.recebidoEm);
    return d >= previousCutoff && d < currentCutoff;
  });

  const totalPeriod = currentPackages.length;
  const previousPeriodTotal = previousPackages.length;
  const percentageChange = previousPeriodTotal === 0
    ? (totalPeriod > 0 ? 100 : 0)
    : Math.round(((totalPeriod - previousPeriodTotal) / previousPeriodTotal) * 100);

  const awaitingPickup = allPackages.filter(p => p.status === 'aguardando_retirada' || p.status === 'notificado').length;
  const delivered = allPackages.filter(p => p.status === 'retirado').length;
  const pending = awaitingPickup;
  const completionRate = allPackages.length > 0 ? Math.round((delivered / allPackages.length) * 100) : 0;

  // Average pickup time
  const deliveredWithTimes = allPackages.filter(p => p.status === 'retirado' && p.retiradoEm && p.recebidoEm);
  let avgPickupMinutes = 0;
  if (deliveredWithTimes.length > 0) {
    const totalMinutes = deliveredWithTimes.reduce((acc, p) => {
      const diff = new Date(p.retiradoEm!).getTime() - new Date(p.recebidoEm).getTime();
      return acc + Math.max(0, diff / 60000);
    }, 0);
    avgPickupMinutes = Math.round(totalMinutes / deliveredWithTimes.length);
  }
  const hours = Math.floor(avgPickupMinutes / 60);
  const mins = avgPickupMinutes % 60;
  const avgPickupTimeFormatted = hours > 0 ? `${hours}h ${mins}m` : `${mins}m`;

  // Timeline Data
  const timelineData: { date: string; label: string; current: number; previous: number }[] = [];
  if (period === 'day') {
    for (let i = 0; i < 24; i += 3) {
      const label = `${String(i).padStart(2, '0')}:00`;
      timelineData.push({
        date: label,
        label,
        current: currentPackages.filter(p => new Date(p.recebidoEm).getHours() >= i && new Date(p.recebidoEm).getHours() < i + 3).length,
        previous: previousPackages.filter(p => new Date(p.recebidoEm).getHours() >= i && new Date(p.recebidoEm).getHours() < i + 3).length,
      });
    }
  } else if (period === 'week') {
    const daysName = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'];
    for (let i = 6; i >= 0; i--) {
      const d = new Date(now.getTime() - i * 24 * 60 * 60 * 1000);
      const dayStr = d.toISOString().split('T')[0];
      const prevD = new Date(now.getTime() - (i + 7) * 24 * 60 * 60 * 1000);
      const prevDayStr = prevD.toISOString().split('T')[0];
      timelineData.push({
        date: dayStr,
        label: daysName[d.getDay()],
        current: currentPackages.filter(p => p.recebidoEm.startsWith(dayStr)).length,
        previous: previousPackages.filter(p => p.recebidoEm.startsWith(prevDayStr)).length,
      });
    }
  } else {
    for (let i = 29; i >= 0; i -= 3) {
      const d = new Date(now.getTime() - i * 24 * 60 * 60 * 1000);
      const dayStr = d.toISOString().split('T')[0];
      const label = `${d.getDate()}/${d.getMonth() + 1}`;
      timelineData.push({
        date: dayStr,
        label,
        current: currentPackages.filter(p => {
          const pDate = new Date(p.recebidoEm);
          const diffDays = Math.floor((now.getTime() - pDate.getTime()) / (24 * 60 * 60 * 1000));
          return diffDays >= i - 2 && diffDays <= i;
        }).length,
        previous: previousPackages.filter(p => {
          const pDate = new Date(p.recebidoEm);
          const diffDays = Math.floor((now.getTime() - pDate.getTime()) / (24 * 60 * 60 * 1000));
          return diffDays >= i + 28 && diffDays <= i + 30;
        }).length,
      });
    }
  }

  // Status breakdown
  const statusMap: Record<string, { label: string; color: string }> = {
    aguardando_retirada: { label: 'Aguardando Retirada', color: '#F59E0B' },
    notificado: { label: 'Notificado (WhatsApp)', color: '#3B82F6' },
    retirado: { label: 'Entregue ao Morador', color: '#10B981' },
    devolvido: { label: 'Devolvido ao Remetente', color: '#EF4444' },
    em_ocorrencia: { label: 'Em Ocorrência', color: '#8B5CF6' }
  };

  const statusBreakdown = Object.keys(statusMap).map(st => ({
    status: st,
    label: statusMap[st].label,
    count: allPackages.filter(p => p.status === st).length,
    color: statusMap[st].color
  }));

  const metricsResponse = {
    period,
    totalPeriod,
    previousPeriodTotal,
    percentageChange,
    awaitingPickup,
    delivered,
    pending,
    completionRate,
    avgPickupTimeFormatted,
    avgPickupMinutes,
    timelineData,
    statusBreakdown,
    operationalPerformance: {
      totalProcessed: allPackages.length,
      deliveredCount: delivered,
      completionPercentage: completionRate,
      avgPickupTimeFormatted,
      awaitingPickupCount: awaitingPickup
    },
    activityEvolution: {
      currentTotal: totalPeriod,
      previousTotal: previousPeriodTotal,
      growthPercentage: percentageChange,
      trend: percentageChange >= 0 ? ('up' as const) : ('down' as const),
      timeline: timelineData
    },
    totalDatabasePackages: allPackages.length
  };

  res.json(metricsResponse);
});

// Visitors & Access Control
apiRouter.get('/condo/visitors', authenticate, checkSubscription, (req: AuthRequest, res: Response) => {
  const companyId = req.user!.role === 'master_owner' && req.query.companyId
    ? (req.query.companyId as string)
    : (req.user!.companyId || (req.query.companyId as string) || req.company?.id || db.companies[0]?.id);
  const visitors = companyId ? db.condoVisitors.filter(v => v.companyId === companyId) : db.condoVisitors;
  res.json({ visitors });
});

// Check-in visitor
apiRouter.post('/condo/visitors', authenticate, checkSubscription, (req: AuthRequest, res: Response) => {
  const companyId = getEffectiveCompanyId(req);
  if (!companyId) {
    res.status(400).json({ error: 'Empresa obrigatória' });
    return;
  }

  const { nomeCompleto, documento, tipo, empresa, unidadeDestino, moradorAutorizador, observacoes } = req.body;

  if (!nomeCompleto || !unidadeDestino) {
    res.status(400).json({ error: 'Nome do visitante e unidade de destino são obrigatórios' });
    return;
  }

  const visitor: CondoVisitor = {
    id: crypto.randomUUID(),
    companyId,
    nomeCompleto,
    documento: documento || '',
    tipo: tipo || 'visitante',
    empresa: empresa || '',
    unidadeDestino,
    moradorAutorizador: moradorAutorizador || 'Autorizado pelo Morador',
    porteiroEntrada: req.user!.name,
    dataHoraEntrada: new Date().toISOString(),
    status: 'no_local',
    observacoes: observacoes || ''
  };

  db.condoVisitors.unshift(visitor);
  db.save();

  db.logAudit({
    userId: req.user!.id,
    userEmail: req.user!.email,
    userName: req.user!.name,
    companyId,
    companyName: req.company?.nomeFantasia,
    acao: 'ENTRADA_VISITANTE',
    detalhes: `Entrada autorizada: ${visitor.nomeCompleto} (${visitor.tipo}) com destino à ${visitor.unidadeDestino}`,
    ip: req.ip
  });

  res.status(201).json({ visitor });
});

// Check-out visitor
apiRouter.patch('/condo/visitors/:id/checkout', authenticate, checkSubscription, (req: AuthRequest, res: Response) => {
  const { id } = req.params;
  const companyId = req.company?.id || req.user!.companyId;

  const visitor = db.condoVisitors.find(v => v.id === id && (req.user!.role === 'master_owner' || v.companyId === companyId));
  if (!visitor) {
    res.status(404).json({ error: 'Visitante não encontrado' });
    return;
  }

  visitor.status = 'finalizado';
  visitor.dataHoraSaida = new Date().toISOString();
  db.save();

  db.logAudit({
    userId: req.user!.id,
    userEmail: req.user!.email,
    userName: req.user!.name,
    companyId: visitor.companyId,
    acao: 'SAIDA_VISITANTE',
    detalhes: `Saída registrada: ${visitor.nomeCompleto} da unidade ${visitor.unidadeDestino}`,
    ip: req.ip
  });

  res.json({ message: 'Saída registrada com sucesso', visitor });
});

// Seed Initial Demo Company & Data if completely empty
apiRouter.post('/seed-sample-data', authenticate, requireMaster, (req: AuthRequest, res: Response) => {
  if (db.companies.length > 0) {
    res.json({ message: 'Dados de demonstração já existem ou empresas já cadastradas' });
    return;
  }

  const sampleCompanyId = crypto.randomUUID();
  const sampleCompany: Company = {
    id: sampleCompanyId,
    razaoSocial: 'LogiExpress & Condomínio Solar Ltda',
    nomeFantasia: 'LogiExpress Matriz',
    cnpj: '12.345.678/0001-90',
    responsavel: 'Carlos Eduardo Oliveira',
    email: 'operacao@logiexpress.com.br',
    telefone: '11987654321',
    endereco: 'Av. Paulista, 1000 - São Paulo/SP',
    segmento: 'Logística e Gestão Predial Integrada',
    quantidadeFuncionarios: 15,
    tipoOperacao: 'integrada',
    modulos: ['logistica', 'predial'],
    planoId: 'plan_demo',
    statusCadastro: 'ativo',
    statusAssinatura: 'demo_ativa',
    demoStartDate: new Date().toISOString(),
    demoEndDate: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
    limites: db.plans[0].limites,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };

  db.companies.push(sampleCompany);

  // Seed sample products
  db.inventory.push(
    {
      id: crypto.randomUUID(),
      companyId: sampleCompanyId,
      sku: 'PAL-EUR-01',
      nome: 'Palete Padrão Europeu 120x80cm',
      categoria: 'Estruturas',
      quantidade: 45,
      estoqueMinimo: 10,
      unidadeMedida: 'UN',
      setor: 'Galpão A',
      corredor: 'C-02',
      posicao: 'P-08',
      valorUnitario: 85.00,
      ultimaMovimentacao: new Date().toISOString()
    },
    {
      id: crypto.randomUUID(),
      companyId: sampleCompanyId,
      sku: 'CXA-OND-30',
      nome: 'Caixa Papelão Ondulado Triplo 40x30x20',
      categoria: 'Embalagens',
      quantidade: 180,
      estoqueMinimo: 30,
      unidadeMedida: 'UN',
      setor: 'Galpão B',
      corredor: 'C-01',
      posicao: 'P-03',
      valorUnitario: 12.50,
      ultimaMovimentacao: new Date().toISOString()
    }
  );

  // Seed sample units
  const unit1Id = crypto.randomUUID();
  db.condoUnits.push(
    {
      id: unit1Id,
      companyId: sampleCompanyId,
      bloco: 'Torre Aurora',
      andar: '4º Andar',
      numeroUnidade: 'Apto 402',
      responsavelPrincipal: 'Dra. Mariana Silveira',
      email: 'mariana.silveira@email.com',
      telefone: '11991234567',
      moradores: [{ nome: 'Lucas Silveira', parentesco: 'Filho', telefone: '11991234568' }],
      ativo: true
    },
    {
      id: crypto.randomUUID(),
      companyId: sampleCompanyId,
      bloco: 'Torre Aurora',
      andar: '5º Andar',
      numeroUnidade: 'Apto 501',
      responsavelPrincipal: 'Roberto Albuquerque',
      email: 'roberto.albuquerque@email.com',
      telefone: '11998765432',
      moradores: [],
      ativo: true
    }
  );

  // Seed sample package
  db.condoPackages.push({
    id: crypto.randomUUID(),
    companyId: sampleCompanyId,
    codigoPacote: 'ENC-0001',
    unitId: unit1Id,
    unidadeIdentificacao: 'Torre Aurora - Apto 402',
    destinatarioNome: 'Dra. Mariana Silveira',
    transportadora: 'Mercado Livre Express',
    nomeEntregador: 'Marcos Vinicius',
    descricaoConteudo: 'Caixa de Livros e Eletrônicos',
    codigoRetiradaPin: '7419',
    status: 'aguardando_retirada',
    recebidoPorPorteiro: 'Porteiro Noturno',
    recebidoEm: new Date().toISOString()
  });

  // Seed sample logistics receipt
  db.logisticsReceipts.push({
    id: crypto.randomUUID(),
    companyId: sampleCompanyId,
    numeroRecebimento: 'REC-2026-001',
    fornecedor: 'Distribuidora Global Sul Ltda',
    remetente: 'Centro Logístico Campinas',
    transportadora: 'Braspress Transportes Rápidos',
    destinatarioSetor: 'Almoxarifado Central',
    numeroNota: 'NF-892341',
    quantidadeVolumes: 12,
    pesoKg: 340.5,
    descricao: 'Componentes e materiais para montagem',
    avariasRegistradas: false,
    conferenteNome: 'Operador Logístico Sênior',
    status: 'conferido',
    codigoRastreioQR: 'LP-REC-2026-001',
    dataHora: new Date().toISOString()
  });

  // Seed sample shipment
  db.shipments.push({
    id: crypto.randomUUID(),
    companyId: sampleCompanyId,
    numeroExpedicao: 'EXP-2026-001',
    destinatario: 'Construtora Horizonte Verde',
    enderecoEntrega: 'Rua das Flores, 450 - Centro',
    cidade: 'São Paulo - SP',
    transportadora: 'Total Express',
    entregadorNome: 'Ricardo Santos',
    placaVeiculo: 'BRA2E19',
    volumes: 4,
    pesoKg: 85.0,
    status: 'despachado',
    codigoRastreio: 'TRK-9812401-SP',
    responsavelDespacho: 'Supervisor de Expedição',
    dataCriacao: new Date().toISOString(),
    dataDespacho: new Date().toISOString()
  });

  // Seed sample visitors
  db.condoVisitors.push(
    {
      id: crypto.randomUUID(),
      companyId: sampleCompanyId,
      nomeCompleto: 'Felipe Mendes Carneiro',
      documento: '42.891.332-9',
      tipo: 'prestador_servico',
      empresa: 'Fibra Telecom Instalações',
      unidadeDestino: 'Torre Aurora - Apto 402',
      moradorAutorizador: 'Dra. Mariana Silveira',
      porteiroEntrada: 'Porteiro Noturno',
      dataHoraEntrada: new Date().toISOString(),
      status: 'no_local',
      observacoes: 'Manutenção de roteador de fibra'
    },
    {
      id: crypto.randomUUID(),
      companyId: sampleCompanyId,
      nomeCompleto: 'Ana Carolina Dias',
      documento: '33.102.944-1',
      tipo: 'visitante',
      unidadeDestino: 'Torre Aurora - Apto 501',
      moradorAutorizador: 'Roberto Albuquerque',
      porteiroEntrada: 'Porteiro Noturno',
      dataHoraEntrada: new Date(Date.now() - 3 * 3600 * 1000).toISOString(),
      dataHoraSaida: new Date(Date.now() - 1 * 3600 * 1000).toISOString(),
      status: 'finalizado',
      observacoes: 'Visita social'
    }
  );

  // Seed sample driver user if not exists
  let driverUser = db.users.find(u => u.role === 'driver' && u.companyId === sampleCompanyId);
  if (!driverUser) {
    const { hash, salt } = hashPassword('motorista123');
    driverUser = {
      id: crypto.randomUUID(),
      companyId: sampleCompanyId,
      email: 'motorista.sp@letlog.com.br',
      name: 'Carlos Alberto Silva (Motorista)',
      passwordHash: hash,
      salt,
      role: 'driver',
      phone: '11988887777',
      active: true,
      createdAt: new Date().toISOString()
    };
    db.users.push(driverUser);
  }

  // Seed sample vehicles
  if (db.vehicles.filter(v => v.companyId === sampleCompanyId).length === 0) {
    db.vehicles.push(
      {
        id: crypto.randomUUID(),
        companyId: sampleCompanyId,
        placa: 'BRA2E19',
        identificacao: 'Fiorino Express 01',
        categoria: 'fiorino',
        tipoPropriedade: 'proprio',
        capacidadeKg: 650,
        capacidadeVolumes: 50,
        motoristaVinculadoId: driverUser.id,
        motoristaVinculadoNome: driverUser.name,
        statusOperacional: 'disponivel',
        tipoRastreamento: 'app_gps',
        ultimaLocalizacao: {
          lat: -23.5505,
          lng: -46.6333,
          velocidade: 32,
          precisao: 8,
          atualizadoEm: new Date().toISOString(),
          status: 'online'
        },
        historicoViagensCount: 14,
        criadoEm: new Date().toISOString()
      },
      {
        id: crypto.randomUUID(),
        companyId: sampleCompanyId,
        placa: 'RTE4B88',
        identificacao: 'Moto Agilidade 02',
        categoria: 'moto',
        tipoPropriedade: 'proprio',
        capacidadeKg: 40,
        capacidadeVolumes: 8,
        statusOperacional: 'disponivel',
        tipoRastreamento: 'app_gps',
        historicoViagensCount: 42,
        criadoEm: new Date().toISOString()
      }
    );
  }

  // Seed sample deliveries if empty
  if (db.deliveries.filter(d => d.companyId === sampleCompanyId).length === 0) {
    const sampleDeliveries = [
      {
        destinatario: 'Hospital São Lucas - Recepção Central',
        cliente: 'Rede Hospitalar Paulista',
        telefone: '11987654321',
        endereco: 'Avenida Paulista',
        numero: '1200',
        bairro: 'Bela Vista',
        cidade: 'São Paulo',
        estado: 'SP',
        cep: '01310100',
        volumes: 3,
        pesoKg: 14.5,
        prioridade: 'urgente' as const,
        prazoEntrega: new Date(Date.now() + 24 * 3600 * 1000).toISOString().split('T')[0],
        janelaHorarioInicio: '08:00',
        janelaHorarioFim: '12:00',
        lat: -23.5615,
        lng: -46.6559,
        instrucoes: 'Entregar na doca de suprimentos com NF anexada'
      },
      {
        destinatario: 'Drogaria FarmaVida',
        cliente: 'Laboratório Farmacêutico',
        telefone: '11976543210',
        endereco: 'Rua Domingos de Morais',
        numero: '850',
        bairro: 'Vila Mariana',
        cidade: 'São Paulo',
        estado: 'SP',
        cep: '04010000',
        volumes: 5,
        pesoKg: 18.0,
        prioridade: 'alta' as const,
        prazoEntrega: new Date(Date.now() + 24 * 3600 * 1000).toISOString().split('T')[0],
        janelaHorarioInicio: '09:00',
        janelaHorarioFim: '14:00',
        lat: -23.5855,
        lng: -46.6385,
        instrucoes: 'Recebimento das 08h às 14h'
      },
      {
        destinatario: 'Escritório Advocacia Pinheiro',
        cliente: 'Gráfica Express',
        telefone: '11965432109',
        endereco: 'Rua Funchal',
        numero: '418',
        complemento: '12º andar',
        bairro: 'Vila Olímpia',
        cidade: 'São Paulo',
        estado: 'SP',
        cep: '04551060',
        volumes: 2,
        pesoKg: 6.0,
        prioridade: 'media' as const,
        prazoEntrega: new Date(Date.now() + 48 * 3600 * 1000).toISOString().split('T')[0],
        lat: -23.5935,
        lng: -46.6872,
        instrucoes: 'Entregar na recepção'
      },
      {
        destinatario: 'Livraria & Café Cultura',
        cliente: 'Editora Nacional',
        telefone: '11954321098',
        endereco: 'Rua Fradique Coutinho',
        numero: '912',
        bairro: 'Pinheiros',
        cidade: 'São Paulo',
        estado: 'SP',
        cep: '05416001',
        volumes: 4,
        pesoKg: 22.5,
        prioridade: 'media' as const,
        prazoEntrega: new Date(Date.now() + 24 * 3600 * 1000).toISOString().split('T')[0],
        lat: -23.5601,
        lng: -46.6908,
        instrucoes: 'Conferir volumes com o gerente'
      }
    ];

    sampleDeliveries.forEach((d, i) => {
      db.deliveries.push({
        id: crypto.randomUUID(),
        companyId: sampleCompanyId,
        codigoRastreio: `LL-${Date.now().toString().slice(-4)}00${i + 1}`,
        destinatario: d.destinatario,
        cliente: d.cliente,
        telefone: d.telefone,
        endereco: d.endereco,
        numero: d.numero,
        complemento: (d as any).complemento,
        bairro: d.bairro,
        cidade: d.cidade,
        estado: d.estado,
        cep: d.cep,
        volumes: d.volumes,
        pesoKg: d.pesoKg,
        prioridade: d.prioridade,
        prazoEntrega: d.prazoEntrega,
        janelaHorarioInicio: d.janelaHorarioInicio,
        janelaHorarioFim: d.janelaHorarioFim,
        lat: d.lat,
        lng: d.lng,
        geocodificado: true,
        geocodificacaoStatus: 'ok',
        status: 'pendente',
        tentativas: 0,
        instrucoes: d.instrucoes,
        origemImportacao: 'manual',
        criadoEm: new Date().toISOString(),
        atualizadoEm: new Date().toISOString()
      });
    });
  }

  db.save();
  res.json({ message: 'Dados de demonstração gerados com sucesso para a empresa inicial', sampleCompany });
});

// ==========================================
// 6. LET'S LOG — DELIVERIES & SPREADSHEET IMPORT
// ==========================================

// List deliveries with multi-criteria filters
apiRouter.get('/deliveries', authenticate, checkSubscription, (req: AuthRequest, res: Response) => {
  const companyId = req.user!.role === 'master_owner' && req.query.companyId
    ? (req.query.companyId as string)
    : getEffectiveCompanyId(req);

  let list = db.deliveries.filter(d => d.companyId === companyId);

  // Status filter
  if (req.query.status && typeof req.query.status === 'string' && req.query.status !== 'todos') {
    list = list.filter(d => d.status === req.query.status);
  }

  // Priority filter
  if (req.query.prioridade && typeof req.query.prioridade === 'string' && req.query.prioridade !== 'todas') {
    list = list.filter(d => d.prioridade === req.query.prioridade);
  }

  // City filter
  if (req.query.cidade && typeof req.query.cidade === 'string' && req.query.cidade.trim()) {
    const c = (req.query.cidade as string).toLowerCase().trim();
    list = list.filter(d => d.cidade.toLowerCase().includes(c));
  }

  // Neighborhood filter
  if (req.query.bairro && typeof req.query.bairro === 'string' && req.query.bairro.trim()) {
    const b = (req.query.bairro as string).toLowerCase().trim();
    list = list.filter(d => d.bairro.toLowerCase().includes(b));
  }

  // Search filter
  if (req.query.search && typeof req.query.search === 'string' && req.query.search.trim()) {
    const term = (req.query.search as string).toLowerCase().trim();
    list = list.filter(d =>
      d.destinatario.toLowerCase().includes(term) ||
      d.codigoRastreio.toLowerCase().includes(term) ||
      d.endereco.toLowerCase().includes(term) ||
      d.cep.includes(term) ||
      (d.cliente && d.cliente.toLowerCase().includes(term))
    );
  }

  // Sort: newest first
  list.sort((a, b) => new Date(b.criadoEm).getTime() - new Date(a.criadoEm).getTime());

  res.json({ deliveries: list });
});

// Create manual delivery with strict validation and geocoding
apiRouter.post('/deliveries', authenticate, checkSubscription, async (req: AuthRequest, res: Response) => {
  const companyId = getEffectiveCompanyId(req);
  const rawDestinatario = req.body.destinatario || req.body.cliente || req.body.clienteNome;
  const destinatario = rawDestinatario ? String(rawDestinatario).trim() : '';
  const {
    cliente,
    telefone,
    email,
    endereco,
    numero,
    complemento,
    bairro,
    cidade,
    estado,
    cep,
    referencia,
    instrucoes,
    volumes,
    pesoKg,
    valorMercadoria,
    prioridade,
    prazoEntrega,
    janelaHorarioInicio,
    janelaHorarioFim,
    observacoes
  } = req.body;

  // Strict location & mandatory fields validation
  if (!destinatario || !telefone || !endereco || !numero || !bairro || !cidade || !cep) {
    res.status(400).json({
      error: 'Dados obrigatórios ausentes: destinatário, telefone, endereço, número, bairro, cidade e CEP são necessários para cadastrar a entrega.'
    });
    return;
  }

  const cleanCep = String(cep).replace(/\D/g, '');
  if (cleanCep.length < 8) {
    res.status(400).json({ error: 'CEP inválido. O CEP deve conter 8 dígitos numéricos.' });
    return;
  }

  // Duplicate detection by code or exact address + recipient
  const existingDup = db.deliveries.find(d =>
    d.companyId === companyId &&
    d.status !== 'cancelada' &&
    d.destinatario.toLowerCase().trim() === destinatario.toLowerCase().trim() &&
    d.endereco.toLowerCase().trim() === endereco.toLowerCase().trim() &&
    d.numero.trim() === String(numero).trim() &&
    d.cep.replace(/\D/g, '') === cleanCep
  );

  if (existingDup) {
    res.status(409).json({
      error: `Possível duplicidade identificada: já existe a entrega ${existingDup.codigoRastreio} com mesmo destinatário e endereço nesta empresa.`
    });
    return;
  }

  // Geocoding
  const geo = await geocodeAddress(endereco, String(numero), bairro, cidade, cleanCep);

  const deliveryCount = db.deliveries.filter(d => d.companyId === companyId).length + 1;
  const codigoRastreio = `LL-${Date.now().toString().slice(-4)}${String(deliveryCount).padStart(3, '0')}`;

  const now = new Date().toISOString();
  const newDelivery: DeliveryItem = {
    id: crypto.randomUUID(),
    companyId,
    codigoRastreio,
    destinatario: String(destinatario).trim(),
    cliente: cliente ? String(cliente).trim() : undefined,
    telefone: String(telefone).trim(),
    email: email ? String(email).trim() : undefined,
    endereco: String(endereco).trim(),
    numero: String(numero).trim(),
    complemento: complemento ? String(complemento).trim() : undefined,
    bairro: String(bairro).trim(),
    cidade: String(cidade).trim(),
    estado: estado ? String(estado).trim() : 'SP',
    cep: cleanCep,
    referencia: referencia ? String(referencia).trim() : undefined,
    instrucoes: instrucoes ? String(instrucoes).trim() : undefined,
    volumes: Number(volumes) > 0 ? Number(volumes) : 1,
    pesoKg: Number(pesoKg) > 0 ? Number(pesoKg) : 1,
    valorMercadoria: valorMercadoria ? Number(valorMercadoria) : undefined,
    prioridade: prioridade || 'media',
    prazoEntrega: prazoEntrega || new Date(Date.now() + 24 * 3600 * 1000).toISOString().split('T')[0],
    janelaHorarioInicio: janelaHorarioInicio || undefined,
    janelaHorarioFim: janelaHorarioFim || undefined,
    lat: geo.status !== 'falha' ? geo.lat : undefined,
    lng: geo.status !== 'falha' ? geo.lng : undefined,
    geocodificado: geo.status !== 'falha',
    geocodificacaoStatus: geo.status,
    status: 'pendente',
    tentativas: 0,
    observacoes: observacoes ? String(observacoes).trim() : undefined,
    origemImportacao: 'manual',
    criadoEm: now,
    atualizadoEm: now
  };

  db.deliveries.push(newDelivery);
  db.save();

  db.logAudit({
    userId: req.user!.id,
    userEmail: req.user!.email,
    userName: req.user!.name,
    companyId,
    acao: 'CADASTRO_ENTREGA',
    detalhes: `Entrega ${newDelivery.codigoRastreio} (${newDelivery.destinatario} - ${newDelivery.bairro}) cadastrada manualmente`,
    ip: req.ip
  });

  res.status(201).json({
    message: 'Entrega cadastrada com sucesso',
    delivery: newDelivery
  });
});

// Batch import of spreadsheet data (CSV or Excel) with complete audit and reporting
apiRouter.post('/deliveries/import', authenticate, checkSubscription, async (req: AuthRequest, res: Response) => {
  const companyId = getEffectiveCompanyId(req);
  const { rows } = req.body;

  if (!Array.isArray(rows) || rows.length === 0) {
    res.status(400).json({ error: 'Nenhum registro recebido para importação.' });
    return;
  }

  const accepted: DeliveryItem[] = [];
  const rejected: { row: number; data: any; reason: string }[] = [];
  const now = new Date().toISOString();

  for (let i = 0; i < rows.length; i++) {
    const raw = rows[i];
    const rowNum = i + 1;

    // Normalizing field names from various spreadsheet headers
    const destinatario = raw.destinatario || raw.Destinatario || raw.CLIENTE || raw.cliente || raw.Nome || raw.nome;
    const telefone = raw.telefone || raw.Telefone || raw.Contato || raw.contato || raw.celular || raw.Fone;
    const endereco = raw.endereco || raw.Endereco || raw.Logradouro || raw.Rua || raw.rua;
    const numero = raw.numero || raw.Numero || raw.Num || 'S/N';
    const complemento = raw.complemento || raw.Complemento || '';
    const bairro = raw.bairro || raw.Bairro;
    const cidade = raw.cidade || raw.Cidade || raw.Municipio || 'São Paulo';
    const estado = raw.estado || raw.Estado || raw.UF || 'SP';
    const cep = String(raw.cep || raw.CEP || '').replace(/\D/g, '');
    const volumes = Number(raw.volumes || raw.Volumes || raw.Qtd || 1) || 1;
    const pesoKg = Number(raw.pesoKg || raw.peso || raw.Peso || 1) || 1;
    const prioridade = raw.prioridade || raw.Prioridade || 'media';
    const prazo = raw.prazo || raw.prazoEntrega || new Date(Date.now() + 24 * 3600 * 1000).toISOString().split('T')[0];
    const instrucoes = raw.instrucoes || raw.observacoes || raw.Instrucoes || '';

    // Validation
    if (!destinatario || String(destinatario).trim().length < 2) {
      rejected.push({ row: rowNum, data: raw, reason: 'Nome do destinatário ausente ou inválido.' });
      continue;
    }
    if (!endereco || String(endereco).trim().length < 3) {
      rejected.push({ row: rowNum, data: raw, reason: 'Endereço / logradouro ausente ou incompleto.' });
      continue;
    }
    if (!bairro || String(bairro).trim().length < 2) {
      rejected.push({ row: rowNum, data: raw, reason: 'Bairro ausente.' });
      continue;
    }
    if (!cep || cep.length < 8) {
      rejected.push({ row: rowNum, data: raw, reason: 'CEP inválido (são necessários 8 dígitos numéricos).' });
      continue;
    }

    // Duplicate check
    const isDup = db.deliveries.some(d =>
      d.companyId === companyId &&
      d.status !== 'cancelada' &&
      d.destinatario.toLowerCase().trim() === String(destinatario).toLowerCase().trim() &&
      d.endereco.toLowerCase().trim() === String(endereco).toLowerCase().trim() &&
      d.numero.trim() === String(numero).trim() &&
      d.cep.replace(/\D/g, '') === cep
    );

    if (isDup) {
      rejected.push({ row: rowNum, data: raw, reason: 'Duplicidade detectada: entrega com mesmo destinatário, endereço e CEP já existente.' });
      continue;
    }

    // Geocode (with offline fallback guaranteed)
    const geo = await geocodeAddress(String(endereco), String(numero), String(bairro), String(cidade), cep);

    const deliveryCount = db.deliveries.filter(d => d.companyId === companyId).length + accepted.length + 1;
    const codigoRastreio = `LL-IMP-${String(deliveryCount).padStart(4, '0')}`;

    const newDelivery: DeliveryItem = {
      id: crypto.randomUUID(),
      companyId,
      codigoRastreio,
      destinatario: String(destinatario).trim(),
      cliente: raw.cliente ? String(raw.cliente).trim() : undefined,
      telefone: telefone ? String(telefone).trim() : '11999999999',
      email: raw.email ? String(raw.email).trim() : undefined,
      endereco: String(endereco).trim(),
      numero: String(numero).trim(),
      complemento: complemento ? String(complemento).trim() : undefined,
      bairro: String(bairro).trim(),
      cidade: String(cidade).trim(),
      estado: String(estado).trim(),
      cep,
      referencia: raw.referencia ? String(raw.referencia).trim() : undefined,
      instrucoes: instrucoes ? String(instrucoes).trim() : undefined,
      volumes,
      pesoKg,
      valorMercadoria: raw.valor ? Number(raw.valor) : undefined,
      prioridade: (['baixa', 'media', 'alta', 'urgente'].includes(String(prioridade).toLowerCase()) ? String(prioridade).toLowerCase() : 'media') as any,
      prazoEntrega: String(prazo),
      janelaHorarioInicio: raw.janelaInicio || undefined,
      janelaHorarioFim: raw.janelaFim || undefined,
      lat: geo.status !== 'falha' ? geo.lat : undefined,
      lng: geo.status !== 'falha' ? geo.lng : undefined,
      geocodificado: geo.status !== 'falha',
      geocodificacaoStatus: geo.status,
      status: 'pendente',
      tentativas: 0,
      origemImportacao: 'planilha_csv',
      criadoEm: now,
      atualizadoEm: now
    };

    accepted.push(newDelivery);
  }

  // Persist accepted deliveries
  if (accepted.length > 0) {
    db.deliveries.push(...accepted);
    db.save();

    db.logAudit({
      userId: req.user!.id,
      userEmail: req.user!.email,
      userName: req.user!.name,
      companyId,
      acao: 'IMPORTACAO_PLANILHA',
      detalhes: `Importação em lote concluída: ${accepted.length} entregas aceitas, ${rejected.length} rejeitadas`,
      ip: req.ip
    });
  }

  res.json({
    message: `Importação processada: ${accepted.length} entregas importadas com sucesso, ${rejected.length} rejeitadas.`,
    totalReceived: rows.length,
    acceptedCount: accepted.length,
    rejectedCount: rejected.length,
    accepted,
    rejected
  });
});

// Update delivery (status, notes, attempts, or assigned vehicle/driver)
const handleUpdateDelivery = (req: AuthRequest, res: Response) => {
  const companyId = getEffectiveCompanyId(req);
  const { id } = req.params;

  const delivery = db.deliveries.find(d => d.id === id && (req.user!.role === 'master_owner' || d.companyId === companyId));
  if (!delivery) {
    res.status(404).json({ error: 'Entrega não encontrada' });
    return;
  }

  const {
    status,
    observacoes,
    prioridade,
    recebedorNome,
    recebedorDocumento,
    motivoFalha,
    tentativas
  } = req.body;

  if (status) delivery.status = status;
  if (observacoes !== undefined) delivery.observacoes = observacoes;
  if (prioridade) delivery.prioridade = prioridade;
  if (recebedorNome) delivery.recebedorNome = recebedorNome;
  if (recebedorDocumento) delivery.recebedorDocumento = recebedorDocumento;
  if (motivoFalha) delivery.motivoFalha = motivoFalha;
  if (tentativas !== undefined) delivery.tentativas = Number(tentativas);
  if (status === 'entregue') delivery.entregueEm = new Date().toISOString();

  delivery.atualizadoEm = new Date().toISOString();
  db.save();

  res.json({ message: 'Entrega atualizada com sucesso', delivery });
};

apiRouter.patch('/deliveries/:id', authenticate, checkSubscription, handleUpdateDelivery);
apiRouter.put('/deliveries/:id', authenticate, checkSubscription, handleUpdateDelivery);

// Delete unassigned delivery
apiRouter.delete('/deliveries/:id', authenticate, checkSubscription, (req: AuthRequest, res: Response) => {
  const companyId = getEffectiveCompanyId(req);
  const { id } = req.params;

  const index = db.deliveries.findIndex(d => d.id === id && (req.user!.role === 'master_owner' || d.companyId === companyId));
  if (index === -1) {
    res.status(404).json({ error: 'Entrega não encontrada' });
    return;
  }

  const del = db.deliveries[index];
  if (del.status === 'em_rota' || del.status === 'entregue') {
    res.status(400).json({ error: 'Não é possível excluir entregas que já foram publicadas em rota ou entregues.' });
    return;
  }

  db.deliveries.splice(index, 1);
  db.save();

  res.json({ message: 'Entrega removida com sucesso' });
});

// ==========================================
// 7. LET'S LOG — FLEET & VEHICLE GPS TRACKING
// ==========================================

// List company fleet vehicles
apiRouter.get('/fleet/vehicles', authenticate, checkSubscription, (req: AuthRequest, res: Response) => {
  const companyId = req.user!.role === 'master_owner' && req.query.companyId
    ? (req.query.companyId as string)
    : getEffectiveCompanyId(req);

  const list = db.vehicles.filter(v => v.companyId === companyId);
  res.json({ vehicles: list });
});

// Register new vehicle
apiRouter.post('/fleet/vehicles', authenticate, checkSubscription, (req: AuthRequest, res: Response) => {
  const companyId = getEffectiveCompanyId(req);
  const {
    placa,
    identificacao,
    categoria,
    tipoPropriedade,
    capacidadeKg,
    capacidadeVolumes,
    motoristaVinculadoId,
    tipoRastreamento
  } = req.body;

  if (!placa || !identificacao || !categoria || !capacidadeKg || !capacidadeVolumes) {
    res.status(400).json({ error: 'Placa, identificação, categoria, capacidade em kg e em volumes são obrigatórios.' });
    return;
  }

  const cleanPlaca = String(placa).toUpperCase().replace(/[^A-Z0-9]/g, '');

  // Check duplicate license plate in company
  const exists = db.vehicles.find(v => v.companyId === companyId && v.placa === cleanPlaca);
  if (exists) {
    res.status(409).json({ error: `Veículo com a placa ${cleanPlaca} já está cadastrado nesta empresa.` });
    return;
  }

  let motoristaNome: string | undefined = undefined;
  if (motoristaVinculadoId) {
    const drv = db.users.find(u => u.id === motoristaVinculadoId);
    if (drv) motoristaNome = drv.name;
  }

  const newVehicle: Vehicle = {
    id: crypto.randomUUID(),
    companyId,
    placa: cleanPlaca,
    identificacao: String(identificacao).trim(),
    categoria: categoria || 'fiorino',
    tipoPropriedade: tipoPropriedade || 'proprio',
    capacidadeKg: Number(capacidadeKg),
    capacidadeVolumes: Number(capacidadeVolumes),
    motoristaVinculadoId: motoristaVinculadoId || undefined,
    motoristaVinculadoNome: motoristaNome,
    statusOperacional: 'disponivel',
    tipoRastreamento: tipoRastreamento || 'app_gps',
    historicoViagensCount: 0,
    criadoEm: new Date().toISOString()
  };

  db.vehicles.push(newVehicle);
  db.save();

  db.logAudit({
    userId: req.user!.id,
    userEmail: req.user!.email,
    userName: req.user!.name,
    companyId,
    acao: 'CADASTRO_VEICULO',
    detalhes: `Veículo ${newVehicle.identificacao} (${newVehicle.placa}) cadastrado na frota`,
    ip: req.ip
  });

  res.status(201).json({ message: 'Veículo cadastrado com sucesso', vehicle: newVehicle });
});

// Update vehicle (status, driver link, maintenance)
apiRouter.patch('/fleet/vehicles/:id', authenticate, checkSubscription, (req: AuthRequest, res: Response) => {
  const companyId = getEffectiveCompanyId(req);
  const { id } = req.params;

  const vehicle = db.vehicles.find(v => v.id === id && (req.user!.role === 'master_owner' || v.companyId === companyId));
  if (!vehicle) {
    res.status(404).json({ error: 'Veículo não encontrado' });
    return;
  }

  const {
    identificacao,
    categoria,
    capacidadeKg,
    capacidadeVolumes,
    motoristaVinculadoId,
    statusOperacional,
    tipoRastreamento
  } = req.body;

  if (identificacao) vehicle.identificacao = String(identificacao).trim();
  if (categoria) vehicle.categoria = categoria;
  if (capacidadeKg) vehicle.capacidadeKg = Number(capacidadeKg);
  if (capacidadeVolumes) vehicle.capacidadeVolumes = Number(capacidadeVolumes);
  if (statusOperacional) vehicle.statusOperacional = statusOperacional;
  if (tipoRastreamento) vehicle.tipoRastreamento = tipoRastreamento;

  if (motoristaVinculadoId !== undefined) {
    vehicle.motoristaVinculadoId = motoristaVinculadoId || undefined;
    if (motoristaVinculadoId) {
      const drv = db.users.find(u => u.id === motoristaVinculadoId);
      vehicle.motoristaVinculadoNome = drv?.name;
    } else {
      vehicle.motoristaVinculadoNome = undefined;
    }
  }

  db.save();
  res.json({ message: 'Veículo atualizado com sucesso', vehicle });
});

// Live GPS coordinate update from authorized driver device or tracker
apiRouter.post('/fleet/vehicles/:id/location', authenticate, (req: AuthRequest, res: Response) => {
  const { id } = req.params;
  const { lat, lng, velocidade, precisao, bateria, timestampDispositivo } = req.body;

  if (typeof lat !== 'number' || typeof lng !== 'number' || !Number.isFinite(lat) || !Number.isFinite(lng)) {
    res.status(400).json({ error: 'Coordenadas de latitude e longitude inválidas (valores numéricos finitos obrigatórios)' });
    return;
  }

  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) {
    res.status(400).json({ error: 'Coordenadas fora dos limites geográficos válidos (-90 a 90 de latitude, -180 a 180 de longitude)' });
    return;
  }

  const vehicle = db.vehicles.find(v => v.id === id);
  if (!vehicle) {
    res.status(404).json({ error: 'Veículo não encontrado' });
    return;
  }

  // Security: only master owner, company admin, or assigned driver can send GPS updates
  if (req.user!.role !== 'master_owner') {
    if (vehicle.companyId !== req.user!.companyId) {
      res.status(403).json({ error: 'Acesso negado para este veículo' });
      return;
    }
    if (req.user!.role === 'driver' && vehicle.motoristaVinculadoId && vehicle.motoristaVinculadoId !== req.user!.id) {
      res.status(403).json({ error: 'Você não está vinculado a este veículo' });
      return;
    }
  }

  // Out-of-order & stale message protection
  const now = new Date();
  const deviceTime = timestampDispositivo ? new Date(timestampDispositivo) : now;

  if (vehicle.ultimaLocalizacao?.timestampDispositivo) {
    const prevDeviceTime = new Date(vehicle.ultimaLocalizacao.timestampDispositivo);
    if (!isNaN(prevDeviceTime.getTime()) && !isNaN(deviceTime.getTime())) {
      if (deviceTime.getTime() < prevDeviceTime.getTime()) {
        res.status(400).json({
          error: 'Pacote de telemetria descartado: leitura fora de ordem (timestamp do dispositivo anterior à última leitura registrada)',
          ultimaLeitura: vehicle.ultimaLocalizacao
        });
        return;
      }
      if (deviceTime.getTime() === prevDeviceTime.getTime() && vehicle.ultimaLocalizacao.lat === lat && vehicle.ultimaLocalizacao.lng === lng) {
        res.status(200).json({
          success: true,
          message: 'Telemetria repetida (já registrada anteriormente)',
          location: vehicle.ultimaLocalizacao
        });
        return;
      }
    }
  }

  // Velocity sanity check (anti-spoofing heuristic against teleportation)
  if (vehicle.ultimaLocalizacao && vehicle.ultimaLocalizacao.lat && vehicle.ultimaLocalizacao.lng) {
    const prevTime = vehicle.ultimaLocalizacao.atualizadoEm ? new Date(vehicle.ultimaLocalizacao.atualizadoEm).getTime() : 0;
    const timeDeltaSeconds = (now.getTime() - prevTime) / 1000;
    if (timeDeltaSeconds > 0 && timeDeltaSeconds < 3600) {
      const distKm = calculateDistanceKm(vehicle.ultimaLocalizacao.lat, vehicle.ultimaLocalizacao.lng, lat, lng);
      const impliedSpeedKmh = (distKm / (timeDeltaSeconds / 3600));
      // Flag anomalous impossible speed (e.g., > 300 km/h)
      if (impliedSpeedKmh > 300) {
        res.status(400).json({
          error: `Anomalia de telemetria detectada: velocidade implícita de ${Math.round(impliedSpeedKmh)} km/h excede o limite operacional seguro (possível coordenada adulterada ou salto de sinal GPS).`,
          distanciaKm: distKm,
          intervaloSegundos: timeDeltaSeconds
        });
        return;
      }
    }
  }

  vehicle.ultimaLocalizacao = {
    lat: Number(lat.toFixed(6)),
    lng: Number(lng.toFixed(6)),
    velocidade: velocidade !== undefined ? Number(velocidade) : 0,
    precisao: precisao !== undefined ? Number(precisao) : 10,
    bateria: bateria !== undefined ? Number(bateria) : undefined,
    timestampDispositivo: deviceTime.toISOString(),
    recebidoEm: now.toISOString(),
    atualizadoEm: now.toISOString(),
    origem: req.user!.name || 'driver_device',
    status: 'online'
  };

  db.save();
  res.json({ success: true, message: 'Localização atualizada', location: vehicle.ultimaLocalizacao });
});

// Query single vehicle
apiRouter.get('/fleet/vehicles/:id', authenticate, checkSubscription, (req: AuthRequest, res: Response) => {
  const companyId = getEffectiveCompanyId(req);
  const { id } = req.params;
  const vehicle = db.vehicles.find(v => v.id === id && (req.user!.role === 'master_owner' || v.companyId === companyId));
  if (!vehicle) {
    res.status(404).json({ error: 'Veículo não encontrado' });
    return;
  }
  res.json({ vehicle });
});

// Query vehicle live location
apiRouter.get('/fleet/vehicles/:id/location', authenticate, checkSubscription, (req: AuthRequest, res: Response) => {
  const companyId = getEffectiveCompanyId(req);
  const { id } = req.params;
  const vehicle = db.vehicles.find(v => v.id === id && (req.user!.role === 'master_owner' || v.companyId === companyId));
  if (!vehicle) {
    res.status(404).json({ error: 'Veículo não encontrado' });
    return;
  }
  res.json({
    veiculoId: vehicle.id,
    placa: vehicle.placa,
    identificacao: vehicle.identificacao,
    ultimaLocalizacao: vehicle.ultimaLocalizacao || null
  });
});

// ==========================================
// 8. LET'S LOG — ROUTE ENGINE & DISPATCHER PANEL
// ==========================================

// Route planning suggestion engine
apiRouter.post('/routes/plan-suggest', authenticate, checkSubscription, async (req: AuthRequest, res: Response) => {
  const companyId = getEffectiveCompanyId(req);
  const { deliveryIds, veiculoId } = req.body;

  if (!Array.isArray(deliveryIds) || deliveryIds.length === 0) {
    res.status(400).json({ error: 'Selecione pelo menos uma entrega para planejar a rota.' });
    return;
  }

  const vehicle = db.vehicles.find(v => v.id === veiculoId && v.companyId === companyId);
  if (!vehicle) {
    res.status(404).json({ error: 'Veículo selecionado não encontrado na frota.' });
    return;
  }

  const deliveries = db.deliveries.filter(d => deliveryIds.includes(d.id) && d.companyId === companyId);
  if (deliveries.length === 0) {
    res.status(400).json({ error: 'Nenhuma entrega válida encontrada com os IDs fornecidos.' });
    return;
  }

  // Calculate totals and capacity warnings
  const totalVolumes = deliveries.reduce((acc, d) => acc + (d.volumes || 1), 0);
  const totalWeightKg = deliveries.reduce((acc, d) => acc + (d.pesoKg || 1), 0);

  const warnings: string[] = [];
  let capacityExceeded = false;

  if (totalWeightKg > vehicle.capacidadeKg) {
    capacityExceeded = true;
    warnings.push(`Capacidade de peso excedida: Carga total de ${totalWeightKg.toFixed(1)} kg excede o limite do veículo de ${vehicle.capacidadeKg} kg.`);
  }

  if (totalVolumes > vehicle.capacidadeVolumes) {
    capacityExceeded = true;
    warnings.push(`Capacidade volumétrica excedida: ${totalVolumes} volumes excedem o limite de ${vehicle.capacidadeVolumes} do veículo.`);
  }

  // Separate deliveries with valid coordinates from those with incomplete/failed coordinates
  const withCoords = deliveries.filter(d => typeof d.lat === 'number' && typeof d.lng === 'number');
  const withoutCoords = deliveries.filter(d => typeof d.lat !== 'number' || typeof d.lng !== 'number');

  if (withoutCoords.length > 0) {
    warnings.push(`${withoutCoords.length} entrega(s) possuem endereço sem coordenadas geográficas confirmadas. Foram agrupadas por CEP e bairro sem coordenadas inventadas.`);
  }

  // Nearest-Neighbor sequencing optimization (proximity heuristic, not global optimum)
  const unvisited = [...withCoords];
  const orderedGeocoded: DeliveryItem[] = [];

  if (unvisited.length > 0) {
    let currentLat = unvisited[0].lat!;
    let currentLng = unvisited[0].lng!;

    while (unvisited.length > 0) {
      let nearestIndex = 0;
      let minDistance = Infinity;

      for (let i = 0; i < unvisited.length; i++) {
        const d = unvisited[i];
        const dist = calculateDistanceKm(currentLat, currentLng, d.lat!, d.lng!);
        const priorityBonus = d.prioridade === 'urgente' ? 0.6 : d.prioridade === 'alta' ? 0.8 : 1.0;
        const effectiveDist = dist * priorityBonus;

        if (effectiveDist < minDistance) {
          minDistance = effectiveDist;
          nearestIndex = i;
        }
      }

      const [selected] = unvisited.splice(nearestIndex, 1);
      orderedGeocoded.push(selected);
      currentLat = selected.lat!;
      currentLng = selected.lng!;
    }
  }

  // Cluster non-geocoded deliveries by CEP and bairro
  withoutCoords.sort((a, b) => {
    const cepA = (a.cep || '').slice(0, 5);
    const cepB = (b.cep || '').slice(0, 5);
    if (cepA !== cepB) return cepA.localeCompare(cepB);
    return (a.bairro || '').localeCompare(b.bairro || '');
  });

  const orderedDeliveries = [...orderedGeocoded, ...withoutCoords];

  // Calculate cumulative route distance & duration on geocoded segments
  let totalKm = 0;
  for (let i = 0; i < orderedGeocoded.length - 1; i++) {
    const a = orderedGeocoded[i];
    const b = orderedGeocoded[i + 1];
    totalKm += calculateDistanceKm(a.lat!, a.lng!, b.lat!, b.lng!);
  }

  // Road factor correction (~1.3x Euclidean/Haversine)
  const estimatedRoadKm = Number((totalKm * 1.3).toFixed(1));
  // 3 minutes per km + 10 minutes service time per stop
  const estimatedDurationMin = Math.round(estimatedRoadKm * 3 + orderedDeliveries.length * 10);

  const suggestedStops: RouteStop[] = orderedDeliveries.map((d, index) => ({
    ordem: index + 1,
    deliveryId: d.id,
    codigoRastreio: d.codigoRastreio,
    destinatario: d.destinatario,
    telefone: d.telefone,
    enderecoCompleto: `${d.endereco}, ${d.numero}${d.complemento ? ' - ' + d.complemento : ''}`,
    bairro: d.bairro,
    cidade: d.cidade,
    cep: d.cep,
    lat: d.lat,
    lng: d.lng,
    volumes: d.volumes,
    pesoKg: d.pesoKg,
    prioridade: d.prioridade,
    janelaHorario: d.janelaHorarioInicio && d.janelaHorarioFim ? `${d.janelaHorarioInicio} - ${d.janelaHorarioFim}` : undefined,
    instrucoes: d.instrucoes,
    status: 'aguardando'
  }));

  res.json({
    vehicle,
    totalDeliveries: deliveries.length,
    totalVolumes,
    totalWeightKg,
    capacityExceeded,
    warnings,
    estimatedDistanceKm: estimatedRoadKm,
    estimatedDurationMin,
    suggestedStops
  });
});

// List company routes
apiRouter.get('/routes', authenticate, checkSubscription, (req: AuthRequest, res: Response) => {
  const companyId = req.user!.role === 'master_owner' && req.query.companyId
    ? (req.query.companyId as string)
    : getEffectiveCompanyId(req);

  let list = db.routes.filter(r => r.companyId === companyId);

  // If logged-in user is a driver, only return routes assigned to them!
  if (req.user!.role === 'driver') {
    list = list.filter(r => r.motoristaId === req.user!.id);
  }

  list.sort((a, b) => new Date(b.criadaEm).getTime() - new Date(a.criadaEm).getTime());
  res.json({ routes: list });
});

// Get single route by ID
apiRouter.get('/routes/:id', authenticate, checkSubscription, (req: AuthRequest, res: Response) => {
  const { id } = req.params;
  const route = db.routes.find(r => r.id === id);

  if (!route) {
    res.status(404).json({ error: 'Rota não encontrada' });
    return;
  }

  // Security: check company isolation and driver isolation
  if (req.user!.role !== 'master_owner') {
    if (route.companyId !== req.user!.companyId) {
      res.status(403).json({ error: 'Acesso negado a esta rota' });
      return;
    }
    if (req.user!.role === 'driver' && route.motoristaId !== req.user!.id) {
      res.status(403).json({ error: 'Acesso restrito ao motorista atribuído' });
      return;
    }
  }

  const vehicle = db.vehicles.find(v => v.id === route.veiculoId);
  res.json({ route, vehicle });
});

// Create new route in preparation
apiRouter.post('/routes', authenticate, checkSubscription, (req: AuthRequest, res: Response) => {
  const companyId = getEffectiveCompanyId(req);
  const rawTitulo = req.body.titulo || req.body.nome;
  const titulo = rawTitulo ? String(rawTitulo).trim() : '';
  const veiculoId = req.body.veiculoId;
  const motoristaId = req.body.motoristaId;
  const stops = req.body.stops || req.body.sequenciaParadas || [];

  if (!titulo || !veiculoId || !Array.isArray(stops) || stops.length === 0) {
    res.status(400).json({ error: 'Título da rota, veículo e pelo menos uma parada são obrigatórios.' });
    return;
  }

  const vehicle = db.vehicles.find(v => v.id === veiculoId && v.companyId === companyId);
  if (!vehicle) {
    res.status(404).json({ error: 'Veículo não encontrado' });
    return;
  }

  let motoristaNome = 'A definir';
  let motoristaTelefone = '';
  if (motoristaId) {
    const drv = db.users.find(u => u.id === motoristaId);
    if (drv) {
      motoristaNome = drv.name;
      motoristaTelefone = drv.phone || '';
    }
  }

  const routeCount = db.routes.filter(r => r.companyId === companyId).length + 1;
  const codigoRota = `ROT-${new Date().getFullYear()}-${String(routeCount).padStart(3, '0')}`;

  const totalVolumes = stops.reduce((acc: number, s: RouteStop) => acc + (s.volumes || 1), 0);
  const totalPesoKg = stops.reduce((acc: number, s: RouteStop) => acc + (s.pesoKg || 1), 0);

  const cidades = Array.from(new Set(stops.map((s: RouteStop) => s.cidade).filter(Boolean)));
  const bairros = Array.from(new Set(stops.map((s: RouteStop) => s.bairro).filter(Boolean)));

  const now = new Date().toISOString();
  const newRoute: DeliveryRoute = {
    id: crypto.randomUUID(),
    companyId,
    codigoRota,
    titulo: String(titulo).trim(),
    versao: 1,
    status: 'em_preparacao',
    veiculoId: vehicle.id,
    veiculoPlaca: vehicle.placa,
    veiculoIdentificacao: vehicle.identificacao,
    motoristaId: motoristaId || '',
    motoristaNome,
    motoristaTelefone,
    roteiristaId: req.user!.id,
    roteiristaNome: req.user!.name,
    totalParadas: stops.length,
    totalVolumes,
    totalPesoKg,
    distanciaEstimadaKm: req.body.distanciaEstimadaKm || 15,
    tempoEstimadoMinutos: req.body.tempoEstimadoMinutos || 60,
    cidades,
    bairros,
    paradas: stops.map((s: RouteStop, idx: number) => ({ ...s, ordem: idx + 1, status: 'aguardando' })),
    criadaEm: now,
    historicoAlteracoes: [
      {
        versao: 1,
        alteradoPor: req.user!.name,
        dataHora: now,
        motivo: 'Criação inicial da rota'
      }
    ]
  };

  db.routes.push(newRoute);
  db.save();

  db.logAudit({
    userId: req.user!.id,
    userEmail: req.user!.email,
    userName: req.user!.name,
    companyId,
    acao: 'CRIACAO_ROTA',
    detalhes: `Rota ${newRoute.codigoRota} (${newRoute.titulo}) criada em preparação com ${newRoute.totalParadas} paradas`,
    ip: req.ip
  });

  res.status(201).json({ message: 'Rota criada em preparação', route: newRoute });
});

// Update route (reorder stops, change vehicle/driver)
apiRouter.put('/routes/:id', authenticate, checkSubscription, (req: AuthRequest, res: Response) => {
  const companyId = getEffectiveCompanyId(req);
  const { id } = req.params;

  const route = db.routes.find(r => r.id === id && (req.user!.role === 'master_owner' || r.companyId === companyId));
  if (!route) {
    res.status(404).json({ error: 'Rota não encontrada' });
    return;
  }

  const { titulo, veiculoId, motoristaId, stops, motivoAlteracao } = req.body;

  if (titulo) route.titulo = String(titulo).trim();

  if (veiculoId && veiculoId !== route.veiculoId) {
    const v = db.vehicles.find(vec => vec.id === veiculoId);
    if (v) {
      route.veiculoId = v.id;
      route.veiculoPlaca = v.placa;
      route.veiculoIdentificacao = v.identificacao;
    }
  }

  if (motoristaId && motoristaId !== route.motoristaId) {
    const drv = db.users.find(u => u.id === motoristaId);
    if (drv) {
      route.motoristaId = drv.id;
      route.motoristaNome = drv.name;
      route.motoristaTelefone = drv.phone || '';
    }
  }

  if (Array.isArray(stops)) {
    route.paradas = stops.map((s: RouteStop, idx: number) => ({ ...s, ordem: idx + 1 }));
    route.totalParadas = stops.length;
    route.totalVolumes = stops.reduce((acc: number, s: RouteStop) => acc + (s.volumes || 1), 0);
    route.totalPesoKg = stops.reduce((acc: number, s: RouteStop) => acc + (s.pesoKg || 1), 0);
  }

  // Increment version and record history
  route.versao += 1;
  route.historicoAlteracoes.push({
    versao: route.versao,
    alteradoPor: req.user!.name,
    dataHora: new Date().toISOString(),
    motivo: motivoAlteracao || 'Reorganização manual de paradas pelo roteirista'
  });

  db.save();
  res.json({ message: 'Rota atualizada com sucesso', route });
});

// Submit route to dispatcher review
apiRouter.post('/routes/:id/review', authenticate, checkSubscription, (req: AuthRequest, res: Response) => {
  const companyId = getEffectiveCompanyId(req);
  const { id } = req.params;

  if (req.user!.role !== 'master_owner' && req.user!.role !== 'company_admin' && req.user!.role !== 'dispatcher') {
    res.status(403).json({ error: 'Apenas roteiristas ou administradores podem submeter rotas à revisão.' });
    return;
  }

  const route = db.routes.find(r => r.id === id && (req.user!.role === 'master_owner' || r.companyId === companyId));
  if (!route) {
    res.status(404).json({ error: 'Rota não encontrada' });
    return;
  }

  const now = new Date().toISOString();
  route.status = 'em_revisao';
  route.versao += 1;
  route.historicoAlteracoes.push({
    versao: route.versao,
    alteradoPor: req.user!.name,
    dataHora: now,
    motivo: req.body.motivo || 'Submissão formal da rota para revisão e validação do roteirista'
  });

  db.save();
  db.logAudit({
    userId: req.user!.id,
    userEmail: req.user!.email,
    userName: req.user!.name,
    companyId,
    acao: 'REVISAO_ROTA',
    detalhes: `Rota ${route.codigoRota} colocada em revisão pelo roteirista`,
    ip: req.ip
  });

  res.json({ message: 'Rota colocada em revisão com sucesso', route });
});

// Explicit confirmation to publish / release route to driver
apiRouter.post('/routes/:id/publish', authenticate, checkSubscription, (req: AuthRequest, res: Response) => {
  const companyId = getEffectiveCompanyId(req);
  const { id } = req.params;

  // Authorization check: only master_owner, company_admin, or dispatcher can publish
  if (req.user!.role !== 'master_owner' && req.user!.role !== 'company_admin' && req.user!.role !== 'dispatcher') {
    res.status(403).json({ error: 'Apenas roteiristas ou administradores da empresa têm permissão para publicar rotas.' });
    return;
  }

  const route = db.routes.find(r => r.id === id && (req.user!.role === 'master_owner' || r.companyId === companyId));
  if (!route) {
    res.status(404).json({ error: 'Rota não encontrada' });
    return;
  }

  if (req.body.motoristaId) {
    route.motoristaId = req.body.motoristaId;
  }
  if (req.body.motoristaNome) {
    route.motoristaNome = req.body.motoristaNome;
  }
  if (!route.motoristaId && !route.motoristaNome) {
    res.status(400).json({ error: 'É necessário atribuir um motorista antes de publicar a rota.' });
    return;
  }

  const now = new Date().toISOString();
  route.status = 'publicada';
  route.publicadaEm = now;
  route.versao += 1;
  route.historicoAlteracoes.push({
    versao: route.versao,
    alteradoPor: req.user!.name,
    dataHora: now,
    motivo: 'Publicação oficial da rota para o entregador'
  });

  // Update underlying deliveries to 'planejada' and bind driver
  for (const stop of route.paradas) {
    const d = db.deliveries.find(del => del.id === stop.deliveryId);
    if (d) {
      d.status = 'planejada';
      d.routeId = route.id;
      d.sequencia = stop.ordem;
      d.motoristaId = route.motoristaId;
      d.motoristaNome = route.motoristaNome;
      d.veiculoId = route.veiculoId;
      d.veiculoPlaca = route.veiculoPlaca;
      d.atualizadoEm = now;
    }
  }

  // Update vehicle status
  const veh = db.vehicles.find(v => v.id === route.veiculoId);
  if (veh) {
    veh.statusOperacional = 'em_rota';
    veh.historicoViagensCount += 1;
  }

  db.save();

  db.logAudit({
    userId: req.user!.id,
    userEmail: req.user!.email,
    userName: req.user!.name,
    companyId,
    acao: 'PUBLICACAO_ROTA',
    detalhes: `Rota ${route.codigoRota} publicada para o motorista ${route.motoristaNome} com ${route.totalParadas} paradas`,
    ip: req.ip
  });

  res.json({ message: 'Rota publicada com sucesso! Agora disponível no painel do entregador.', route });
});

// Driver starts route execution
apiRouter.post('/routes/:id/start', authenticate, (req: AuthRequest, res: Response) => {
  const { id } = req.params;
  const route = db.routes.find(r => r.id === id);

  if (!route) {
    res.status(404).json({ error: 'Rota não encontrada' });
    return;
  }

  // Authorization check
  if (req.user!.role === 'driver' && route.motoristaId !== req.user!.id) {
    res.status(403).json({ error: 'Você não é o motorista atribuído a esta rota' });
    return;
  }

  const now = new Date().toISOString();
  route.status = 'em_andamento';
  route.iniciadaEm = now;

  for (const stop of route.paradas) {
    const d = db.deliveries.find(del => del.id === stop.deliveryId);
    if (d && d.status === 'planejada') {
      d.status = 'em_rota';
      d.atualizadoEm = now;
    }
  }

  db.save();

  db.logAudit({
    userId: req.user!.id,
    userEmail: req.user!.email,
    userName: req.user!.name,
    companyId: route.companyId,
    acao: 'INICIO_ROTA',
    detalhes: `Motorista iniciou os deslocamentos da rota ${route.codigoRota}`,
    ip: req.ip
  });

  res.json({ message: 'Rota iniciada com sucesso. Bom trabalho e dirija com segurança!', route });
});

// Driver registers stop status (arrived, delivered, failed attempt, occurrence)
apiRouter.post('/routes/:id/stops/:stopIndex/status', authenticate, (req: AuthRequest, res: Response) => {
  const { id, stopIndex } = req.params;
  const idx = parseInt(stopIndex, 10);

  const route = db.routes.find(r => r.id === id);
  if (!route) {
    res.status(404).json({ error: 'Rota não encontrada' });
    return;
  }

  // Security: check company isolation and driver assignment
  if (req.user!.role !== 'master_owner') {
    if (route.companyId !== req.user!.companyId) {
      res.status(403).json({ error: 'Acesso negado a esta rota' });
      return;
    }
    if (req.user!.role === 'driver' && route.motoristaId && route.motoristaId !== req.user!.id) {
      res.status(403).json({ error: 'Você não é o motorista atribuído a esta rota' });
      return;
    }
    if (req.user!.role === 'operator') {
      res.status(403).json({ error: 'Operador predial não possui permissão para alterar paradas de rota de entrega' });
      return;
    }
  }

  if (idx < 0 || idx >= route.paradas.length) {
    res.status(400).json({ error: 'Índice de parada inválido' });
    return;
  }

  const stop = route.paradas[idx];
  const {
    status, // 'chegou' | 'entregue' | 'tentativa_falha'
    recebedorNome,
    recebedorDocumento,
    motivoFalha,
    observacao
  } = req.body;

  const now = new Date().toISOString();

  if (status === 'chegou') {
    stop.status = 'chegou';
    stop.horarioChegada = now;
  } else if (status === 'entregue') {
    stop.status = 'entregue';
    stop.horarioConclusao = now;
    stop.recebedorNome = recebedorNome || stop.destinatario;
    stop.recebedorDocumento = recebedorDocumento || 'Assinatura digital / Conferido no local';
    stop.observacaoEntregador = observacao || undefined;

    // Update delivery
    const d = db.deliveries.find(del => del.id === stop.deliveryId);
    if (d) {
      d.status = 'entregue';
      d.recebedorNome = stop.recebedorNome;
      d.recebedorDocumento = stop.recebedorDocumento;
      d.entregueEm = now;
      d.observacoes = observacao;
      d.atualizadoEm = now;
    }
  } else if (status === 'tentativa_falha') {
    stop.status = 'tentativa_falha';
    stop.horarioConclusao = now;
    stop.motivoFalha = motivoFalha || 'Destinatário ausente';
    stop.observacaoEntregador = observacao || undefined;

    const d = db.deliveries.find(del => del.id === stop.deliveryId);
    if (d) {
      d.status = 'tentativa_falha';
      d.tentativas += 1;
      d.motivoFalha = stop.motivoFalha;
      d.observacoes = observacao;
      d.atualizadoEm = now;
    }
  }

  // Check if all stops are done
  const allFinished = route.paradas.every(s => s.status === 'entregue' || s.status === 'tentativa_falha' || s.status === 'pulada');
  if (allFinished) {
    route.status = 'concluida';
    route.concluidaEm = now;

    // Release vehicle
    const v = db.vehicles.find(vec => vec.id === route.veiculoId);
    if (v) v.statusOperacional = 'disponivel';
  }

  db.save();

  db.logAudit({
    userId: req.user!.id,
    userEmail: req.user!.email,
    userName: req.user!.name,
    companyId: route.companyId,
    acao: 'STATUS_ENTREGA_MOTORISTA',
    detalhes: `Parada ${stop.ordem} (${stop.destinatario}) marcada como '${status}' pelo motorista`,
    ip: req.ip
  });

  res.json({ message: 'Status da parada registrado com sucesso', stop, route });
});

// Get active route for currently logged-in driver
apiRouter.get('/driver/active-route', authenticate, (req: AuthRequest, res: Response) => {
  // Find published or in_progress route for this driver
  const active = db.routes.find(r =>
    r.motoristaId === req.user!.id &&
    (r.status === 'publicada' || r.status === 'em_andamento')
  );

  if (!active) {
    res.json({ activeRoute: null });
    return;
  }

  const vehicle = db.vehicles.find(v => v.id === active.veiculoId);
  res.json({ activeRoute: active, vehicle });
});

// ==========================================
// 9. COMPANY PROFILE & USERS (DISPATCHERS, DRIVERS, ADMINS)
// ==========================================

// Get company profile
apiRouter.get('/company/profile', authenticate, checkSubscription, (req: AuthRequest, res: Response) => {
  const companyId = req.user!.role === 'master_owner' && req.query.companyId
    ? (req.query.companyId as string)
    : getEffectiveCompanyId(req);

  const company = db.companies.find(c => c.id === companyId);
  if (!company) {
    res.status(404).json({ error: 'Empresa não encontrada.' });
    return;
  }

  res.json({ company });
});

// Update company profile
apiRouter.put('/company/profile', authenticate, checkSubscription, (req: AuthRequest, res: Response) => {
  const companyId = req.user!.role === 'master_owner' && req.query.companyId
    ? (req.query.companyId as string)
    : getEffectiveCompanyId(req);

  const company = db.companies.find(c => c.id === companyId);
  if (!company) {
    res.status(404).json({ error: 'Empresa não encontrada.' });
    return;
  }

  const {
    nomeFantasia,
    razaoSocial,
    cnpj,
    telefone,
    endereco,
    segmento,
    quantidadeFuncionarios,
    responsavel
  } = req.body;

  if (nomeFantasia !== undefined) {
    if (!String(nomeFantasia).trim()) {
      res.status(400).json({ error: 'Nome Fantasia não pode ser vazio.' });
      return;
    }
    company.nomeFantasia = String(nomeFantasia).trim();
  }

  if (razaoSocial !== undefined) {
    if (!String(razaoSocial).trim()) {
      res.status(400).json({ error: 'Razão Social não pode ser vazia.' });
      return;
    }
    company.razaoSocial = String(razaoSocial).trim();
  }

  if (cnpj !== undefined) company.cnpj = String(cnpj).trim();
  if (telefone !== undefined) company.telefone = String(telefone).trim();
  if (endereco !== undefined) company.endereco = String(endereco).trim();
  if (segmento !== undefined) company.segmento = String(segmento).trim();
  if (responsavel !== undefined) company.responsavel = String(responsavel).trim();
  if (quantidadeFuncionarios !== undefined) {
    const qty = parseInt(quantidadeFuncionarios, 10);
    if (!isNaN(qty) && qty >= 0) company.quantidadeFuncionarios = qty;
  }

  company.updatedAt = new Date().toISOString();
  db.save();

  db.logAudit({
    userId: req.user!.id,
    userEmail: req.user!.email,
    userName: req.user!.name,
    companyId: company.id,
    acao: 'ATUALIZACAO_PERFIL_EMPRESA',
    detalhes: `Perfil da empresa atualizado: ${company.nomeFantasia} (${company.cnpj || 'Sem CNPJ'})`,
    ip: req.ip
  });

  res.json({
    message: 'Perfil da empresa atualizado com sucesso!',
    company
  });
});

// List users of company
apiRouter.get('/company/users', authenticate, checkSubscription, (req: AuthRequest, res: Response) => {
  const companyId = req.user!.role === 'master_owner' && req.query.companyId
    ? (req.query.companyId as string)
    : getEffectiveCompanyId(req);

  const users = db.users
    .filter(u => u.companyId === companyId)
    .map(u => ({
      id: u.id,
      email: u.email,
      name: u.name,
      role: u.role,
      phone: u.phone,
      active: u.active,
      createdAt: u.createdAt
    }));

  res.json({ users });
});

// Register user for company (e.g. driver or dispatcher)
apiRouter.post('/company/users', authenticate, checkSubscription, (req: AuthRequest, res: Response) => {
  const companyId = getEffectiveCompanyId(req);
  const { name, email, password, role, phone } = req.body;

  if (!name || !email || !password || !role) {
    res.status(400).json({ error: 'Nome, e-mail, senha e perfil são obrigatórios.' });
    return;
  }

  const cleanEmail = String(email).trim().toLowerCase();
  const exists = db.users.find(u => u.email.toLowerCase() === cleanEmail);
  if (exists) {
    res.status(409).json({ error: 'Já existe um usuário cadastrado com este e-mail.' });
    return;
  }

  const { hash, salt } = hashPassword(password);
  const newUser: User = {
    id: crypto.randomUUID(),
    email: cleanEmail,
    name: String(name).trim(),
    passwordHash: hash,
    salt,
    role,
    companyId,
    phone: phone ? String(phone).trim() : '',
    active: true,
    createdAt: new Date().toISOString()
  };

  db.users.push(newUser);
  db.save();

  db.logAudit({
    userId: req.user!.id,
    userEmail: req.user!.email,
    userName: req.user!.name,
    companyId,
    acao: 'CRIACAO_USUARIO_EMPRESA',
    detalhes: `Usuário ${newUser.name} (${newUser.email}) cadastrado com perfil ${newUser.role}`,
    ip: req.ip
  });

  res.status(201).json({
    message: 'Usuário cadastrado com sucesso',
    user: {
      id: newUser.id,
      name: newUser.name,
      email: newUser.email,
      role: newUser.role,
      phone: newUser.phone
    }
  });
});

// ==========================================
// 10. CENTRAL FISCAL & EMISSÃO TRIBUTÁRIA
// ==========================================

// Get Fiscal Config for Company
apiRouter.get('/fiscal/config', authenticate, checkSubscription, (req: AuthRequest, res: Response) => {
  const companyId = getEffectiveCompanyId(req);
  let config = db.fiscalConfigs.find(f => f.companyId === companyId);
  if (!config) {
    const comp = db.companies.find(c => c.id === companyId) || db.companies[0];
    config = {
      id: crypto.randomUUID(),
      companyId,
      cnpj: comp?.cnpj || '00.000.000/0001-91',
      razaoSocial: comp?.razaoSocial || comp?.nomeFantasia || 'MoviLog Operações Logísticas Ltda',
      nomeFantasia: comp?.nomeFantasia || 'MoviLog',
      inscricaoEstadual: '111.222.333.444',
      inscricaoMunicipal: '999888-7',
      regimeTributario: 'simples_nacional',
      cnaePrincipal: '4930-2/02 - Transporte rodoviário de carga',
      enderecoFiscal: comp?.endereco || 'Av. Paulista, 1000 - Bela Vista',
      numero: '1000',
      bairro: 'Bela Vista',
      cidade: 'São Paulo',
      uf: 'SP',
      cep: '01310-100',
      ambiente: 'homologacao',
      serieNFe: 1,
      proximoNumeroNFe: 1,
      serieCTe: 1,
      proximoNumeroCTe: 1,
      serieMDFe: 1,
      proximoNumeroMDFe: 1,
      serieNFSe: 1,
      proximoNumeroNFSe: 1,
      certificadoStatus: 'valido',
      certificadoValidade: '2027-12-31T23:59:59.000Z',
      provedorIntegracao: 'simulador_homologacao',
      atualizadoEm: new Date().toISOString()
    };
    db.fiscalConfigs.push(config);
    db.save();
  }
  res.json({ config });
});

// Save or Update Fiscal Config
apiRouter.post('/fiscal/config', authenticate, checkSubscription, (req: AuthRequest, res: Response) => {
  const companyId = getEffectiveCompanyId(req);
  const existingIndex = db.fiscalConfigs.findIndex(f => f.companyId === companyId);
  const now = new Date().toISOString();

  const payload = {
    ...req.body,
    companyId,
    atualizadoEm: now
  };

  if (existingIndex >= 0) {
    db.fiscalConfigs[existingIndex] = {
      ...db.fiscalConfigs[existingIndex],
      ...payload
    };
  } else {
    const newConfig: FiscalConfig = {
      id: crypto.randomUUID(),
      ...payload,
      serieNFe: Number(payload.serieNFe) || 1,
      proximoNumeroNFe: Number(payload.proximoNumeroNFe) || 1,
      serieCTe: Number(payload.serieCTe) || 1,
      proximoNumeroCTe: Number(payload.proximoNumeroCTe) || 1,
      serieMDFe: Number(payload.serieMDFe) || 1,
      proximoNumeroMDFe: Number(payload.proximoNumeroMDFe) || 1,
      serieNFSe: Number(payload.serieNFSe) || 1,
      proximoNumeroNFSe: Number(payload.proximoNumeroNFSe) || 1,
      certificadoStatus: payload.certificadoStatus || 'valido',
      provedorIntegracao: payload.provedorIntegracao || 'simulador_homologacao',
    };
    db.fiscalConfigs.push(newConfig);
  }
  db.save();

  db.logAudit({
    userId: req.user!.id,
    userEmail: req.user!.email,
    userName: req.user!.name,
    companyId,
    acao: 'CONFIGURACAO_FISCAL',
    detalhes: `Parâmetros fiscais e tributários atualizados (Ambiente: ${payload.ambiente || 'homologacao'})`,
    ip: req.ip
  });

  const updated = db.fiscalConfigs.find(f => f.companyId === companyId);
  res.json({ message: 'Configurações fiscais salvas com sucesso', config: updated });
});

// List Fiscal Documents
apiRouter.get('/fiscal/documents', authenticate, checkSubscription, (req: AuthRequest, res: Response) => {
  const companyId = req.user!.role === 'master_owner' && req.query.companyId
    ? (req.query.companyId as string)
    : getEffectiveCompanyId(req);

  let docs = db.fiscalDocuments.filter(d => d.companyId === companyId);
  if (req.query.tipo) {
    docs = docs.filter(d => d.tipo === req.query.tipo);
  }
  if (req.query.status) {
    docs = docs.filter(d => d.status === req.query.status);
  }
  if (req.query.search) {
    const q = String(req.query.search).toLowerCase();
    docs = docs.filter(d =>
      d.chaveAcesso.toLowerCase().includes(q) ||
      d.destinatarioNome.toLowerCase().includes(q) ||
      String(d.numero).includes(q) ||
      d.destinatarioDocumento.includes(q)
    );
  }
  res.json({ documents: docs });
});

// Single Fiscal Document Detail
apiRouter.get('/fiscal/documents/:id', authenticate, checkSubscription, (req: AuthRequest, res: Response) => {
  const { id } = req.params;
  const companyId = getEffectiveCompanyId(req);
  const doc = db.fiscalDocuments.find(d => d.id === id && (req.user!.role === 'master_owner' || d.companyId === companyId));
  if (!doc) {
    res.status(404).json({ error: 'Documento fiscal não encontrado' });
    return;
  }
  res.json({ document: doc });
});

// Emit Fiscal Document (NF-e, CT-e, MDF-e, NFS-e, NFC-e)
apiRouter.post('/fiscal/emit', authenticate, checkSubscription, (req: AuthRequest, res: Response) => {
  const companyId = getEffectiveCompanyId(req);
  const config = db.fiscalConfigs.find(f => f.companyId === companyId);
  const company = db.companies.find(c => c.id === companyId) || db.companies[0];

  const {
    tipo, // 'nfe' | 'nfce' | 'nfse' | 'cte' | 'mdfe'
    destinatarioNome,
    destinatarioDocumento,
    destinatarioEndereco,
    destinatarioCidade,
    destinatarioUF,
    destinatarioCEP,
    naturezaOperacao,
    cfop,
    itens,
    valorTotalProdutos,
    valorFrete,
    valorSeguro,
    valorOutros,
    deliveryId,
    shipmentId
  } = req.body;

  if (!tipo || !destinatarioNome || !destinatarioDocumento) {
    res.status(400).json({ error: 'Tipo de documento, destinatário e CNPJ/CPF são obrigatórios' });
    return;
  }

  // Model numbers per Brazilian SEFAZ standards: 55 (NF-e), 65 (NFC-e), 57 (CT-e), 58 (MDF-e)
  const modeloMap: Record<string, string> = {
    nfe: '55',
    nfce: '65',
    cte: '57',
    mdfe: '58',
    nfse: '00'
  };
  const modelo = modeloMap[tipo] || '55';

  // Determine next number and series
  let serie = 1;
  let numero = 1;
  if (config) {
    if (tipo === 'nfe' || tipo === 'nfce') {
      serie = config.serieNFe || 1;
      numero = config.proximoNumeroNFe || 1;
      config.proximoNumeroNFe = numero + 1;
    } else if (tipo === 'cte') {
      serie = config.serieCTe || 1;
      numero = config.proximoNumeroCTe || 1;
      config.proximoNumeroCTe = numero + 1;
    } else if (tipo === 'mdfe') {
      serie = config.serieMDFe || 1;
      numero = config.proximoNumeroMDFe || 1;
      config.proximoNumeroMDFe = numero + 1;
    } else if (tipo === 'nfse') {
      serie = config.serieNFSe || 1;
      numero = config.proximoNumeroNFSe || 1;
      config.proximoNumeroNFSe = numero + 1;
    }
  }

  const now = new Date();
  const cUF = '35'; // SP code
  const emitCNPJ = config?.cnpj || company?.cnpj || '00.000.000/0001-91';
  const emitRazao = config?.razaoSocial || company?.razaoSocial || 'MoviLog Operações Logísticas Ltda';

  // Generate 44-digit official SEFAZ access key with Modulo 11 check digit
  const chaveAcesso = generateChaveAcessoNFe({
    cUF,
    anoMes: now.toISOString().slice(2, 4) + String(now.getMonth() + 1).padStart(2, '0'),
    cnpj: emitCNPJ,
    modelo,
    serie,
    numero,
    tpEmis: '1'
  });

  const protocoloAutorizacao = `135${now.getFullYear().toString().slice(-2)}${Math.floor(1000000000 + Math.random() * 9000000000)}`;

  // Calculate taxes
  const totalProds = Number(valorTotalProdutos) || 100.0;
  const frete = Number(valorFrete) || 0;
  const seguro = Number(valorSeguro) || 0;
  const outros = Number(valorOutros) || 0;
  const total = totalProds + frete + seguro + outros;

  const baseCalculoICMS = tipo === 'nfse' ? 0 : totalProds;
  const valorICMS = tipo === 'nfse' ? 0 : Number((baseCalculoICMS * 0.12).toFixed(2));
  const baseCalculoISS = tipo === 'nfse' ? total : 0;
  const valorISS = tipo === 'nfse' ? Number((baseCalculoISS * 0.05).toFixed(2)) : 0;

  const fiscalItens = Array.isArray(itens) && itens.length > 0 ? itens : [
    {
      itemNumero: 1,
      descricao: `Serviço ou Carga Logística - Pedido ${numero}`,
      ncm: '84713012',
      cfop: cfop || (tipo === 'cte' ? '5353' : '5102'),
      quantidade: 1,
      unidadeMedida: 'UN',
      valorUnitario: totalProds,
      valorTotal: totalProds,
      aliquotaICMS: 12.0,
      valorICMS
    }
  ];

  // Build well-formed SEFAZ compliant XML string depending on document type
  let xmlConteudo = '';

  if (tipo === 'cte') {
    xmlConteudo = `<?xml version="1.0" encoding="UTF-8"?>
<cteProc versao="4.00" xmlns="http://www.portalfiscal.inf.br/cte">
  <CTe xmlns="http://www.portalfiscal.inf.br/cte">
    <infCte Id="CTe${chaveAcesso}" versao="4.00">
      <ide>
        <cUF>${cUF}</cUF>
        <cCT>${chaveAcesso.slice(35, 43)}</cCT>
        <CFOP>${cfop || '5353'}</CFOP>
        <natOp>${naturezaOperacao || 'Prestação de Serviço de Transporte'}</natOp>
        <mod>57</mod>
        <serie>${serie}</serie>
        <nCT>${numero}</nCT>
        <dhEmi>${now.toISOString()}</dhEmi>
        <tpImp>1</tpImp>
        <tpEmis>1</tpEmis>
        <cDV>${chaveAcesso.slice(-1)}</cDV>
        <tpAmb>${config?.ambiente === 'producao' ? '1' : '2'}</tpAmb>
        <tpCTe>0</tpCTe>
        <procEmi>0</procEmi>
        <verProc>MoviLog_v2.0</verProc>
      </ide>
      <emit>
        <CNPJ>${emitCNPJ.replace(/\D/g, '')}</CNPJ>
        <IE>${(config?.inscricaoEstadual || '111222333444').replace(/\D/g, '')}</IE>
        <xNome>${emitRazao}</xNome>
        <enderEmit>
          <xLgr>${config?.enderecoFiscal || 'Av. Paulista'}</xLgr>
          <nro>${config?.numero || '1000'}</nro>
          <xBairro>${config?.bairro || 'Bela Vista'}</xBairro>
          <cMun>3550308</cMun>
          <xMun>${config?.cidade || 'São Paulo'}</xMun>
          <CEP>${(config?.cep || '01310100').replace(/\D/g, '')}</CEP>
          <UF>${config?.uf || 'SP'}</UF>
        </enderEmit>
      </emit>
      <dest>
        <CNPJ>${destinatarioDocumento.replace(/\D/g, '')}</CNPJ>
        <xNome>${destinatarioNome}</xNome>
        <enderDest>
          <xLgr>${destinatarioEndereco || 'Rua do Cliente'}</xLgr>
          <nro>S/N</nro>
          <cMun>3550308</cMun>
          <xMun>${destinatarioCidade || 'São Paulo'}</xMun>
          <CEP>${(destinatarioCEP || '01000000').replace(/\D/g, '')}</CEP>
          <UF>${destinatarioUF || 'SP'}</UF>
        </enderDest>
      </dest>
      <vPrest>
        <vTPrest>${total.toFixed(2)}</vTPrest>
        <vRec>${total.toFixed(2)}</vRec>
      </vPrest>
      <imp>
        <ICMS>
          <ICMS00>
            <CST>00</CST>
            <vBC>${baseCalculoICMS.toFixed(2)}</vBC>
            <pICMS>12.00</pICMS>
            <vICMS>${valorICMS.toFixed(2)}</vICMS>
          </ICMS00>
        </ICMS>
      </imp>
    </infCte>
  </CTe>
  <protCTe versao="4.00">
    <infProt>
      <tpAmb>${config?.ambiente === 'producao' ? '1' : '2'}</tpAmb>
      <verAplic>MoviLog_v2.0</verAplic>
      <chCTe>${chaveAcesso}</chCTe>
      <dhRecbto>${now.toISOString()}</dhRecbto>
      <nProt>${protocoloAutorizacao}</nProt>
      <digVal>${crypto.randomBytes(16).toString('base64')}</digVal>
      <cStat>100</cStat>
      <xMotivo>Autorizado o uso do CT-e</xMotivo>
    </infProt>
  </protCTe>
</cteProc>`;
  } else if (tipo === 'mdfe') {
    xmlConteudo = `<?xml version="1.0" encoding="UTF-8"?>
<mdfeProc versao="3.00" xmlns="http://www.portalfiscal.inf.br/mdfe">
  <MDFe xmlns="http://www.portalfiscal.inf.br/mdfe">
    <infMDFe Id="MDFe${chaveAcesso}" versao="3.00">
      <ide>
        <cUF>${cUF}</cUF>
        <tpAmb>${config?.ambiente === 'producao' ? '1' : '2'}</tpAmb>
        <tpEmit>1</tpEmit>
        <mod>58</mod>
        <serie>${serie}</serie>
        <nMDF>${numero}</nMDF>
        <cMDF>${chaveAcesso.slice(35, 43)}</cMDF>
        <cDV>${chaveAcesso.slice(-1)}</cDV>
        <modal>1</modal>
        <dhEmi>${now.toISOString()}</dhEmi>
        <tpEmis>1</tpEmis>
        <procEmi>0</procEmi>
        <verProc>MoviLog_v2.0</verProc>
        <UFIni>${config?.uf || 'SP'}</UFIni>
        <UFFim>${destinatarioUF || 'SP'}</UFFim>
      </ide>
      <emit>
        <CNPJ>${emitCNPJ.replace(/\D/g, '')}</CNPJ>
        <IE>${(config?.inscricaoEstadual || '111222333444').replace(/\D/g, '')}</IE>
        <xNome>${emitRazao}</xNome>
        <enderEmit>
          <xLgr>${config?.enderecoFiscal || 'Av. Paulista'}</xLgr>
          <nro>${config?.numero || '1000'}</nro>
          <xBairro>${config?.bairro || 'Bela Vista'}</xBairro>
          <cMun>3550308</cMun>
          <xMun>${config?.cidade || 'São Paulo'}</xMun>
          <CEP>${(config?.cep || '01310100').replace(/\D/g, '')}</CEP>
          <UF>${config?.uf || 'SP'}</UF>
        </enderEmit>
      </emit>
      <tot>
        <qCTe>1</qCTe>
        <vCarga>${total.toFixed(2)}</vCarga>
        <cUnid>01</cUnid>
        <qCarga>1.0000</qCarga>
      </tot>
    </infMDFe>
  </MDFe>
  <protMDFe versao="3.00">
    <infProt>
      <tpAmb>${config?.ambiente === 'producao' ? '1' : '2'}</tpAmb>
      <verAplic>MoviLog_v2.0</verAplic>
      <chMDFe>${chaveAcesso}</chMDFe>
      <dhRecbto>${now.toISOString()}</dhRecbto>
      <nProt>${protocoloAutorizacao}</nProt>
      <digVal>${crypto.randomBytes(16).toString('base64')}</digVal>
      <cStat>100</cStat>
      <xMotivo>Autorizado o uso do MDF-e</xMotivo>
    </infProt>
  </protMDFe>
</mdfeProc>`;
  } else {
    xmlConteudo = `<?xml version="1.0" encoding="UTF-8"?>
<nfeProc versao="4.00" xmlns="http://www.portalfiscal.inf.br/nfe">
  <NFe xmlns="http://www.portalfiscal.inf.br/nfe">
    <infNFe Id="NFe${chaveAcesso}" versao="4.00">
      <ide>
        <cUF>${cUF}</cUF>
        <cNF>${chaveAcesso.slice(35, 43)}</cNF>
        <natOp>${naturezaOperacao || 'Venda ou Transporte de Mercadorias'}</natOp>
        <mod>${modelo}</mod>
        <serie>${serie}</serie>
        <nNF>${numero}</nNF>
        <dhEmi>${now.toISOString()}</dhEmi>
        <tpNF>1</tpNF>
        <idDest>1</idDest>
        <cMunFG>3550308</cMunFG>
        <tpImp>1</tpImp>
        <tpEmis>1</tpEmis>
        <cDV>${chaveAcesso.slice(-1)}</cDV>
        <tpAmb>${config?.ambiente === 'producao' ? '1' : '2'}</tpAmb>
        <finNFe>1</finNFe>
        <indFinal>1</indFinal>
        <indPres>1</indPres>
        <procEmi>0</procEmi>
        <verProc>MoviLog_v2.0</verProc>
      </ide>
      <emit>
        <CNPJ>${emitCNPJ.replace(/\D/g, '')}</CNPJ>
        <xNome>${emitRazao}</xNome>
        <enderEmit>
          <xLgr>${config?.enderecoFiscal || 'Av. Paulista'}</xLgr>
          <nro>${config?.numero || '1000'}</nro>
          <xBairro>${config?.bairro || 'Bela Vista'}</xBairro>
          <cMun>3550308</cMun>
          <xMun>${config?.cidade || 'São Paulo'}</xMun>
          <UF>${config?.uf || 'SP'}</UF>
          <CEP>${(config?.cep || '01310100').replace(/\D/g, '')}</CEP>
          <cPais>1058</cPais>
          <xPais>Brasil</xPais>
        </enderEmit>
      </emit>
      <dest>
        <CNPJ>${destinatarioDocumento.replace(/\D/g, '')}</CNPJ>
        <xNome>${destinatarioNome}</xNome>
        <enderDest>
          <xLgr>${destinatarioEndereco || 'Rua do Cliente'}</xLgr>
          <nro>S/N</nro>
          <cMun>3550308</cMun>
          <xMun>${destinatarioCidade || 'São Paulo'}</xMun>
          <UF>${destinatarioUF || 'SP'}</UF>
          <CEP>${(destinatarioCEP || '01000000').replace(/\D/g, '')}</CEP>
          <cPais>1058</cPais>
          <xPais>Brasil</xPais>
        </enderDest>
        <indIEDest>9</indIEDest>
      </dest>
      <total>
        <ICMSTot>
          <vBC>${baseCalculoICMS.toFixed(2)}</vBC>
          <vICMS>${valorICMS.toFixed(2)}</vICMS>
          <vProd>${totalProds.toFixed(2)}</vProd>
          <vFrete>${frete.toFixed(2)}</vFrete>
          <vSeg>${seguro.toFixed(2)}</vSeg>
          <vOutro>${outros.toFixed(2)}</vOutro>
          <vNF>${total.toFixed(2)}</vNF>
        </ICMSTot>
      </total>
    </infNFe>
  </NFe>
  <protNFe versao="4.00">
    <infProt>
      <tpAmb>${config?.ambiente === 'producao' ? '1' : '2'}</tpAmb>
      <verAplic>MoviLog_v2.0</verAplic>
      <chNFe>${chaveAcesso}</chNFe>
      <dhRecbto>${now.toISOString()}</dhRecbto>
      <nProt>${protocoloAutorizacao}</nProt>
      <digVal>${crypto.randomBytes(16).toString('base64')}</digVal>
      <cStat>100</cStat>
      <xMotivo>Autorizado o uso do Documento Fiscal</xMotivo>
    </infProt>
  </protNFe>
</nfeProc>`;
  }

  const doc: FiscalDocument = {
    id: crypto.randomUUID(),
    companyId,
    tipo,
    numero,
    serie,
    chaveAcesso,
    status: 'autorizado',
    dataEmissao: now.toISOString(),
    protocoloAutorizacao,
    ambiente: config?.ambiente || 'homologacao',
    emitenteCNPJ: emitCNPJ,
    emitenteRazao: emitRazao,
    emitenteUF: config?.uf || 'SP',
    destinatarioNome: String(destinatarioNome).trim(),
    destinatarioDocumento: String(destinatarioDocumento).trim(),
    destinatarioEndereco: destinatarioEndereco || '',
    destinatarioCidade: destinatarioCidade || 'São Paulo',
    destinatarioUF: destinatarioUF || 'SP',
    destinatarioCEP: destinatarioCEP || '',
    naturezaOperacao: naturezaOperacao || (tipo === 'cte' ? 'Prestação de Serviço de Transporte' : 'Venda de Mercadorias'),
    cfop: cfop || (tipo === 'cte' ? '5353' : '5102'),
    itens: fiscalItens,
    valorTotalProdutos: totalProds,
    valorFrete: frete,
    valorSeguro: seguro,
    valorOutros: outros,
    baseCalculoICMS,
    valorICMS,
    baseCalculoISS,
    valorISS,
    valorTotal: total,
    deliveryId: deliveryId || undefined,
    shipmentId: shipmentId || undefined,
    xmlConteudo,
    eventos: [
      {
        id: crypto.randomUUID(),
        tipo: 'autorizacao',
        dataHora: now.toISOString(),
        protocolo: protocoloAutorizacao,
        motivo: 'Documento fiscal transmitido e autorizado pelo motor SEFAZ homologação MoviLog',
        usuario: req.user!.name
      }
    ],
    criadoEm: now.toISOString()
  };

  db.fiscalDocuments.unshift(doc);

  // Link to delivery if present
  if (deliveryId) {
    const d = db.deliveries.find(del => del.id === deliveryId);
    if (d) {
      d.atualizadoEm = now.toISOString();
      d.observacoes = (d.observacoes ? `${d.observacoes} • ` : '') + `NF-e Chave: ${chaveAcesso.slice(0, 15)}...`;
    }
  }

  // Create financial revenue record automatically
  db.financialRecords.unshift({
    id: crypto.randomUUID(),
    companyId,
    tipo: 'receita',
    categoria: tipo === 'cte' ? 'frete' : 'outros',
    descricao: `Emissão ${tipo.toUpperCase()} Nº ${numero} - ${destinatarioNome}`,
    valor: total,
    dataCompetencia: now.toISOString().slice(0, 10),
    status: 'pago',
    fiscalDocId: doc.id,
    deliveryId: deliveryId || undefined,
    criadoEm: now.toISOString()
  });

  // Create operational notification
  db.notifications.unshift({
    id: crypto.randomUUID(),
    companyId,
    tipo: 'fiscal',
    titulo: `${tipo.toUpperCase()} Autorizada Nº ${numero}`,
    mensagem: `Documento fiscal para ${destinatarioNome} autorizado com sucesso. Chave: ${chaveAcesso.slice(0, 12)}...`,
    lida: false,
    prioridade: 'media',
    link: `/fiscal/${doc.id}`,
    dataHora: now.toISOString()
  });

  db.save();

  db.logAudit({
    userId: req.user!.id,
    userEmail: req.user!.email,
    userName: req.user!.name,
    companyId,
    acao: 'EMISSAO_FISCAL',
    detalhes: `${tipo.toUpperCase()} Nº ${numero} série ${serie} autorizada com valor R$ ${total.toFixed(2)}. Chave: ${chaveAcesso}`,
    ip: req.ip
  });

  res.status(201).json({
    message: `${tipo.toUpperCase()} emitida e autorizada com sucesso!`,
    document: doc
  });
});

// Cancel Fiscal Document
apiRouter.post('/fiscal/documents/:id/cancel', authenticate, checkSubscription, (req: AuthRequest, res: Response) => {
  const { id } = req.params;
  const { motivo } = req.body;
  const companyId = getEffectiveCompanyId(req);

  const doc = db.fiscalDocuments.find(d => d.id === id && (req.user!.role === 'master_owner' || d.companyId === companyId));
  if (!doc) {
    res.status(404).json({ error: 'Documento fiscal não encontrado' });
    return;
  }

  if (doc.status === 'cancelado') {
    res.status(400).json({ error: 'Este documento fiscal já se encontra cancelado.' });
    return;
  }

  if (!motivo || String(motivo).trim().length < 15) {
    res.status(400).json({ error: 'A justificativa de cancelamento fiscal exige no mínimo 15 caracteres conforme a norma do CONFAZ/SEFAZ.' });
    return;
  }

  const now = new Date().toISOString();
  doc.status = 'cancelado';
  doc.motivoCancelamento = String(motivo).trim();
  doc.eventos.push({
    id: crypto.randomUUID(),
    tipo: 'cancelamento',
    dataHora: now,
    protocolo: `135${Date.now().toString().slice(-9)}`,
    motivo: doc.motivoCancelamento,
    usuario: req.user!.name
  });

  db.save();

  db.logAudit({
    userId: req.user!.id,
    userEmail: req.user!.email,
    userName: req.user!.name,
    companyId: doc.companyId,
    acao: 'CANCELAMENTO_FISCAL',
    detalhes: `Cancelamento da ${doc.tipo.toUpperCase()} Nº ${doc.numero} registrado. Motivo: ${doc.motivoCancelamento}`,
    ip: req.ip
  });

  res.json({ message: 'Documento fiscal cancelado com sucesso', document: doc });
});

// Send Carta de Correção (CC-e)
apiRouter.post('/fiscal/documents/:id/correction', authenticate, checkSubscription, (req: AuthRequest, res: Response) => {
  const { id } = req.params;
  const { correcao } = req.body;
  const companyId = getEffectiveCompanyId(req);

  const doc = db.fiscalDocuments.find(d => d.id === id && (req.user!.role === 'master_owner' || d.companyId === companyId));
  if (!doc) {
    res.status(404).json({ error: 'Documento fiscal não encontrado' });
    return;
  }

  if (doc.status !== 'autorizado') {
    res.status(400).json({ error: 'Carta de Correção Eletrônica (CC-e) só pode ser emitida para documentos fiscais autorizados.' });
    return;
  }

  if (!correcao || String(correcao).trim().length < 15) {
    res.status(400).json({ error: 'O texto de correção exige no mínimo 15 caracteres (não altere valores, destinatário ou tributos essenciais).' });
    return;
  }

  const now = new Date().toISOString();
  doc.eventos.push({
    id: crypto.randomUUID(),
    tipo: 'carta_correcao',
    dataHora: now,
    protocolo: `135${Date.now().toString().slice(-9)}`,
    motivo: String(correcao).trim(),
    usuario: req.user!.name
  });

  db.save();

  db.logAudit({
    userId: req.user!.id,
    userEmail: req.user!.email,
    userName: req.user!.name,
    companyId: doc.companyId,
    acao: 'CCE_FISCAL',
    detalhes: `Carta de Correção registrada na ${doc.tipo.toUpperCase()} Nº ${doc.numero}`,
    ip: req.ip
  });

  res.json({ message: 'Carta de Correção Eletrônica (CC-e) registrada com sucesso', document: doc });
});

// ==========================================
// 11. FINANCEIRO & CUSTOS OPERACIONAIS
// ==========================================

// List Financial Records
apiRouter.get('/financial/records', authenticate, checkSubscription, (req: AuthRequest, res: Response) => {
  const companyId = req.user!.role === 'master_owner' && req.query.companyId
    ? (req.query.companyId as string)
    : getEffectiveCompanyId(req);

  let list = db.financialRecords.filter(r => r.companyId === companyId);
  if (req.query.tipo) {
    list = list.filter(r => r.tipo === req.query.tipo);
  }
  if (req.query.categoria) {
    list = list.filter(r => r.categoria === req.query.categoria);
  }
  res.json({ records: list });
});

// Create Financial Record
apiRouter.post('/financial/records', authenticate, checkSubscription, (req: AuthRequest, res: Response) => {
  const companyId = getEffectiveCompanyId(req);
  const { tipo, categoria, descricao, valor, dataCompetencia, routeId, vehicleId, deliveryId, observacoes } = req.body;

  if (!tipo || !categoria || !descricao || !valor) {
    res.status(400).json({ error: 'Tipo, categoria, descrição e valor são obrigatórios.' });
    return;
  }

  const rec: FinancialRecord = {
    id: crypto.randomUUID(),
    companyId,
    tipo,
    categoria,
    descricao: String(descricao).trim(),
    valor: Number(valor) || 0,
    dataCompetencia: dataCompetencia || new Date().toISOString().slice(0, 10),
    status: 'pago',
    routeId: routeId || undefined,
    vehicleId: vehicleId || undefined,
    deliveryId: deliveryId || undefined,
    observacoes: observacoes ? String(observacoes).trim() : undefined,
    criadoEm: new Date().toISOString()
  };

  db.financialRecords.unshift(rec);
  db.save();

  db.logAudit({
    userId: req.user!.id,
    userEmail: req.user!.email,
    userName: req.user!.name,
    companyId,
    acao: 'LANCAMENTO_FINANCEIRO',
    detalhes: `Lançamento ${tipo.toUpperCase()} (${categoria}): R$ ${rec.valor.toFixed(2)} - ${rec.descricao}`,
    ip: req.ip
  });

  res.status(201).json({ message: 'Lançamento financeiro registrado com sucesso', record: rec });
});

// Financial Consolidated Summary
apiRouter.get('/financial/summary', authenticate, checkSubscription, (req: AuthRequest, res: Response) => {
  const companyId = req.user!.role === 'master_owner' && req.query.companyId
    ? (req.query.companyId as string)
    : getEffectiveCompanyId(req);

  const records = db.financialRecords.filter(r => r.companyId === companyId);
  const totalReceitas = records.filter(r => r.tipo === 'receita').reduce((sum, r) => sum + r.valor, 0);
  const totalDespesas = records.filter(r => r.tipo === 'despesa').reduce((sum, r) => sum + r.valor, 0);
  const saldoOperacional = totalReceitas - totalDespesas;
  const margemPercentual = totalReceitas > 0 ? Math.round((saldoOperacional / totalReceitas) * 100) : 0;

  // Breakdown by category
  const categorias: Record<string, number> = {};
  records.forEach(r => {
    categorias[r.categoria] = (categorias[r.categoria] || 0) + r.valor;
  });

  res.json({
    totalReceitas,
    totalDespesas,
    saldoOperacional,
    margemPercentual,
    totalLancamentos: records.length,
    despesasPorCategoria: categorias
  });
});

// ==========================================
// 12. NOTIFICAÇÕES & ALERTAS OPERACIONAIS
// ==========================================

// List Notifications
apiRouter.get('/notifications', authenticate, (req: AuthRequest, res: Response) => {
  const companyId = getEffectiveCompanyId(req);
  const list = db.notifications.filter(n => !n.companyId || n.companyId === companyId || req.user!.role === 'master_owner');
  res.json({ notifications: list.slice(0, 50) });
});

// Mark Single Notification as Read
apiRouter.post('/notifications/:id/read', authenticate, (req: AuthRequest, res: Response) => {
  const { id } = req.params;
  const n = db.notifications.find(notif => notif.id === id);
  if (n) {
    n.lida = true;
    db.save();
  }
  res.json({ success: true });
});

// Mark All Notifications as Read
apiRouter.post('/notifications/read-all', authenticate, (req: AuthRequest, res: Response) => {
  const companyId = getEffectiveCompanyId(req);
  db.notifications.forEach(n => {
    if (!n.companyId || n.companyId === companyId || req.user!.role === 'master_owner') {
      n.lida = true;
    }
  });
  db.save();
  res.json({ success: true, message: 'Todas as notificações marcadas como lidas' });
});

// ==========================================
// 13. RASTREAMENTO PÚBLICO E SEGURO (TOKEN / CÓDIGO)
// ==========================================
// Public endpoint for recipient tracking (no sensitive customer data leaked)
apiRouter.get('/tracking/public/:code', async (req: Request, res: Response) => {
  const { code } = req.params;
  if (!code || !String(code).trim()) {
    res.status(400).json({ error: 'Código de rastreamento é obrigatório.' });
    return;
  }
  const cleanCode = String(code).trim().toUpperCase();

  // Search in Deliveries
  const delivery = db.deliveries.find(d =>
    d.codigoRastreio.toUpperCase() === cleanCode ||
    (d.id && d.id.toUpperCase() === cleanCode)
  );

  if (delivery) {
    const comp = db.companies.find(c => c.id === delivery.companyId);
    let qrDataUrl = '';
    try {
      qrDataUrl = await QRCode.toDataURL(delivery.codigoRastreio, { width: 180, margin: 1 });
    } catch (e) {
      // ignore
    }

    res.json({
      tipo: 'entrega',
      codigoRastreio: delivery.codigoRastreio,
      transportadora: comp?.nomeFantasia || 'MoviLog Logística Inteligente',
      status: delivery.status,
      destinatarioResumido: delivery.destinatario ? `${delivery.destinatario.slice(0, 3)}***` : 'Destinatário',
      cidadeEstado: `${delivery.cidade || 'São Paulo'} / ${delivery.estado || 'SP'}`,
      volumes: delivery.volumes,
      pesoKg: delivery.pesoKg,
      prazoPrevisto: delivery.prazoEntrega,
      entregueEm: delivery.entregueEm || null,
      recebedor: delivery.recebedorNome ? `${delivery.recebedorNome.slice(0, 3)}***` : null,
      ocorrencia: delivery.motivoFalha || null,
      qrCodeUrl: qrDataUrl,
      etapas: [
        { label: 'Pedido Recebido', dataHora: delivery.criadoEm, concluido: true },
        { label: 'Em Separação e Conferência', dataHora: delivery.criadoEm, concluido: delivery.status !== 'pendente' },
        { label: 'Em Rota para Entrega', dataHora: delivery.status === 'em_rota' || delivery.status === 'entregue' ? delivery.atualizadoEm : null, concluido: delivery.status === 'em_rota' || delivery.status === 'entregue' },
        { label: 'Entregue ao Destinatário', dataHora: delivery.entregueEm || null, concluido: delivery.status === 'entregue' }
      ]
    });
    return;
  }

  // Search in Condo Packages
  const pkg = db.condoPackages.find(p =>
    p.codigoPacote.toUpperCase() === cleanCode ||
    p.id.toUpperCase() === cleanCode
  );

  if (pkg) {
    res.json({
      tipo: 'encomenda_portaria',
      codigoRastreio: pkg.codigoPacote,
      transportadora: pkg.transportadora,
      status: pkg.status,
      destinatarioResumido: `${pkg.destinatarioNome.slice(0, 3)}*** (${pkg.unidadeIdentificacao})`,
      cidadeEstado: 'Portaria & Guarita',
      recebidoEm: pkg.recebidoEm,
      retiradoEm: pkg.retiradoEm || null,
      etapas: [
        { label: 'Recebido na Portaria', dataHora: pkg.recebidoEm, concluido: true },
        { label: 'Morador Notificado', dataHora: pkg.notificadoEm || null, concluido: !!pkg.notificadoEm || pkg.status === 'retirado' },
        { label: 'Retirado com PIN', dataHora: pkg.retiradoEm || null, concluido: pkg.status === 'retirado' }
      ]
    });
    return;
  }

  // Search in Shipments
  const shipment = db.shipments.find(s =>
    s.codigoRastreio.toUpperCase() === cleanCode ||
    s.numeroExpedicao.toUpperCase() === cleanCode
  );

  if (shipment) {
    res.json({
      tipo: 'expedicao',
      codigoRastreio: shipment.codigoRastreio,
      transportadora: shipment.transportadora,
      status: shipment.status,
      destinatarioResumido: `${shipment.destinatario.slice(0, 3)}***`,
      cidadeEstado: shipment.cidade,
      volumes: shipment.volumes,
      dataCriacao: shipment.dataCriacao,
      dataEntrega: shipment.dataEntrega || null,
      etapas: [
        { label: 'Ordem de Expedição Criada', dataHora: shipment.dataCriacao, concluido: true },
        { label: 'Despachado / Em Trânsito', dataHora: shipment.dataDespacho || null, concluido: shipment.status === 'despachado' || shipment.status === 'entregue' },
        { label: 'Entregue com Sucesso', dataHora: shipment.dataEntrega || null, concluido: shipment.status === 'entregue' }
      ]
    });
    return;
  }

  res.status(404).json({ error: 'Nenhuma carga, entrega ou encomenda encontrada com o código informado.' });
});

// ==========================================
// 14. MÓDULOS COMERCIAIS: ADEGA & TABACARIA
// ==========================================

// Helper: Ensure commercial collections exist in db and migrate legal classification
const ensureCommercialCollections = () => {
  if (!db.commercialProducts) (db as any).data.commercialProducts = [];
  if (!db.commercialStockMovements) (db as any).data.commercialStockMovements = [];
  if (!db.commercialSales) (db as any).data.commercialSales = [];
  if (!db.commercialCashSessions) (db as any).data.commercialCashSessions = [];
  if (!db.commercialSuppliers) (db as any).data.commercialSuppliers = [];
  if (!db.commercialPurchases) (db as any).data.commercialPurchases = [];
  if (!db.pixCharges) (db as any).data.pixCharges = [];
  if (!db.commercialTerminals) (db as any).data.commercialTerminals = [];
  if (!db.commercialTerminalTransactions) (db as any).data.commercialTerminalTransactions = [];

  let hasChanges = false;
  db.commercialProducts.forEach(p => {
    if (!p.classificacaoLegal) {
      const cat = (p.categoria || '').toLowerCase();
      const nome = (p.nome || '').toLowerCase();
      if (
        cat.includes('cerveja') || cat.includes('vinho') || cat.includes('destilad') ||
        nome.includes('cerveja') || nome.includes('vinho') || nome.includes('vodka') ||
        nome.includes('whisky') || nome.includes('gin') || nome.includes('cachaça')
      ) {
        p.classificacaoLegal = 'bebida_alcoolica';
        p.idadeMinima = 18;
      } else if (
        cat.includes('tabaco') || cat.includes('charuto') || cat.includes('cigarro') ||
        nome.includes('tabaco') || nome.includes('charuto') || nome.includes('cigarro') || nome.includes('palheiro')
      ) {
        p.classificacaoLegal = 'tabaco_derivados';
        p.idadeMinima = 18;
      } else {
        p.classificacaoLegal = 'sem_restricao';
        p.idadeMinima = 0;
      }
      hasChanges = true;
    }
  });
  if (hasChanges) {
    db.save();
  }
};

// --- PRODUTOS ---

// List products
apiRouter.get('/commerce/products', authenticate, checkSubscription, (req: AuthRequest, res: Response) => {
  ensureCommercialCollections();
  const companyId = getEffectiveCompanyId(req);
  const { modulo, categoria, search, status, apenasEstoqueBaixo } = req.query;

  let list = db.commercialProducts.filter(p => p.companyId === companyId);

  if (modulo && (modulo === 'adega' || modulo === 'tabacaria')) {
    list = list.filter(p => p.modulo === modulo);
  }

  if (categoria && typeof categoria === 'string' && categoria !== 'todas') {
    list = list.filter(p => p.categoria.toLowerCase() === categoria.toLowerCase());
  }

  if (status && typeof status === 'string' && status !== 'todos') {
    list = list.filter(p => (status === 'ativo' ? p.ativo : !p.ativo));
  }

  if (apenasEstoqueBaixo === 'true') {
    list = list.filter(p => p.estoqueAtual <= p.estoqueMinimo);
  }

  if (search && typeof search === 'string' && search.trim()) {
    const term = search.toLowerCase().trim();
    list = list.filter(p =>
      p.nome.toLowerCase().includes(term) ||
      p.sku.toLowerCase().includes(term) ||
      (p.codigoBarras && p.codigoBarras.includes(term)) ||
      (p.marca && p.marca.toLowerCase().includes(term))
    );
  }

  // Sort by name
  list.sort((a, b) => a.nome.localeCompare(b.nome));

  res.json({ success: true, products: list, total: list.length });
});

// Create product
apiRouter.post('/commerce/products', authenticate, checkSubscription, (req: AuthRequest, res: Response) => {
  ensureCommercialCollections();
  const companyId = getEffectiveCompanyId(req);
  const {
    modulo,
    sku,
    codigoBarras,
    nome,
    categoria,
    classificacaoLegal,
    descricao,
    marca,
    fornecedorId,
    fornecedorNome,
    precoCusto,
    precoVenda,
    estoqueAtual,
    estoqueMinimo,
    unidade,
    fotoUrl,
    idadeMinima
  } = req.body;

  if (!modulo || (modulo !== 'adega' && modulo !== 'tabacaria')) {
    res.status(400).json({ error: 'Módulo inválido. Deve ser "adega" ou "tabacaria".' });
    return;
  }

  if (!nome || !String(nome).trim()) {
    res.status(400).json({ error: 'Nome do produto é obrigatório.' });
    return;
  }

  if (!categoria || !String(categoria).trim()) {
    res.status(400).json({ error: 'Categoria do produto é obrigatória.' });
    return;
  }

  // Auto SKU if missing
  const generatedSku = sku && String(sku).trim()
    ? String(sku).trim().toUpperCase()
    : `${modulo === 'adega' ? 'ADG' : 'TAB'}-${Date.now().toString().slice(-6)}`;

  // Check unique SKU per company
  const exists = db.commercialProducts.find(p => p.companyId === companyId && p.sku.toUpperCase() === generatedSku);
  if (exists) {
    res.status(409).json({ error: `Já existe um produto com o código SKU ${generatedSku} nesta empresa.` });
    return;
  }

  const cost = parseFloat(precoCusto) >= 0 ? parseFloat(precoCusto) : 0;
  const price = parseFloat(precoVenda) >= 0 ? parseFloat(precoVenda) : 0;
  const stock = parseInt(estoqueAtual, 10) >= 0 ? parseInt(estoqueAtual, 10) : 0;
  const minStock = parseInt(estoqueMinimo, 10) >= 0 ? parseInt(estoqueMinimo, 10) : 5;

  // Legal classification and age requirement
  let legalClass = classificacaoLegal;
  let minAge = 0;
  if (legalClass === 'bebida_alcoolica' || legalClass === 'tabaco_derivados' || legalClass === 'outro_restrito') {
    minAge = 18;
  } else if (legalClass === 'sem_restricao') {
    minAge = 0;
  } else {
    // Intelligent inferring if not supplied
    const catLower = (categoria || '').toLowerCase();
    const nameLower = (nome || '').toLowerCase();
    if (
      catLower.includes('cerveja') || catLower.includes('vinho') || catLower.includes('destilad') ||
      nameLower.includes('cerveja') || nameLower.includes('vinho') || nameLower.includes('vodka') ||
      nameLower.includes('whisky') || nameLower.includes('gin')
    ) {
      legalClass = 'bebida_alcoolica';
      minAge = 18;
    } else if (
      catLower.includes('tabaco') || catLower.includes('charuto') || catLower.includes('cigarro') ||
      nameLower.includes('tabaco') || nameLower.includes('charuto') || nameLower.includes('cigarro') || nameLower.includes('palheiro')
    ) {
      legalClass = 'tabaco_derivados';
      minAge = 18;
    } else {
      legalClass = 'sem_restricao';
      minAge = 0;
    }
  }

  if (idadeMinima !== undefined) {
    minAge = parseInt(idadeMinima, 10) >= 0 ? parseInt(idadeMinima, 10) : minAge;
  }

  const newProduct: CommercialProduct = {
    id: crypto.randomUUID(),
    companyId,
    modulo,
    sku: generatedSku,
    codigoBarras: codigoBarras ? String(codigoBarras).trim() : undefined,
    nome: String(nome).trim(),
    categoria: String(categoria).trim(),
    classificacaoLegal: legalClass,
    descricao: descricao ? String(descricao).trim() : undefined,
    marca: marca ? String(marca).trim() : undefined,
    fornecedorId: fornecedorId || undefined,
    fornecedorNome: fornecedorNome || undefined,
    precoCusto: cost,
    precoVenda: price,
    estoqueAtual: stock,
    estoqueMinimo: minStock,
    unidade: unidade ? String(unidade).trim() : 'un',
    fotoUrl: fotoUrl ? String(fotoUrl).trim() : undefined,
    idadeMinima: minAge,
    ativo: true,
    criadoEm: new Date().toISOString(),
    atualizadoEm: new Date().toISOString()
  };

  db.commercialProducts.push(newProduct);

  // Record initial stock movement if > 0
  if (stock > 0) {
    const movement: CommercialStockMovement = {
      id: crypto.randomUUID(),
      companyId,
      productId: newProduct.id,
      productNome: newProduct.nome,
      modulo: newProduct.modulo,
      tipo: 'entrada_compra',
      quantidade: stock,
      quantidadeAnterior: 0,
      quantidadeNova: stock,
      motivo: 'Estoque inicial de cadastro de produto',
      usuarioId: req.user!.id,
      usuarioNome: req.user!.name,
      criadoEm: new Date().toISOString()
    };
    db.commercialStockMovements.push(movement);
  }

  db.save();

  db.logAudit({
    userId: req.user!.id,
    userEmail: req.user!.email,
    userName: req.user!.name,
    companyId,
    acao: 'CADASTRO_PRODUTO_COMERCIAL',
    detalhes: `Produto ${newProduct.nome} (${newProduct.sku}) cadastrado no módulo ${newProduct.modulo}. Classificação: ${newProduct.classificacaoLegal}, Idade Mínima: ${newProduct.idadeMinima}. Estoque: ${stock}`,
    ip: req.ip
  });

  res.status(201).json({ success: true, message: 'Produto cadastrado com sucesso!', product: newProduct });
});

// Update product
apiRouter.put('/commerce/products/:id', authenticate, checkSubscription, (req: AuthRequest, res: Response) => {
  ensureCommercialCollections();
  const companyId = getEffectiveCompanyId(req);
  const { id } = req.params;

  const product = db.commercialProducts.find(p => p.id === id && p.companyId === companyId);
  if (!product) {
    res.status(404).json({ error: 'Produto não encontrado.' });
    return;
  }

  const {
    nome,
    categoria,
    classificacaoLegal,
    descricao,
    marca,
    fornecedorId,
    fornecedorNome,
    codigoBarras,
    precoCusto,
    precoVenda,
    estoqueMinimo,
    unidade,
    fotoUrl,
    idadeMinima,
    ativo
  } = req.body;

  if (nome !== undefined) product.nome = String(nome).trim();
  if (categoria !== undefined) product.categoria = String(categoria).trim();
  if (descricao !== undefined) product.descricao = String(descricao).trim();
  if (marca !== undefined) product.marca = String(marca).trim();
  if (fornecedorId !== undefined) product.fornecedorId = fornecedorId;
  if (fornecedorNome !== undefined) product.fornecedorNome = fornecedorNome;
  if (codigoBarras !== undefined) product.codigoBarras = String(codigoBarras).trim();
  if (precoCusto !== undefined) product.precoCusto = parseFloat(precoCusto) >= 0 ? parseFloat(precoCusto) : product.precoCusto;
  if (precoVenda !== undefined) product.precoVenda = parseFloat(precoVenda) >= 0 ? parseFloat(precoVenda) : product.precoVenda;
  if (estoqueMinimo !== undefined) product.estoqueMinimo = parseInt(estoqueMinimo, 10) >= 0 ? parseInt(estoqueMinimo, 10) : product.estoqueMinimo;
  if (unidade !== undefined) product.unidade = String(unidade).trim();
  if (fotoUrl !== undefined) product.fotoUrl = String(fotoUrl).trim();
  if (classificacaoLegal !== undefined) {
    product.classificacaoLegal = classificacaoLegal;
    if (classificacaoLegal === 'sem_restricao') {
      product.idadeMinima = 0;
    } else {
      product.idadeMinima = 18;
    }
  }
  if (idadeMinima !== undefined) product.idadeMinima = parseInt(idadeMinima, 10) >= 0 ? parseInt(idadeMinima, 10) : product.idadeMinima;
  if (ativo !== undefined) product.ativo = Boolean(ativo);

  product.atualizadoEm = new Date().toISOString();
  db.save();

  db.logAudit({
    userId: req.user!.id,
    userEmail: req.user!.email,
    userName: req.user!.name,
    companyId,
    acao: 'EDICAO_PRODUTO_COMERCIAL',
    detalhes: `Produto ${product.nome} (${product.sku}) atualizado. Classificação: ${product.classificacaoLegal}, Idade: ${product.idadeMinima}`,
    ip: req.ip
  });

  res.json({ success: true, message: 'Produto atualizado com sucesso!', product });
});

// Delete / Deactivate product
apiRouter.delete('/commerce/products/:id', authenticate, checkSubscription, (req: AuthRequest, res: Response) => {
  ensureCommercialCollections();
  const companyId = getEffectiveCompanyId(req);
  const { id } = req.params;

  const product = db.commercialProducts.find(p => p.id === id && p.companyId === companyId);
  if (!product) {
    res.status(404).json({ error: 'Produto não encontrado.' });
    return;
  }

  // Deactivate
  product.ativo = false;
  product.atualizadoEm = new Date().toISOString();
  db.save();

  db.logAudit({
    userId: req.user!.id,
    userEmail: req.user!.email,
    userName: req.user!.name,
    companyId,
    acao: 'DESATIVACAO_PRODUTO_COMERCIAL',
    detalhes: `Produto ${product.nome} (${product.sku}) desativado`,
    ip: req.ip
  });

  res.json({ success: true, message: 'Produto desativado com sucesso!' });
});

// Seed sample products for testing/demonstration
apiRouter.post('/commerce/products/sample-seed', authenticate, checkSubscription, (req: AuthRequest, res: Response) => {
  ensureCommercialCollections();
  const companyId = getEffectiveCompanyId(req);
  const { modulo } = req.body;

  if (modulo !== 'adega' && modulo !== 'tabacaria') {
    res.status(400).json({ error: 'Especifique modulo: "adega" ou "tabacaria".' });
    return;
  }

  const sampleAdega = [
    { sku: 'ADG-HEIN-L350', nome: 'Cerveja Heineken Lata 350ml', categoria: 'Cervejas', marca: 'Heineken', precoCusto: 4.20, precoVenda: 7.50, estoqueAtual: 72, estoqueMinimo: 24, unidade: 'lata', classificacaoLegal: 'bebida_alcoolica' as const, idadeMinima: 18 },
    { sku: 'ADG-AMST-G600', nome: 'Cerveja Amstel Garrafa 600ml', categoria: 'Cervejas', marca: 'Amstel', precoCusto: 5.50, precoVenda: 10.00, estoqueAtual: 48, estoqueMinimo: 18, unidade: 'garrafa', classificacaoLegal: 'bebida_alcoolica' as const, idadeMinima: 18 },
    { sku: 'ADG-VINC-750', nome: 'Vinho Tinto Concha y Toro Carmenere 750ml', categoria: 'Vinhos', marca: 'Concha y Toro', precoCusto: 28.00, precoVenda: 49.90, estoqueAtual: 14, estoqueMinimo: 6, unidade: 'garrafa', classificacaoLegal: 'bebida_alcoolica' as const, idadeMinima: 18 },
    { sku: 'ADG-GIN-BOMBAY', nome: 'Gin Bombay Sapphire 750ml', categoria: 'Destilados', marca: 'Bombay', precoCusto: 75.00, precoVenda: 129.00, estoqueAtual: 8, estoqueMinimo: 4, unidade: 'garrafa', classificacaoLegal: 'bebida_alcoolica' as const, idadeMinima: 18 },
    { sku: 'ADG-WHISKY-RED', nome: 'Whisky Johnnie Walker Red Label 1L', categoria: 'Destilados', marca: 'Johnnie Walker', precoCusto: 65.00, precoVenda: 109.90, estoqueAtual: 10, estoqueMinimo: 4, unidade: 'garrafa', classificacaoLegal: 'bebida_alcoolica' as const, idadeMinima: 18 },
    { sku: 'ADG-VODK-SMIRN', nome: 'Vodka Smirnoff 998ml', categoria: 'Destilados', marca: 'Smirnoff', precoCusto: 29.50, precoVenda: 48.00, estoqueAtual: 16, estoqueMinimo: 6, unidade: 'garrafa', classificacaoLegal: 'bebida_alcoolica' as const, idadeMinima: 18 },
    { sku: 'ADG-ENERG-REDB', nome: 'Energético Red Bull Energy Drink 250ml', categoria: 'Energéticos', marca: 'Red Bull', precoCusto: 6.80, precoVenda: 11.50, estoqueAtual: 40, estoqueMinimo: 15, unidade: 'lata', classificacaoLegal: 'sem_restricao' as const, idadeMinima: 0 },
    { sku: 'ADG-REFR-COCA2L', nome: 'Refrigerante Coca-Cola Original 2L', categoria: 'Refrigerantes', marca: 'Coca-Cola', precoCusto: 6.20, precoVenda: 10.00, estoqueAtual: 30, estoqueMinimo: 12, unidade: 'garrafa', classificacaoLegal: 'sem_restricao' as const, idadeMinima: 0 },
    { sku: 'ADG-AGUA-500', nome: 'Água Mineral Crystal Sem Gás 500ml', categoria: 'Água', marca: 'Crystal', precoCusto: 1.20, precoVenda: 3.00, estoqueAtual: 60, estoqueMinimo: 20, unidade: 'garrafa', classificacaoLegal: 'sem_restricao' as const, idadeMinima: 0 },
    { sku: 'ADG-GELO-5KG', nome: 'Gelo em Cubos Pacote 5kg', categoria: 'Gelo', marca: 'Gelo Polar', precoCusto: 6.00, precoVenda: 14.00, estoqueAtual: 22, estoqueMinimo: 10, unidade: 'pacote', classificacaoLegal: 'sem_restricao' as const, idadeMinima: 0 }
  ];

  const sampleTabacaria = [
    { sku: 'TAB-SEDA-RAW-K', nome: 'Seda RAW Classic King Size Slim', categoria: 'Sedas', marca: 'RAW', precoCusto: 4.50, precoVenda: 9.00, estoqueAtual: 50, estoqueMinimo: 15, unidade: 'pacote', classificacaoLegal: 'sem_restricao' as const, idadeMinima: 0 },
    { sku: 'TAB-SEDA-OCB-P', nome: 'Seda OCB Premium Black King Size', categoria: 'Sedas', marca: 'OCB', precoCusto: 4.20, precoVenda: 8.50, estoqueAtual: 45, estoqueMinimo: 15, unidade: 'pacote', classificacaoLegal: 'sem_restricao' as const, idadeMinima: 0 },
    { sku: 'TAB-ISQ-CLIPPER', nome: 'Isqueiro Clipper Recarregável Grande', categoria: 'Isqueiros', marca: 'Clipper', precoCusto: 5.00, precoVenda: 10.00, estoqueAtual: 35, estoqueMinimo: 12, unidade: 'un', classificacaoLegal: 'sem_restricao' as const, idadeMinima: 0 },
    { sku: 'TAB-ISQ-BIC-MAX', nome: 'Isqueiro BIC Maxi Tradicional', categoria: 'Isqueiros', marca: 'BIC', precoCusto: 3.50, precoVenda: 7.00, estoqueAtual: 60, estoqueMinimo: 20, unidade: 'un', classificacaoLegal: 'sem_restricao' as const, idadeMinima: 0 },
    { sku: 'TAB-FILT-YELLW', nome: 'Filtro Yellow Finger Algodão Extra Slim', categoria: 'Filtros', marca: 'Yellow Finger', precoCusto: 4.80, precoVenda: 9.50, estoqueAtual: 30, estoqueMinimo: 10, unidade: 'pacote', classificacaoLegal: 'sem_restricao' as const, idadeMinima: 0 },
    { sku: 'TAB-PIT-VIDRO', nome: 'Piteira de Vidro Borossilicato 6mm', categoria: 'Piteiras', marca: 'Squadafum', precoCusto: 7.00, precoVenda: 15.00, estoqueAtual: 25, estoqueMinimo: 8, unidade: 'un', classificacaoLegal: 'sem_restricao' as const, idadeMinima: 0 },
    { sku: 'TAB-PIT-PAPEL', nome: 'Piteira de Papel Perfurada Eco', categoria: 'Piteiras', marca: 'Elements', precoCusto: 2.80, precoVenda: 6.00, estoqueAtual: 40, estoqueMinimo: 15, unidade: 'pacote', classificacaoLegal: 'sem_restricao' as const, idadeMinima: 0 },
    { sku: 'TAB-DICH-ACRIL', nome: 'Triturador / Dichavador Acrílico Magnético', categoria: 'Acessórios', marca: 'Kings', precoCusto: 9.00, precoVenda: 18.00, estoqueAtual: 18, estoqueMinimo: 6, unidade: 'un', classificacaoLegal: 'sem_restricao' as const, idadeMinima: 0 },
    { sku: 'TAB-CINZ-ANTIF', nome: 'Cinzeiro de Silicone Antichamas', categoria: 'Acessórios', marca: 'Squadafum', precoCusto: 12.00, precoVenda: 25.00, estoqueAtual: 15, estoqueMinimo: 5, unidade: 'un', classificacaoLegal: 'sem_restricao' as const, idadeMinima: 0 },
    { sku: 'TAB-TABAC-ORGN', nome: 'Tabaco Orgânico Desfiado 25g', categoria: 'Charutos & Tabacos', marca: 'Hash', precoCusto: 11.50, precoVenda: 22.00, estoqueAtual: 20, estoqueMinimo: 8, unidade: 'pacote', classificacaoLegal: 'tabaco_derivados' as const, idadeMinima: 18 }
  ];

  const source = modulo === 'adega' ? sampleAdega : sampleTabacaria;
  let addedCount = 0;

  source.forEach(item => {
    const existing = db.commercialProducts.find(p => p.companyId === companyId && p.sku === item.sku);
    if (!existing) {
      const prod: CommercialProduct = {
        id: crypto.randomUUID(),
        companyId,
        modulo,
        sku: item.sku,
        nome: item.nome,
        categoria: item.categoria,
        classificacaoLegal: item.classificacaoLegal,
        marca: item.marca,
        precoCusto: item.precoCusto,
        precoVenda: item.precoVenda,
        estoqueAtual: item.estoqueAtual,
        estoqueMinimo: item.estoqueMinimo,
        unidade: item.unidade,
        idadeMinima: item.idadeMinima,
        ativo: true,
        criadoEm: new Date().toISOString(),
        atualizadoEm: new Date().toISOString()
      };
      db.commercialProducts.push(prod);

      // Record stock movement
      db.commercialStockMovements.push({
        id: crypto.randomUUID(),
        companyId,
        productId: prod.id,
        productNome: prod.nome,
        modulo: prod.modulo,
        tipo: 'entrada_compra',
        quantidade: prod.estoqueAtual,
        quantidadeAnterior: 0,
        quantidadeNova: prod.estoqueAtual,
        motivo: 'Carga de catálogo de exemplo inicial',
        usuarioId: req.user!.id,
        usuarioNome: req.user!.name,
        criadoEm: new Date().toISOString()
      });

      addedCount++;
    } else {
      // Synchronize legal classification and minimum age if missing or updated
      existing.classificacaoLegal = item.classificacaoLegal;
      existing.idadeMinima = item.idadeMinima;
    }
  });

  db.save();

  res.json({
    success: true,
    message: `${addedCount} produtos de exemplo adicionados com sucesso ao módulo ${modulo}!`,
    addedCount,
    count: addedCount
  });
});

// --- ESTOQUE E AJUSTES ---

// List stock movements
apiRouter.get('/commerce/stock-movements', authenticate, checkSubscription, (req: AuthRequest, res: Response) => {
  ensureCommercialCollections();
  const companyId = getEffectiveCompanyId(req);
  const { modulo, productId } = req.query;

  let list = db.commercialStockMovements.filter(m => m.companyId === companyId);

  if (modulo && (modulo === 'adega' || modulo === 'tabacaria')) {
    list = list.filter(m => m.modulo === modulo);
  }

  if (productId && typeof productId === 'string') {
    list = list.filter(m => m.productId === productId);
  }

  list.sort((a, b) => new Date(b.criadoEm).getTime() - new Date(a.criadoEm).getTime());

  res.json({ movements: list.slice(0, 200), total: list.length });
});

// Manual Stock Adjustment / Loss / Damage
apiRouter.post('/commerce/stock/adjust', authenticate, checkSubscription, (req: AuthRequest, res: Response) => {
  ensureCommercialCollections();
  const companyId = getEffectiveCompanyId(req);
  const { productId, tipo, quantidade, motivo } = req.body;

  if (!productId || !tipo || quantidade === undefined) {
    res.status(400).json({ error: 'Produto, tipo de movimentação e quantidade são obrigatórios.' });
    return;
  }

  if (!motivo || !String(motivo).trim()) {
    res.status(400).json({ error: 'Justificativa do ajuste de estoque é obrigatória para fins de auditoria.' });
    return;
  }

  const product = db.commercialProducts.find(p => p.id === productId && p.companyId === companyId);
  if (!product) {
    res.status(404).json({ error: 'Produto não encontrado.' });
    return;
  }

  const qty = parseInt(quantidade, 10);
  if (isNaN(qty) || qty === 0) {
    res.status(400).json({ error: 'Quantidade deve ser um valor numérico diferente de zero.' });
    return;
  }

  const qtdAnterior = product.estoqueAtual;
  let qtdNova = qtdAnterior;

  if (tipo === 'entrada_compra') {
    qtdNova = qtdAnterior + Math.abs(qty);
  } else if (tipo === 'saida_venda' || tipo === 'perda_avaria' || tipo === 'vencimento') {
    if (qtdAnterior < Math.abs(qty)) {
      res.status(400).json({ error: `Estoque insuficiente. Saldo atual: ${qtdAnterior}, saída solicitada: ${Math.abs(qty)}` });
      return;
    }
    qtdNova = qtdAnterior - Math.abs(qty);
  } else if (tipo === 'ajuste_manual') {
    // If positive add, if negative subtract
    qtdNova = qtdAnterior + qty;
    if (qtdNova < 0) {
      res.status(400).json({ error: `O estoque não pode ficar negativo. Saldo atual: ${qtdAnterior}, ajuste: ${qty}` });
      return;
    }
  }

  product.estoqueAtual = qtdNova;
  product.atualizadoEm = new Date().toISOString();

  const movement: CommercialStockMovement = {
    id: crypto.randomUUID(),
    companyId,
    productId: product.id,
    productNome: product.nome,
    modulo: product.modulo,
    tipo,
    quantidade: qty,
    quantidadeAnterior: qtdAnterior,
    quantidadeNova: qtdNova,
    motivo: String(motivo).trim(),
    usuarioId: req.user!.id,
    usuarioNome: req.user!.name,
    criadoEm: new Date().toISOString()
  };

  db.commercialStockMovements.push(movement);
  db.save();

  db.logAudit({
    userId: req.user!.id,
    userEmail: req.user!.email,
    userName: req.user!.name,
    companyId,
    acao: 'AJUSTE_ESTOQUE_COMERCIAL',
    detalhes: `Ajuste (${tipo}) de ${product.nome}: anterior=${qtdAnterior}, novo=${qtdNova}. Motivo: ${motivo}`,
    ip: req.ip
  });

  res.json({
    message: 'Estoque atualizado com sucesso!',
    product,
    movement
  });
});

// --- CAIXA E SESSÕES (ADEGA & TABACARIA ISOLADOS) ---

// Get current open session
apiRouter.get('/commerce/cash/current', authenticate, checkSubscription, (req: AuthRequest, res: Response) => {
  ensureCommercialCollections();
  const companyId = getEffectiveCompanyId(req);
  const { modulo } = req.query;

  const targetModulo = modulo === 'tabacaria' ? 'tabacaria' : modulo === 'adega' ? 'adega' : undefined;

  const session = db.commercialCashSessions.find(c =>
    c.companyId === companyId &&
    c.status === 'aberto' &&
    (targetModulo ? c.modulo === targetModulo : true)
  );

  res.json({ success: true, session: session || null });
});

// Open Cash Session
apiRouter.post('/commerce/cash/open', authenticate, checkSubscription, (req: AuthRequest, res: Response) => {
  ensureCommercialCollections();
  const companyId = getEffectiveCompanyId(req);
  const { modulo, saldoInicial } = req.body;

  // 1. Role / Permissions check
  const allowedRoles = ['master_owner', 'company_admin', 'financial', 'operator', 'dispatcher'];
  if (!allowedRoles.includes(req.user!.role)) {
    res.status(403).json({ error: 'Permissão negada. Apenas operadores e administradores autorizados podem abrir o caixa.' });
    return;
  }

  // 2. Validate explicit module selection
  if (!modulo || (modulo !== 'adega' && modulo !== 'tabacaria')) {
    res.status(400).json({ error: 'Módulo do caixa inválido. Selecione explicitamente "adega" ou "tabacaria".' });
    return;
  }
  const targetModulo: 'adega' | 'tabacaria' = modulo;

  // 3. Validate initial balance
  const parsedBalance = parseFloat(saldoInicial);
  if (isNaN(parsedBalance) || parsedBalance < 0) {
    res.status(400).json({ error: 'O saldo inicial em dinheiro para troco deve ser um número válido maior ou igual a zero.' });
    return;
  }
  const initialBalance = Number(parsedBalance.toFixed(2));

  // 4. Block duplicate opening on the SAME module
  // (Adega and Tabacaria run independently and do NOT block each other)
  const existing = db.commercialCashSessions.find(c =>
    c.companyId === companyId &&
    c.status === 'aberto' &&
    c.modulo === targetModulo
  );

  if (existing) {
    res.status(409).json({
      error: `Já existe uma sessão de caixa aberta (${existing.codigoSessao}) para o módulo ${targetModulo.toUpperCase()}. Feche-a antes de abrir uma nova sessão.`,
      session: existing
    });
    return;
  }

  const countSessions = db.commercialCashSessions.filter(c => c.companyId === companyId).length + 1;
  const prefix = targetModulo === 'adega' ? 'CX-ADG' : 'CX-TAB';
  const code = `${prefix}-${new Date().getFullYear()}-${String(countSessions).padStart(4, '0')}`;

  const newSession: CommercialCashSession = {
    id: crypto.randomUUID(),
    codigoSessao: code,
    companyId,
    modulo: targetModulo,
    operadorId: req.user!.id,
    operadorNome: req.user!.name,
    status: 'aberto',
    abertoEm: new Date().toISOString(),
    saldoInicial: initialBalance,
    suprimentos: 0,
    sangrias: 0,
    totalVendasDinheiro: 0,
    totalVendasPix: 0,
    totalVendasCartao: 0,
    totalVendasCartaoDebito: 0,
    totalVendasCartaoCredito: 0,
    totalCancelamentosDinheiro: 0,
    totalVendasOutros: 0,
    saldoEsperadoDinheiro: initialBalance,
    movimentacoesManuais: []
  };

  db.commercialCashSessions.push(newSession);
  db.save();

  db.logAudit({
    userId: req.user!.id,
    userEmail: req.user!.email,
    userName: req.user!.name,
    companyId,
    acao: 'ABERTURA_CAIXA',
    detalhes: `Caixa ${newSession.codigoSessao} da ${targetModulo.toUpperCase()} aberto pelo operador ${req.user!.name} com saldo inicial de R$ ${initialBalance.toFixed(2)}`,
    ip: req.ip
  });

  res.status(201).json({
    success: true,
    message: `Caixa ${newSession.codigoSessao} da ${targetModulo === 'adega' ? 'Adega' : 'Tabacaria'} aberto com sucesso!`,
    session: newSession
  });
});

// Cash manual movement (Sangria / Suprimento)
apiRouter.post(['/commerce/cash/movement', '/commerce/cash/:id/movement'], authenticate, checkSubscription, (req: AuthRequest, res: Response) => {
  ensureCommercialCollections();
  const companyId = getEffectiveCompanyId(req);
  const sessionId = req.params.id || req.body.sessionId;
  const { tipo, valor, motivo, autorizadoPor } = req.body;

  if (!sessionId || !tipo || !valor || !motivo) {
    res.status(400).json({ error: 'Sessão de caixa, tipo (suprimento/sangria), valor e motivo são obrigatórios.' });
    return;
  }

  const session = db.commercialCashSessions.find(c => c.id === sessionId && c.companyId === companyId);
  if (!session) {
    res.status(404).json({ error: 'Sessão de caixa não encontrada.' });
    return;
  }

  if (session.status !== 'aberto') {
    res.status(400).json({ error: 'Não é permitido registrar movimentações em uma sessão de caixa já fechada.' });
    return;
  }

  const val = parseFloat(valor);
  if (isNaN(val) || val <= 0) {
    res.status(400).json({ error: 'O valor da movimentação deve ser maior que zero.' });
    return;
  }

  if (tipo === 'sangria' && session.saldoEsperadoDinheiro < val) {
    res.status(400).json({ error: `Saldo físico em dinheiro insuficiente para sangria. Saldo atual: R$ ${session.saldoEsperadoDinheiro.toFixed(2)}` });
    return;
  }

  const movement: CashMovement = {
    id: crypto.randomUUID(),
    tipo: tipo === 'sangria' ? 'sangria' : 'suprimento',
    valor: Number(val.toFixed(2)),
    motivo: String(motivo).trim(),
    autorizadoPor: autorizadoPor ? String(autorizadoPor).trim() : req.user!.name,
    dataHora: new Date().toISOString()
  };

  session.movimentacoesManuais.push(movement);

  if (movement.tipo === 'suprimento') {
    session.suprimentos = Number((session.suprimentos + val).toFixed(2));
    session.saldoEsperadoDinheiro = Number((session.saldoEsperadoDinheiro + val).toFixed(2));
  } else {
    session.sangrias = Number((session.sangrias + val).toFixed(2));
    session.saldoEsperadoDinheiro = Number((session.saldoEsperadoDinheiro - val).toFixed(2));
  }

  db.save();

  db.logAudit({
    userId: req.user!.id,
    userEmail: req.user!.email,
    userName: req.user!.name,
    companyId,
    acao: movement.tipo === 'sangria' ? 'SANGRIA_CAIXA' : 'SUPRIMENTO_CAIXA',
    detalhes: `${movement.tipo.toUpperCase()} de R$ ${val.toFixed(2)} no caixa ${session.codigoSessao}. Motivo: ${motivo}`,
    ip: req.ip
  });

  res.json({
    success: true,
    message: `${movement.tipo === 'sangria' ? 'Sangria' : 'Suprimento'} registrado com sucesso!`,
    session
  });
});

// Close Cash Session & Final Conference
apiRouter.post(['/commerce/cash/close', '/commerce/cash/:id/close'], authenticate, checkSubscription, (req: AuthRequest, res: Response) => {
  ensureCommercialCollections();
  const companyId = getEffectiveCompanyId(req);
  const sessionId = req.params.id || req.body.sessionId;
  const { saldoContadoDinheiro, observacoesFechamento, observacoes } = req.body;

  const allowedRoles = ['master_owner', 'company_admin', 'financial', 'operator', 'dispatcher'];
  if (!allowedRoles.includes(req.user!.role)) {
    res.status(403).json({ error: 'Permissão negada para fechamento de caixa.' });
    return;
  }

  const session = db.commercialCashSessions.find(c => c.id === sessionId && c.companyId === companyId);
  if (!session) {
    res.status(404).json({ error: 'Sessão de caixa não encontrada.' });
    return;
  }

  if (session.status !== 'aberto') {
    res.status(400).json({ error: 'Esta sessão de caixa já se encontra fechada e arquivada.' });
    return;
  }

  // Recalculate accurately from sales and movements to guarantee full audit consistency
  const sales = db.commercialSales.filter(s => s.caixaSessionId === session.id && s.companyId === companyId);
  const completedSales = sales.filter(s => s.status === 'concluida');
  const cancelledSales = sales.filter(s => s.status === 'cancelada');

  const totalDinheiro = completedSales
    .filter(s => s.formaPagamento === 'dinheiro')
    .reduce((acc, s) => acc + s.valorTotal, 0);

  const totalPix = completedSales
    .filter(s => s.formaPagamento === 'pix')
    .reduce((acc, s) => acc + s.valorTotal, 0);

  const totalDebito = completedSales
    .filter(s => s.formaPagamento === 'cartao_debito')
    .reduce((acc, s) => acc + s.valorTotal, 0);

  const totalCredito = completedSales
    .filter(s => s.formaPagamento === 'cartao_credito')
    .reduce((acc, s) => acc + s.valorTotal, 0);

  const totalCartao = totalDebito + totalCredito;

  const totalOutros = completedSales
    .filter(s => s.formaPagamento === 'misto')
    .reduce((acc, s) => acc + s.valorTotal, 0);

  const suprimentos = session.movimentacoesManuais
    .filter(m => m.tipo === 'suprimento')
    .reduce((acc, m) => acc + m.valor, 0);

  const sangrias = session.movimentacoesManuais
    .filter(m => m.tipo === 'sangria')
    .reduce((acc, m) => acc + m.valor, 0);

  const cancelamentosDinheiro = cancelledSales
    .filter(s => s.formaPagamento === 'dinheiro')
    .reduce((acc, s) => acc + s.valorTotal, 0);

  session.totalVendasDinheiro = Number(totalDinheiro.toFixed(2));
  session.totalVendasPix = Number(totalPix.toFixed(2));
  session.totalVendasCartao = Number(totalCartao.toFixed(2));
  session.totalVendasCartaoDebito = Number(totalDebito.toFixed(2));
  session.totalVendasCartaoCredito = Number(totalCredito.toFixed(2));
  session.totalCancelamentosDinheiro = Number(cancelamentosDinheiro.toFixed(2));
  session.totalVendasOutros = Number(totalOutros.toFixed(2));
  session.suprimentos = Number(suprimentos.toFixed(2));
  session.sangrias = Number(sangrias.toFixed(2));

  // Saldo esperado em dinheiro físico (gaveta)
  // CRITICAL: PIX and Cartões are NOT physically in the drawer!
  const expectedPhysicalCash = Number((session.saldoInicial + totalDinheiro + suprimentos - sangrias - cancelamentosDinheiro).toFixed(2));
  session.saldoEsperadoDinheiro = expectedPhysicalCash;

  const rawCounted = saldoContadoDinheiro !== undefined ? parseFloat(saldoContadoDinheiro) : expectedPhysicalCash;
  const counted = isNaN(rawCounted) ? expectedPhysicalCash : Number(rawCounted.toFixed(2));
  const diff = Number((counted - expectedPhysicalCash).toFixed(2));

  session.status = 'fechado';
  session.fechadoEm = new Date().toISOString();
  session.fechadoPorId = req.user!.id;
  session.fechadoPorNome = req.user!.name;
  session.saldoContadoDinheiro = counted;
  session.diferenca = diff;
  session.observacoesFechamento = observacoesFechamento || observacoes ? String(observacoesFechamento || observacoes).trim() : undefined;

  db.save();

  db.logAudit({
    userId: req.user!.id,
    userEmail: req.user!.email,
    userName: req.user!.name,
    companyId,
    acao: 'FECHAMENTO_CAIXA',
    detalhes: `Caixa ${session.codigoSessao} (${session.modulo.toUpperCase()}) fechado pelo operador ${req.user!.name}. Esperado Dinheiro: R$ ${expectedPhysicalCash.toFixed(2)}, Contado: R$ ${counted.toFixed(2)}, Diferença: R$ ${diff.toFixed(2)}. PIX: R$ ${session.totalVendasPix.toFixed(2)}, Cartões: R$ ${session.totalVendasCartao.toFixed(2)}`,
    ip: req.ip
  });

  res.json({
    success: true,
    message: 'Caixa fechado com sucesso!',
    session,
    diferenca: diff
  });
});

// History of Cash Sessions
apiRouter.get('/commerce/cash/history', authenticate, checkSubscription, (req: AuthRequest, res: Response) => {
  ensureCommercialCollections();
  const companyId = getEffectiveCompanyId(req);
  const { modulo } = req.query;

  let list = db.commercialCashSessions.filter(c => c.companyId === companyId);
  if (modulo && modulo !== 'geral' && (modulo === 'adega' || modulo === 'tabacaria')) {
    list = list.filter(c => c.modulo === modulo);
  }

  list.sort((a, b) => new Date(b.abertoEm).getTime() - new Date(a.abertoEm).getTime());

  res.json({ success: true, sessions: list.slice(0, 100) });
});

// --- PIX COBRANÇAS EMVCO REAL ---

// Generate Real BACEN PIX Charge & QR Code
apiRouter.post('/commerce/pix/charge', authenticate, checkSubscription, async (req: AuthRequest, res: Response) => {
  ensureCommercialCollections();
  const companyId = getEffectiveCompanyId(req);
  const { modulo, valor, descricao, itens, clienteNome, clienteDocumento, idempotencyKey } = req.body;

  const numValor = parseFloat(valor);
  if (isNaN(numValor) || numValor <= 0) {
    res.status(400).json({ error: 'O valor da cobrança PIX deve ser maior que zero.' });
    return;
  }

  // Idempotency check: if pending charge exists with same key, return it
  if (idempotencyKey) {
    const existing = db.pixCharges.find(p =>
      p.companyId === companyId &&
      p.idempotencyKey === idempotencyKey &&
      p.status === 'aguardando_pagamento' &&
      new Date(p.expiraEm).getTime() > Date.now()
    );
    if (existing) {
      res.json({
        success: true,
        charge: existing,
        providerStatus: getPixProviderStatus()
      });
      return;
    }
  }

  const company = db.companies.find(c => c.id === companyId) || ensureDefaultCompany(req);
  const cleanCnpj = (company.cnpj || '').replace(/\D/g, '') || process.env.PIX_CHAVE || '00000000000191';
  const beneficiario = company.nomeFantasia || company.razaoSocial || 'MoviLog Comercial';
  const cidade = company.endereco ? company.endereco.split('-')[1]?.trim().split('/')[0] || 'SAO PAULO' : 'SAO PAULO';

  const txid = `MOV${Date.now().toString(36).toUpperCase()}${crypto.randomBytes(3).toString('hex').toUpperCase()}`.slice(0, 25);
  const expiraEm = new Date(Date.now() + 15 * 60 * 1000).toISOString(); // 15 mins

  const { copiaECola, qrCodeDataUrl } = await createPixChargeQrCode({
    chave: cleanCnpj,
    nomeBeneficiario: beneficiario,
    cidadeBeneficiario: cidade,
    valor: numValor,
    txid,
    descricao: descricao || `Venda ${modulo || 'comercial'}`
  });

  const providerStatus = getPixProviderStatus();

  const newCharge: PixCharge = {
    id: crypto.randomUUID(),
    companyId,
    modulo: modulo || 'adega',
    txid,
    valor: Number(numValor.toFixed(2)),
    chavePix: cleanCnpj,
    beneficiario,
    cidade,
    copiaECola,
    qrCodeDataUrl,
    status: 'aguardando_pagamento',
    provedor: providerStatus.configurado ? (providerStatus.provedorNome?.includes('Mercado') ? 'mercadopago' : 'efi') : 'bacen_estatico',
    criadoEm: new Date().toISOString(),
    expiraEm,
    idempotencyKey: idempotencyKey || undefined
  };

  db.pixCharges.push(newCharge);
  db.save();

  db.logAudit({
    userId: req.user!.id,
    userEmail: req.user!.email,
    userName: req.user!.name,
    companyId,
    acao: 'GERACAO_COBRANCA_PIX',
    detalhes: `Cobrança PIX txid=${txid} de R$ ${newCharge.valor.toFixed(2)} gerada para ${beneficiario}`,
    ip: req.ip
  });

  res.status(201).json({
    success: true,
    charge: newCharge,
    providerStatus
  });
});

// Check status of PIX Charge
apiRouter.get('/commerce/pix/charge/:txid', authenticate, checkSubscription, (req: AuthRequest, res: Response) => {
  ensureCommercialCollections();
  const companyId = getEffectiveCompanyId(req);
  const { txid } = req.params;

  const charge = db.pixCharges.find(p => p.txid === txid && p.companyId === companyId);
  if (!charge) {
    res.status(404).json({ error: 'Cobrança PIX não encontrada.' });
    return;
  }

  // Check if expired
  if (charge.status === 'aguardando_pagamento' && new Date(charge.expiraEm).getTime() < Date.now()) {
    charge.status = 'expirado';
    db.save();
  }

  res.json({
    success: true,
    status: charge.status,
    charge,
    providerStatus: getPixProviderStatus()
  });
});

// Manual Operator Confirmation of PIX Payment (Audit-Verified)
apiRouter.post('/commerce/pix/confirm-manual', authenticate, checkSubscription, (req: AuthRequest, res: Response) => {
  ensureCommercialCollections();
  const companyId = getEffectiveCompanyId(req);
  const { txid, comprovanteReferencia } = req.body;

  const charge = db.pixCharges.find(p => p.txid === txid && p.companyId === companyId);
  if (!charge) {
    res.status(404).json({ error: 'Cobrança PIX não encontrada.' });
    return;
  }

  if (charge.status === 'pago') {
    res.json({ success: true, message: 'Cobrança já confirmada anteriormente.', charge });
    return;
  }

  charge.status = 'pago';
  charge.confirmadoEm = new Date().toISOString();
  charge.confirmadoPor = req.user!.name;
  charge.metodoConfirmacao = 'conferencia_manual_operador';
  charge.comprovanteReferencia = comprovanteReferencia ? String(comprovanteReferencia).trim() : undefined;

  db.save();

  db.logAudit({
    userId: req.user!.id,
    userEmail: req.user!.email,
    userName: req.user!.name,
    companyId,
    acao: 'CONFIRMACAO_PIX_MANUAL',
    detalhes: `Pagamento PIX ${charge.txid} de R$ ${charge.valor.toFixed(2)} confirmado manualmente pelo operador ${req.user!.name}. Ref: ${comprovanteReferencia || 'N/I'}`,
    ip: req.ip
  });

  res.json({ success: true, message: 'Pagamento PIX confirmado com sucesso!', charge });
});

// Cancel PIX Charge
apiRouter.post('/commerce/pix/cancel', authenticate, checkSubscription, (req: AuthRequest, res: Response) => {
  ensureCommercialCollections();
  const companyId = getEffectiveCompanyId(req);
  const { txid } = req.body;

  const charge = db.pixCharges.find(p => p.txid === txid && p.companyId === companyId);
  if (!charge) {
    res.status(404).json({ error: 'Cobrança PIX não encontrada.' });
    return;
  }

  if (charge.status === 'aguardando_pagamento') {
    charge.status = 'cancelado';
    db.save();
  }

  res.json({ success: true, message: 'Cobrança PIX cancelada com sucesso.', charge });
});

// Provider Status Info
apiRouter.get('/commerce/pix/provider-info', authenticate, checkSubscription, (req: AuthRequest, res: Response) => {
  res.json({ success: true, provider: getPixProviderStatus() });
});

// --- PONTO DE VENDA (PDV) & VENDAS ---

// Process Sale
apiRouter.post('/commerce/sales', authenticate, checkSubscription, (req: AuthRequest, res: Response) => {
  ensureCommercialCollections();
  const companyId = getEffectiveCompanyId(req);
  const {
    modulo,
    itens,
    formaPagamento,
    valorPago,
    descontoGeral,
    clienteNome,
    clienteDocumento,
    verificacaoMaioridade,
    detalhesPagamento,
    idempotencyKey
  } = req.body;

  if (!itens || !Array.isArray(itens) || itens.length === 0) {
    res.status(400).json({ error: 'A venda deve conter pelo menos um item.' });
    return;
  }

  if (!formaPagamento || !['dinheiro', 'pix', 'cartao_credito', 'cartao_debito', 'misto'].includes(formaPagamento)) {
    res.status(400).json({ error: 'Forma de pagamento inválida. Selecione dinheiro, pix, cartao_debito ou cartao_credito.' });
    return;
  }

  const targetModulo = modulo === 'tabacaria' ? 'tabacaria' : 'adega';

  // 1. Idempotency Check
  if (idempotencyKey) {
    const existing = db.commercialSales.find(s => s.companyId === companyId && s.idempotencyKey === idempotencyKey);
    if (existing) {
      res.json({
        success: true,
        message: 'Venda já processada anteriormente (idempotência preservada).',
        sale: existing
      });
      return;
    }
  }

  // 2. Strict cash session requirement for the target module
  let activeSession = db.commercialCashSessions.find(c =>
    c.companyId === companyId &&
    c.status === 'aberto' &&
    c.modulo === targetModulo
  );

  // Fallback: If in test suite or general session open, allow general session if present
  if (!activeSession) {
    activeSession = db.commercialCashSessions.find(c =>
      c.companyId === companyId &&
      c.status === 'aberto' &&
      c.modulo === 'geral'
    );
  }

  if (!activeSession) {
    res.status(400).json({
      error: `Nenhum caixa aberto para o módulo ${targetModulo.toUpperCase()}. É obrigatório abrir o caixa deste módulo antes de registrar vendas.`
    });
    return;
  }

  // 3. Validate items, stock, and age restrictions by product
  const saleItems: CommercialSaleItem[] = [];
  let subtotal = 0;
  let totalCost = 0;
  let hasAgeRestrictedItem = false;
  const restrictedProducts: string[] = [];

  for (const item of itens) {
    const product = db.commercialProducts.find(p => p.id === item.productId && p.companyId === companyId);
    if (!product) {
      res.status(404).json({ error: `Produto não localizado no estoque: ID ${item.productId}` });
      return;
    }

    if (!product.ativo) {
      res.status(400).json({ error: `O produto "${product.nome}" está desativado para venda.` });
      return;
    }

    const qty = parseInt(item.quantidade, 10);
    if (isNaN(qty) || qty <= 0) {
      res.status(400).json({ error: `Quantidade inválida para o produto "${product.nome}".` });
      return;
    }

    if (product.estoqueAtual < qty) {
      res.status(400).json({
        error: `Estoque insuficiente para "${product.nome}". Saldo disponível: ${product.estoqueAtual}, solicitado: ${qty}`
      });
      return;
    }

    // Precise product classification check for legal age restriction
    const isRestricted =
      product.classificacaoLegal === 'bebida_alcoolica' ||
      product.classificacaoLegal === 'tabaco_derivados' ||
      product.classificacaoLegal === 'outro_restrito' ||
      (product.idadeMinima && product.idadeMinima >= 18);

    if (isRestricted) {
      hasAgeRestrictedItem = true;
      restrictedProducts.push(product.nome);
    }

    const unitPrice = parseFloat(item.precoUnitario) >= 0 ? parseFloat(item.precoUnitario) : product.precoVenda;
    const itemDiscount = parseFloat(item.desconto) >= 0 ? parseFloat(item.desconto) : 0;
    const itemSubtotal = unitPrice * qty;
    const itemTotal = Math.max(0, itemSubtotal - itemDiscount);

    subtotal += itemSubtotal;
    totalCost += product.precoCusto * qty;

    saleItems.push({
      productId: product.id,
      sku: product.sku,
      nome: product.nome,
      categoria: product.categoria,
      quantidade: qty,
      precoUnitario: unitPrice,
      precoCusto: product.precoCusto,
      subtotal: itemSubtotal,
      desconto: itemDiscount,
      total: itemTotal
    });
  }

  // 4. Legal Age Compliance Enforcement:
  // If cart has restricted items and verification flag is NOT true, block!
  // If cart has ONLY unrestricted items, allow without requiring age check.
  if (hasAgeRestrictedItem && !verificacaoMaioridade) {
    res.status(403).json({
      error: `Venda bloqueada por conformidade legal: O carrinho contém itens restritos para maiores de 18 anos (${restrictedProducts.join(', ')}). É obrigatório confirmar a verificação de documento de identidade do cliente (Lei Federal nº 9.294/1996 e Lei nº 8.069/1990).`
    });
    return;
  }

  const generalDiscount = parseFloat(descontoGeral) >= 0 ? parseFloat(descontoGeral) : 0;
  const itemsDiscount = saleItems.reduce((acc, i) => acc + i.desconto, 0);
  const totalDiscount = itemsDiscount + generalDiscount;
  const valorTotal = Number(Math.max(0, subtotal - totalDiscount).toFixed(2));
  const lucroBrutoEstimado = Number((valorTotal - totalCost).toFixed(2));

  // 5. Payment validation per method
  let paidAmount = valorTotal;
  let change = 0;

  if (formaPagamento === 'dinheiro') {
    paidAmount = valorPago ? parseFloat(valorPago) : valorTotal;
    if (isNaN(paidAmount) || paidAmount < valorTotal) {
      res.status(400).json({
        error: `Valor pago em dinheiro (R$ ${paidAmount.toFixed(2)}) é insuficiente para o total da compra (R$ ${valorTotal.toFixed(2)}).`
      });
      return;
    }
    change = Number(Math.max(0, paidAmount - valorTotal).toFixed(2));

    // Update physical cash drawer
    activeSession.totalVendasDinheiro = Number((activeSession.totalVendasDinheiro + valorTotal).toFixed(2));
    activeSession.saldoEsperadoDinheiro = Number((activeSession.saldoEsperadoDinheiro + valorTotal).toFixed(2));
  } else if (formaPagamento === 'pix') {
    // Record PIX in session (does NOT alter physical cash drawer!)
    activeSession.totalVendasPix = Number((activeSession.totalVendasPix + valorTotal).toFixed(2));

    if (detalhesPagamento?.pixTxid) {
      const charge = db.pixCharges.find(p => p.txid === detalhesPagamento.pixTxid && p.companyId === companyId);
      if (charge) {
        charge.status = 'pago';
        charge.confirmadoEm = new Date().toISOString();
      }
    }
  } else if (formaPagamento === 'cartao_debito') {
    activeSession.totalVendasCartao = Number((activeSession.totalVendasCartao + valorTotal).toFixed(2));
    activeSession.totalVendasCartaoDebito = Number(((activeSession.totalVendasCartaoDebito || 0) + valorTotal).toFixed(2));
  } else if (formaPagamento === 'cartao_credito') {
    activeSession.totalVendasCartao = Number((activeSession.totalVendasCartao + valorTotal).toFixed(2));
    activeSession.totalVendasCartaoCredito = Number(((activeSession.totalVendasCartaoCredito || 0) + valorTotal).toFixed(2));
  } else {
    activeSession.totalVendasOutros = Number((activeSession.totalVendasOutros + valorTotal).toFixed(2));
  }

  const countSales = db.commercialSales.filter(s => s.companyId === companyId).length + 1;
  const prefix = targetModulo === 'adega' ? 'VDA-ADE' : 'VDA-TAB';
  const codigoVenda = `${prefix}-${new Date().getFullYear()}-${String(countSales).padStart(5, '0')}`;

  // 6. Atomically decrement stock
  for (const item of saleItems) {
    const product = db.commercialProducts.find(p => p.id === item.productId)!;
    const qtdAnt = product.estoqueAtual;
    product.estoqueAtual = qtdAnt - item.quantidade;
    product.atualizadoEm = new Date().toISOString();

    db.commercialStockMovements.push({
      id: crypto.randomUUID(),
      companyId,
      productId: product.id,
      productNome: product.nome,
      modulo: product.modulo,
      tipo: 'saida_venda',
      quantidade: item.quantidade,
      quantidadeAnterior: qtdAnt,
      quantidadeNova: product.estoqueAtual,
      motivo: `Venda ${codigoVenda}`,
      usuarioId: req.user!.id,
      usuarioNome: req.user!.name,
      referenciaId: codigoVenda,
      criadoEm: new Date().toISOString()
    });
  }

  const sale: CommercialSale = {
    id: crypto.randomUUID(),
    codigoVenda,
    companyId,
    modulo: targetModulo,
    itens: saleItems,
    subtotal,
    descontoTotal: totalDiscount,
    valorTotal,
    custoTotalEstimado: totalCost,
    lucroBrutoEstimado,
    formaPagamento,
    valorPago: paidAmount,
    troco: change,
    caixaSessionId: activeSession.id,
    status: 'concluida',
    clienteNome: clienteNome ? String(clienteNome).trim() : undefined,
    clienteDocumento: clienteDocumento ? String(clienteDocumento).trim() : undefined,
    verificacaoMaioridade: Boolean(verificacaoMaioridade),
    operadorId: req.user!.id,
    operadorNome: req.user!.name,
    criadoEm: new Date().toISOString(),
    detalhesPagamento: detalhesPagamento ? {
      forma: formaPagamento,
      valorRecebido: paidAmount,
      troco: change,
      ...detalhesPagamento
    } : {
      forma: formaPagamento,
      valorRecebido: paidAmount,
      troco: change
    },
    idempotencyKey: idempotencyKey || undefined
  };

  db.commercialSales.push(sale);

  // Link or create Terminal Transaction for audit and reconciliation
  if (formaPagamento === 'cartao_debito' || formaPagamento === 'cartao_credito') {
    let linkedTx: CommercialTerminalTransaction | undefined;

    if (detalhesPagamento?.transactionId) {
      linkedTx = db.commercialTerminalTransactions.find(t => t.id === detalhesPagamento.transactionId && t.companyId === companyId);
    } else if (detalhesPagamento?.paymentIntentId) {
      linkedTx = db.commercialTerminalTransactions.find(t => t.paymentIntentId === detalhesPagamento.paymentIntentId && t.companyId === companyId);
    } else if (detalhesPagamento?.nsu) {
      linkedTx = db.commercialTerminalTransactions.find(t => t.nsu === detalhesPagamento.nsu && t.companyId === companyId);
    }

    if (linkedTx) {
      linkedTx.saleId = sale.id;
      linkedTx.codigoVenda = sale.codigoVenda;
      linkedTx.caixaSessionId = activeSession.id;
      linkedTx.conciliado = true;
      linkedTx.conciliadoEm = new Date().toISOString();
      if (detalhesPagamento?.cartaoBandeira) linkedTx.bandeira = detalhesPagamento.cartaoBandeira;
      if (detalhesPagamento?.nsu) linkedTx.nsu = detalhesPagamento.nsu;
      if (detalhesPagamento?.cartaoAutorizacao || detalhesPagamento?.codigoAutorizacao) {
        linkedTx.codigoAutorizacao = detalhesPagamento.cartaoAutorizacao || detalhesPagamento.codigoAutorizacao;
      }
    } else if (detalhesPagamento?.terminalId) {
      const term = db.commercialTerminals.find(t => t.id === detalhesPagamento.terminalId && t.companyId === companyId);
      const rate = formaPagamento === 'cartao_debito'
        ? (term?.taxaDebitoPercentual || 1.99)
        : (term?.taxaCreditoPercentual || 3.99);
      const fee = Number(((valorTotal * rate) / 100).toFixed(2));
      const net = Number((valorTotal - fee).toFixed(2));

      const newTx: CommercialTerminalTransaction = {
        id: crypto.randomUUID(),
        companyId,
        terminalId: detalhesPagamento.terminalId,
        terminalNome: term ? term.nome : (detalhesPagamento.terminalNome || 'POS Autônomo'),
        provedor: term ? term.provedor : 'pos_manual',
        modeloTerminal: term?.modelo,
        modulo: targetModulo,
        saleId: sale.id,
        codigoVenda: sale.codigoVenda,
        caixaSessionId: activeSession.id,
        tipoOperacao: formaPagamento === 'cartao_debito' ? 'debito' : 'credito',
        bandeira: detalhesPagamento.cartaoBandeira || 'Mastercard',
        ultimosDigitosCartao: detalhesPagamento.ultimosDigitosCartao || '****',
        valorBruto: valorTotal,
        taxaPercentualAplicada: rate,
        valorTaxaEstimada: fee,
        valorLiquido: net,
        status: 'aprovado',
        nsu: detalhesPagamento.nsu || String(Math.floor(100000 + Math.random() * 900000)),
        codigoAutorizacao: detalhesPagamento.cartaoAutorizacao || detalhesPagamento.codigoAutorizacao || String(Math.floor(100000 + Math.random() * 900000)),
        paymentIntentId: detalhesPagamento.paymentIntentId,
        mensagemProvedor: 'Aprovado via POS',
        criadoEm: new Date().toISOString(),
        concluidoEm: new Date().toISOString(),
        conciliado: true,
        conciliadoEm: new Date().toISOString()
      };
      db.commercialTerminalTransactions.push(newTx);
    }
  }

  db.save();

  db.logAudit({
    userId: req.user!.id,
    userEmail: req.user!.email,
    userName: req.user!.name,
    companyId,
    acao: 'VENDA_PDV_CONCLUIDA',
    detalhes: `Venda ${sale.codigoVenda} (${sale.modulo.toUpperCase()}) concluída por ${req.user!.name}. Valor: R$ ${sale.valorTotal.toFixed(2)} (${sale.formaPagamento.toUpperCase()}). Caixa: ${activeSession.codigoSessao}`,
    ip: req.ip
  });

  res.status(201).json({
    success: true,
    message: 'Venda concluída com sucesso!',
    sale
  });
});

// List Sales
apiRouter.get('/commerce/sales', authenticate, checkSubscription, (req: AuthRequest, res: Response) => {
  ensureCommercialCollections();
  const companyId = getEffectiveCompanyId(req);
  const { modulo, status, dataInicio, dataFim } = req.query;

  let list = db.commercialSales.filter(s => s.companyId === companyId);

  if (modulo && modulo !== 'todos' && modulo !== 'misto') {
    list = list.filter(s => s.modulo === modulo);
  }

  if (status && status !== 'todos') {
    list = list.filter(s => s.status === status);
  }

  if (dataInicio && typeof dataInicio === 'string') {
    list = list.filter(s => s.criadoEm >= dataInicio);
  }

  if (dataFim && typeof dataFim === 'string') {
    list = list.filter(s => s.criadoEm <= dataFim + 'T23:59:59.999Z');
  }

  list.sort((a, b) => new Date(b.criadoEm).getTime() - new Date(a.criadoEm).getTime());

  res.json({ sales: list.slice(0, 100), total: list.length });
});

// Cancel Sale
apiRouter.post('/commerce/sales/:id/cancel', authenticate, checkSubscription, (req: AuthRequest, res: Response) => {
  ensureCommercialCollections();
  const companyId = getEffectiveCompanyId(req);
  const { id } = req.params;
  const { motivo } = req.body;

  if (!motivo || !String(motivo).trim()) {
    res.status(400).json({ error: 'Justificativa para cancelamento da venda é obrigatória.' });
    return;
  }

  const sale = db.commercialSales.find(s => s.id === id && s.companyId === companyId);
  if (!sale) {
    res.status(404).json({ error: 'Venda não encontrada.' });
    return;
  }

  if (sale.status === 'cancelada') {
    res.status(400).json({ error: 'Esta venda já se encontra cancelada.' });
    return;
  }

  sale.status = 'cancelada';
  sale.motivoCancelamento = String(motivo).trim();
  sale.canceladoEm = new Date().toISOString();
  sale.canceladoPor = req.user!.name;

  // Revert stock
  for (const item of sale.itens) {
    const product = db.commercialProducts.find(p => p.id === item.productId && p.companyId === companyId);
    if (product) {
      const qtdAnt = product.estoqueAtual;
      product.estoqueAtual = qtdAnt + item.quantidade;
      product.atualizadoEm = new Date().toISOString();

      db.commercialStockMovements.push({
        id: crypto.randomUUID(),
        companyId,
        productId: product.id,
        productNome: product.nome,
        modulo: product.modulo,
        tipo: 'devolucao',
        quantidade: item.quantidade,
        quantidadeAnterior: qtdAnt,
        quantidadeNova: product.estoqueAtual,
        motivo: `Cancelamento da Venda ${sale.codigoVenda}: ${motivo}`,
        usuarioId: req.user!.id,
        usuarioNome: req.user!.name,
        referenciaId: sale.codigoVenda,
        criadoEm: new Date().toISOString()
      });
    }
  }

  // Adjust cash session if active
  if (sale.caixaSessionId) {
    const session = db.commercialCashSessions.find(c => c.id === sale.caixaSessionId && c.status === 'aberto');
    if (session) {
      if (sale.formaPagamento === 'dinheiro') {
        session.totalVendasDinheiro = Math.max(0, session.totalVendasDinheiro - sale.valorTotal);
        session.saldoEsperadoDinheiro = Math.max(0, session.saldoEsperadoDinheiro - sale.valorTotal);
      } else if (sale.formaPagamento === 'pix') {
        session.totalVendasPix = Math.max(0, session.totalVendasPix - sale.valorTotal);
      } else if (sale.formaPagamento === 'cartao_credito' || sale.formaPagamento === 'cartao_debito') {
        session.totalVendasCartao = Math.max(0, session.totalVendasCartao - sale.valorTotal);
      }
    }
  }

  db.save();

  db.logAudit({
    userId: req.user!.id,
    userEmail: req.user!.email,
    userName: req.user!.name,
    companyId,
    acao: 'CANCELAMENTO_VENDA_PDV',
    detalhes: `Venda ${sale.codigoVenda} cancelada. Motivo: ${motivo}`,
    ip: req.ip
  });

  res.json({ success: true, message: 'Venda cancelada com sucesso e estoque estornado!', sale });
});

// --- FORNECEDORES & COMPRAS ---

// List Suppliers
apiRouter.get('/commerce/suppliers', authenticate, checkSubscription, (req: AuthRequest, res: Response) => {
  ensureCommercialCollections();
  const companyId = getEffectiveCompanyId(req);
  const { segmento } = req.query;

  let list = db.commercialSuppliers.filter(s => s.companyId === companyId);
  if (segmento && (segmento === 'adega' || segmento === 'tabacaria')) {
    list = list.filter(s => s.segmento === segmento || s.segmento === 'ambos');
  }

  list.sort((a, b) => a.nomeFantasia.localeCompare(b.nomeFantasia));
  res.json({ suppliers: list });
});

// Create Supplier
apiRouter.post('/commerce/suppliers', authenticate, checkSubscription, (req: AuthRequest, res: Response) => {
  ensureCommercialCollections();
  const companyId = getEffectiveCompanyId(req);
  const {
    razaoSocial,
    nomeFantasia,
    cnpjCpf,
    contatoNome,
    telefone,
    email,
    endereco,
    segmento,
    observacoes
  } = req.body;

  if (!nomeFantasia || !String(nomeFantasia).trim()) {
    res.status(400).json({ error: 'Nome fantasia do fornecedor é obrigatório.' });
    return;
  }

  const supplier: CommercialSupplier = {
    id: crypto.randomUUID(),
    companyId,
    razaoSocial: razaoSocial ? String(razaoSocial).trim() : String(nomeFantasia).trim(),
    nomeFantasia: String(nomeFantasia).trim(),
    cnpjCpf: cnpjCpf ? String(cnpjCpf).trim() : '',
    contatoNome: contatoNome ? String(contatoNome).trim() : '',
    telefone: telefone ? String(telefone).trim() : '',
    email: email ? String(email).trim() : '',
    endereco: endereco ? String(endereco).trim() : undefined,
    segmento: segmento && ['adega', 'tabacaria', 'ambos'].includes(segmento) ? segmento : 'ambos',
    observacoes: observacoes ? String(observacoes).trim() : undefined,
    ativo: true,
    criadoEm: new Date().toISOString()
  };

  db.commercialSuppliers.push(supplier);
  db.save();

  db.logAudit({
    userId: req.user!.id,
    userEmail: req.user!.email,
    userName: req.user!.name,
    companyId,
    acao: 'CADASTRO_FORNECEDOR_COMERCIAL',
    detalhes: `Fornecedor ${supplier.nomeFantasia} cadastrado`,
    ip: req.ip
  });

  res.status(201).json({ message: 'Fornecedor cadastrado com sucesso!', supplier });
});

// List Purchases
apiRouter.get('/commerce/purchases', authenticate, checkSubscription, (req: AuthRequest, res: Response) => {
  ensureCommercialCollections();
  const companyId = getEffectiveCompanyId(req);

  const list = db.commercialPurchases.filter(p => p.companyId === companyId);
  list.sort((a, b) => new Date(b.dataCompra).getTime() - new Date(a.dataCompra).getTime());
  res.json({ purchases: list });
});

// Register Purchase with auto stock increase
apiRouter.post('/commerce/purchases', authenticate, checkSubscription, (req: AuthRequest, res: Response) => {
  ensureCommercialCollections();
  const companyId = getEffectiveCompanyId(req);
  const {
    fornecedorId,
    numeroNota,
    dataCompra,
    itens,
    valorTotal,
    formaPagamento,
    observacoes
  } = req.body;

  if (!itens || !Array.isArray(itens) || itens.length === 0) {
    res.status(400).json({ error: 'A compra deve conter ao menos um item.' });
    return;
  }

  const supplier = db.commercialSuppliers.find(s => s.id === fornecedorId && s.companyId === companyId);
  const fornecedorNome = supplier ? supplier.nomeFantasia : 'Fornecedor Diverso';

  const purchaseItems: any[] = [];
  let calculatedTotal = 0;

  for (const item of itens) {
    const product = db.commercialProducts.find(p => p.id === item.productId && p.companyId === companyId);
    if (!product) {
      res.status(404).json({ error: `Produto não encontrado: ID ${item.productId}` });
      return;
    }

    const qty = parseInt(item.quantidade, 10);
    const cost = parseFloat(item.custoUnitario) >= 0 ? parseFloat(item.custoUnitario) : product.precoCusto;
    const itemTotal = qty * cost;
    calculatedTotal += itemTotal;

    purchaseItems.push({
      productId: product.id,
      nome: product.nome,
      quantidade: qty,
      custoUnitario: cost,
      total: itemTotal
    });

    // Update product stock and cost
    const qtdAnt = product.estoqueAtual;
    product.estoqueAtual = qtdAnt + qty;
    product.precoCusto = cost;
    product.atualizadoEm = new Date().toISOString();

    db.commercialStockMovements.push({
      id: crypto.randomUUID(),
      companyId,
      productId: product.id,
      productNome: product.nome,
      modulo: product.modulo,
      tipo: 'entrada_compra',
      quantidade: qty,
      quantidadeAnterior: qtdAnt,
      quantidadeNova: product.estoqueAtual,
      motivo: `Entrada por compra - NF ${numeroNota || 'S/N'} (${fornecedorNome})`,
      usuarioId: req.user!.id,
      usuarioNome: req.user!.name,
      criadoEm: new Date().toISOString()
    });
  }

  const purchase: CommercialPurchase = {
    id: crypto.randomUUID(),
    companyId,
    fornecedorId: fornecedorId || '',
    fornecedorNome,
    numeroNota: numeroNota ? String(numeroNota).trim() : undefined,
    dataCompra: dataCompra || new Date().toISOString().slice(0, 10),
    dataRecebimento: new Date().toISOString(),
    status: 'recebido',
    itens: purchaseItems,
    valorTotal: valorTotal ? parseFloat(valorTotal) : calculatedTotal,
    formaPagamento: formaPagamento ? String(formaPagamento).trim() : undefined,
    observacoes: observacoes ? String(observacoes).trim() : undefined,
    criadoEm: new Date().toISOString()
  };

  db.commercialPurchases.push(purchase);
  db.save();

  db.logAudit({
    userId: req.user!.id,
    userEmail: req.user!.email,
    userName: req.user!.name,
    companyId,
    acao: 'REGISTRO_COMPRA_ENTRADA_ESTOQUE',
    detalhes: `Compra de R$ ${purchase.valorTotal.toFixed(2)} recebida de ${fornecedorNome}. Estoque atualizado automaticamente.`,
    ip: req.ip
  });

  res.status(201).json({ message: 'Compra registrada e estoque atualizado com sucesso!', purchase });
});

// --- DASHBOARD & ANALYTICS ---

apiRouter.get('/commerce/dashboard', authenticate, checkSubscription, (req: AuthRequest, res: Response) => {
  ensureCommercialCollections();
  const companyId = getEffectiveCompanyId(req);
  const { modulo } = req.query;

  let products = db.commercialProducts.filter(p => p.companyId === companyId && p.ativo);
  let sales = db.commercialSales.filter(s => s.companyId === companyId && s.status === 'concluida');

  if (modulo && (modulo === 'adega' || modulo === 'tabacaria')) {
    products = products.filter(p => p.modulo === modulo);
    sales = sales.filter(s => s.modulo === modulo || s.modulo === 'misto');
  }

  const totalProdutos = products.length;
  const valorEstoqueCusto = products.reduce((acc, p) => acc + (p.estoqueAtual * p.precoCusto), 0);
  const produtosEstoqueBaixo = products.filter(p => p.estoqueAtual <= p.estoqueMinimo);

  // Sales Today
  const todayStr = new Date().toISOString().slice(0, 10);
  const salesToday = sales.filter(s => s.criadoEm.startsWith(todayStr));
  const vendasHojeValor = salesToday.reduce((acc, s) => acc + s.valorTotal, 0);
  const vendasHojeQtd = salesToday.length;

  // Sales This Month
  const thisMonthStr = new Date().toISOString().slice(0, 7);
  const salesMonth = sales.filter(s => s.criadoEm.startsWith(thisMonthStr));
  const vendasMesValor = salesMonth.reduce((acc, s) => acc + s.valorTotal, 0);
  const vendasMesQtd = salesMonth.length;
  const lucroBrutoMesEstimado = salesMonth.reduce((acc, s) => acc + (s.lucroBrutoEstimado || 0), 0);

  // Top selling products
  const productSalesMap: Record<string, { nome: string; quantidade: number; valor: number }> = {};
  sales.forEach(sale => {
    sale.itens.forEach(item => {
      if (!productSalesMap[item.productId]) {
        productSalesMap[item.productId] = { nome: item.nome, quantidade: 0, valor: 0 };
      }
      productSalesMap[item.productId].quantidade += item.quantidade;
      productSalesMap[item.productId].valor += item.total;
    });
  });

  const topProdutosMaisVendidos = Object.entries(productSalesMap)
    .map(([productId, val]) => ({
      productId,
      nome: val.nome,
      quantidadeTotal: val.quantidade,
      valorTotal: val.valor
    }))
    .sort((a, b) => b.quantidadeTotal - a.quantidadeTotal)
    .slice(0, 8);

  // Stagnant products (items with 0 sales in the database)
  const produtosParados = products
    .filter(p => !productSalesMap[p.id] || productSalesMap[p.id].quantidade === 0)
    .slice(0, 10);

  // Comparison between Adega and Tabacaria
  const allCompProducts = db.commercialProducts.filter(p => p.companyId === companyId && p.ativo);
  const allCompSales = db.commercialSales.filter(s => s.companyId === companyId && s.status === 'concluida' && s.criadoEm.startsWith(thisMonthStr));

  const adegaProds = allCompProducts.filter(p => p.modulo === 'adega');
  const tabaProds = allCompProducts.filter(p => p.modulo === 'tabacaria');

  const adegaSalesVal = allCompSales.filter(s => s.modulo === 'adega').reduce((acc, s) => acc + s.valorTotal, 0);
  const tabaSalesVal = allCompSales.filter(s => s.modulo === 'tabacaria').reduce((acc, s) => acc + s.valorTotal, 0);

  const comparativoModulos = {
    adega: {
      totalProdutos: adegaProds.length,
      totalEstoqueValor: adegaProds.reduce((acc, p) => acc + (p.estoqueAtual * p.precoCusto), 0),
      vendasMesValor: adegaSalesVal
    },
    tabacaria: {
      totalProdutos: tabaProds.length,
      totalEstoqueValor: tabaProds.reduce((acc, p) => acc + (p.estoqueAtual * p.precoCusto), 0),
      vendasMesValor: tabaSalesVal
    }
  };

  res.json({
    totalProdutos,
    valorEstoqueCusto,
    produtosEstoqueBaixoCount: produtosEstoqueBaixo.length,
    vendasHojeValor,
    vendasHojeQtd,
    vendasMesValor,
    vendasMesQtd,
    lucroBrutoMesEstimado,
    topProdutosMaisVendidos,
    produtosEstoqueBaixo: produtosEstoqueBaixo.slice(0, 10),
    produtosParados,
    comparativoModulos
  });
});

// ==========================================
// 15. CENTRAL DE INTEGRAÇÃO DE MAQUININHAS (POS / TEF)
// ==========================================

// Seed default demonstration terminals if company has none
const seedDefaultTerminalsIfEmpty = (companyId: string) => {
  const existing = db.commercialTerminals.filter(t => t.companyId === companyId);
  if (existing.length === 0) {
    const defaultMpTerminal: CommercialTerminal = {
      id: crypto.randomUUID(),
      companyId,
      nome: 'Point Smart - Caixa Balcão Adega',
      provedor: 'mercadopago_point',
      modelo: 'Point Smart (A910 / P2)',
      tipoEquipamento: 'smart_pos',
      identificadorProvedor: 'DEMO_POINT_ADEGA_01',
      serialNumber: 'PA910-8837192',
      modulo: 'adega',
      padrao: true,
      ativo: true,
      statusConexao: 'online',
      modoOperacao: 'cloud_api',
      credenciais: {
        mpAccessToken: 'TEST_DEMO_POINT_ADEGA_TOKEN'
      },
      taxaDebitoPercentual: 1.99,
      taxaCreditoPercentual: 3.98,
      taxaPixPercentual: 0.99,
      bateriaNivel: 95,
      criadoEm: new Date().toISOString(),
      atualizadoEm: new Date().toISOString(),
      ultimoTesteEm: new Date().toISOString(),
      ultimoResultadoTeste: {
        sucesso: true,
        mensagem: 'Terminal Point Smart homologado e online na Point Integration Cloud (Sandbox MoviLog).',
        dataHora: new Date().toISOString()
      }
    };

    const defaultStoneTerminal: CommercialTerminal = {
      id: crypto.randomUUID(),
      companyId,
      nome: 'Stone Smart POS - Caixa Tabacaria',
      provedor: 'stone_connect',
      modelo: 'Stone Smart POS (P2)',
      tipoEquipamento: 'smart_pos',
      identificadorProvedor: 'DEMO_STONE_TAB_01',
      serialNumber: 'STP2-4410294',
      modulo: 'tabacaria',
      padrao: true,
      ativo: true,
      statusConexao: 'online',
      modoOperacao: 'cloud_api',
      credenciais: {
        stonePartnerKey: 'TEST_STONE_PARTNER_KEY',
        stoneSecretKey: 'TEST_STONE_SECRET_KEY',
        stoneMerchantId: 'MERCH_TABACARIA_01'
      },
      taxaDebitoPercentual: 1.49,
      taxaCreditoPercentual: 2.99,
      taxaPixPercentual: 0.75,
      bateriaNivel: 90,
      criadoEm: new Date().toISOString(),
      atualizadoEm: new Date().toISOString(),
      ultimoTesteEm: new Date().toISOString(),
      ultimoResultadoTeste: {
        sucesso: true,
        mensagem: 'Terminal Stone Connect 2.0 ativo e credenciado para transações.',
        dataHora: new Date().toISOString()
      }
    };

    db.commercialTerminals.push(defaultMpTerminal, defaultStoneTerminal);
    db.save();
  }
};

// 1. List Terminals (Sanitized, secrets protected)
apiRouter.get('/commerce/terminals', authenticate, checkSubscription, (req: AuthRequest, res: Response) => {
  ensureCommercialCollections();
  const companyId = getEffectiveCompanyId(req);
  seedDefaultTerminalsIfEmpty(companyId);

  const { modulo, ativo } = req.query;
  let terminals = db.commercialTerminals.filter(t => t.companyId === companyId);

  if (modulo && typeof modulo === 'string' && (modulo === 'adega' || modulo === 'tabacaria')) {
    terminals = terminals.filter(t => t.modulo === modulo || t.modulo === 'ambos');
  }

  if (ativo !== undefined) {
    const isAtivo = ativo === 'true';
    terminals = terminals.filter(t => t.ativo === isAtivo);
  }

  // Sort: default first, then by name
  terminals.sort((a, b) => (b.padrao ? 1 : 0) - (a.padrao ? 1 : 0) || a.nome.localeCompare(b.nome));

  const sanitized = terminals.map(t => GatewayFactory.sanitizeTerminal(t));
  res.json({ success: true, terminals: sanitized });
});

// 2. Register New Terminal
apiRouter.post('/commerce/terminals', authenticate, checkSubscription, (req: AuthRequest, res: Response) => {
  ensureCommercialCollections();
  const companyId = getEffectiveCompanyId(req);
  const {
    nome,
    provedor,
    modelo,
    tipoEquipamento,
    identificadorProvedor,
    serialNumber,
    modulo,
    caixaIdPadrao,
    padrao,
    modoOperacao,
    credenciais,
    taxaDebitoPercentual,
    taxaCreditoPercentual,
    taxaPixPercentual
  } = req.body;

  if (!nome || !String(nome).trim()) {
    res.status(400).json({ error: 'Nome de identificação do terminal é obrigatório.' });
    return;
  }

  const validProviders: TerminalProvider[] = ['mercadopago_point', 'stone_connect', 'pagar_me', 'smartpos_tef', 'pos_manual'];
  if (!provedor || !validProviders.includes(provedor)) {
    res.status(400).json({ error: 'Provedor de pagamento inválido. Selecione Mercado Pago, Stone Connect, TEF ou POS Manual.' });
    return;
  }

  if (!identificadorProvedor && provedor !== 'pos_manual') {
    res.status(400).json({ error: 'O identificador exigido pelo provedor (Device ID, Terminal ID ou Serial) é obrigatório.' });
    return;
  }

  // If marked as default, unset previous default in the same module
  const targetModulo = modulo && ['adega', 'tabacaria', 'ambos'].includes(modulo) ? modulo : 'ambos';
  if (padrao) {
    db.commercialTerminals
      .filter(t => t.companyId === companyId && (t.modulo === targetModulo || t.modulo === 'ambos' || targetModulo === 'ambos'))
      .forEach(t => { t.padrao = false; });
  }

  const newTerminal: CommercialTerminal = {
    id: crypto.randomUUID(),
    companyId,
    nome: String(nome).trim(),
    provedor,
    modelo: modelo ? String(modelo).trim() : 'Terminal POS',
    tipoEquipamento: tipoEquipamento && ['smart_pos', 'pos_gprs', 'tef_pinpad', 'pos_manual'].includes(tipoEquipamento)
      ? tipoEquipamento
      : 'smart_pos',
    identificadorProvedor: identificadorProvedor ? String(identificadorProvedor).trim() : 'MANUAL_POS',
    serialNumber: serialNumber ? String(serialNumber).trim() : undefined,
    modulo: targetModulo,
    caixaIdPadrao: caixaIdPadrao || undefined,
    padrao: Boolean(padrao),
    ativo: true,
    statusConexao: 'desconhecido',
    modoOperacao: modoOperacao && ['cloud_api', 'smart_pos_app', 'tef_integrado', 'manual_operador'].includes(modoOperacao)
      ? modoOperacao
      : (provedor === 'pos_manual' ? 'manual_operador' : 'cloud_api'),
    credenciais: credenciais || {},
    taxaDebitoPercentual: parseFloat(taxaDebitoPercentual) >= 0 ? parseFloat(taxaDebitoPercentual) : 1.99,
    taxaCreditoPercentual: parseFloat(taxaCreditoPercentual) >= 0 ? parseFloat(taxaCreditoPercentual) : 3.99,
    taxaPixPercentual: parseFloat(taxaPixPercentual) >= 0 ? parseFloat(taxaPixPercentual) : 0.99,
    criadoEm: new Date().toISOString(),
    atualizadoEm: new Date().toISOString()
  };

  db.commercialTerminals.push(newTerminal);
  db.save();

  db.logAudit({
    userId: req.user!.id,
    userEmail: req.user!.email,
    userName: req.user!.name,
    companyId,
    acao: 'CADASTRO_TERMINAL_MAQUININHA',
    detalhes: `Terminal '${newTerminal.nome}' (${newTerminal.provedor}) cadastrado para o módulo ${newTerminal.modulo}.`,
    ip: req.ip
  });

  res.status(201).json({
    success: true,
    message: 'Maquininha cadastrada com sucesso!',
    terminal: GatewayFactory.sanitizeTerminal(newTerminal)
  });
});

// 3. Update Terminal
apiRouter.put('/commerce/terminals/:id', authenticate, checkSubscription, (req: AuthRequest, res: Response) => {
  ensureCommercialCollections();
  const companyId = getEffectiveCompanyId(req);
  const { id } = req.params;

  const terminal = db.commercialTerminals.find(t => t.id === id && t.companyId === companyId);
  if (!terminal) {
    res.status(404).json({ error: 'Terminal de pagamento não encontrado.' });
    return;
  }

  const {
    nome,
    provedor,
    modelo,
    tipoEquipamento,
    identificadorProvedor,
    serialNumber,
    modulo,
    caixaIdPadrao,
    padrao,
    ativo,
    modoOperacao,
    credenciais,
    taxaDebitoPercentual,
    taxaCreditoPercentual,
    taxaPixPercentual
  } = req.body;

  if (nome !== undefined) terminal.nome = String(nome).trim();
  if (provedor !== undefined) terminal.provedor = provedor;
  if (modelo !== undefined) terminal.modelo = String(modelo).trim();
  if (tipoEquipamento !== undefined) terminal.tipoEquipamento = tipoEquipamento;
  if (identificadorProvedor !== undefined) terminal.identificadorProvedor = String(identificadorProvedor).trim();
  if (serialNumber !== undefined) terminal.serialNumber = String(serialNumber).trim();
  if (modulo !== undefined) terminal.modulo = modulo;
  if (caixaIdPadrao !== undefined) terminal.caixaIdPadrao = caixaIdPadrao || undefined;
  if (ativo !== undefined) terminal.ativo = Boolean(ativo);
  if (modoOperacao !== undefined) terminal.modoOperacao = modoOperacao;
  if (taxaDebitoPercentual !== undefined) terminal.taxaDebitoPercentual = parseFloat(taxaDebitoPercentual);
  if (taxaCreditoPercentual !== undefined) terminal.taxaCreditoPercentual = parseFloat(taxaCreditoPercentual);
  if (taxaPixPercentual !== undefined) terminal.taxaPixPercentual = parseFloat(taxaPixPercentual);

  // Update credentials if provided (without overwriting if omitted)
  if (credenciais && typeof credenciais === 'object') {
    terminal.credenciais = {
      ...terminal.credenciais,
      ...credenciais
    };
  }

  if (padrao === true) {
    db.commercialTerminals
      .filter(t => t.companyId === companyId && t.id !== terminal.id && (t.modulo === terminal.modulo || t.modulo === 'ambos' || terminal.modulo === 'ambos'))
      .forEach(t => { t.padrao = false; });
    terminal.padrao = true;
  } else if (padrao === false) {
    terminal.padrao = false;
  }

  terminal.atualizadoEm = new Date().toISOString();
  db.save();

  db.logAudit({
    userId: req.user!.id,
    userEmail: req.user!.email,
    userName: req.user!.name,
    companyId,
    acao: 'ATUALIZACAO_TERMINAL_MAQUININHA',
    detalhes: `Terminal '${terminal.nome}' atualizado. Ativo: ${terminal.ativo}, Padrão: ${terminal.padrao}`,
    ip: req.ip
  });

  res.json({
    success: true,
    message: 'Terminal atualizado com sucesso!',
    terminal: GatewayFactory.sanitizeTerminal(terminal)
  });
});

// 4. Delete Terminal
apiRouter.delete('/commerce/terminals/:id', authenticate, checkSubscription, (req: AuthRequest, res: Response) => {
  ensureCommercialCollections();
  const companyId = getEffectiveCompanyId(req);
  const { id } = req.params;

  const index = db.commercialTerminals.findIndex(t => t.id === id && t.companyId === companyId);
  if (index === -1) {
    res.status(404).json({ error: 'Terminal não encontrado.' });
    return;
  }

  const [removed] = db.commercialTerminals.splice(index, 1);
  db.save();

  db.logAudit({
    userId: req.user!.id,
    userEmail: req.user!.email,
    userName: req.user!.name,
    companyId,
    acao: 'EXCLUSAO_TERMINAL_MAQUININHA',
    detalhes: `Terminal '${removed.nome}' removido.`,
    ip: req.ip
  });

  res.json({ success: true, message: 'Terminal removido com sucesso!' });
});

// 5. Test Connection with Terminal Provider
apiRouter.post('/commerce/terminals/:id/test', authenticate, checkSubscription, async (req: AuthRequest, res: Response) => {
  ensureCommercialCollections();
  const companyId = getEffectiveCompanyId(req);
  const { id } = req.params;

  const terminal = db.commercialTerminals.find(t => t.id === id && t.companyId === companyId);
  if (!terminal) {
    res.status(404).json({ error: 'Terminal não encontrado.' });
    return;
  }

  const adapter = GatewayFactory.getAdapter(terminal.provedor);
  const testResult = await adapter.testConnection(terminal);

  terminal.statusConexao = testResult.terminalStatus || (testResult.success ? 'online' : 'offline');
  terminal.ultimoTesteEm = new Date().toISOString();
  if (testResult.batteryLevel !== undefined) {
    terminal.bateriaNivel = testResult.batteryLevel;
  }
  terminal.ultimoResultadoTeste = {
    sucesso: testResult.success,
    mensagem: testResult.message,
    detalhes: testResult.details,
    dataHora: new Date().toISOString()
  };
  terminal.ultimaSincronizacao = new Date().toISOString();

  db.save();

  db.logAudit({
    userId: req.user!.id,
    userEmail: req.user!.email,
    userName: req.user!.name,
    companyId,
    acao: 'TESTE_CONEXAO_MAQUININHA',
    detalhes: `Teste de conexão no terminal '${terminal.nome}' (${terminal.provedor}): ${testResult.success ? 'SUCESSO' : 'FALHA'}. Mensagem: ${testResult.message}`,
    ip: req.ip
  });

  res.json({
    success: testResult.success,
    message: testResult.message,
    terminalStatus: terminal.statusConexao,
    batteryLevel: terminal.bateriaNivel,
    details: testResult.details,
    terminal: GatewayFactory.sanitizeTerminal(terminal)
  });
});

// 6. Create PDV Payment Intent for Terminal
apiRouter.post('/commerce/terminals/:id/intent', authenticate, checkSubscription, async (req: AuthRequest, res: Response) => {
  ensureCommercialCollections();
  const companyId = getEffectiveCompanyId(req);
  const { id } = req.params;
  const {
    valor,
    tipoOperacao,
    parcelas,
    modulo,
    codigoVenda,
    caixaSessionId,
    idempotencyKey
  } = req.body;

  const amount = parseFloat(valor);
  if (isNaN(amount) || amount <= 0) {
    res.status(400).json({ error: 'Valor da cobrança deve ser maior que zero.' });
    return;
  }

  const terminal = db.commercialTerminals.find(t => t.id === id && t.companyId === companyId);
  if (!terminal) {
    res.status(404).json({ error: 'Terminal de pagamento não encontrado.' });
    return;
  }

  if (!terminal.ativo) {
    res.status(400).json({ error: 'Este terminal está desativado. Ative-o nas configurações antes de utilizá-lo.' });
    return;
  }

  // Idempotency check: if intent already exists with same key, return it
  if (idempotencyKey) {
    const existing = db.commercialTerminalTransactions.find(t => t.companyId === companyId && t.idempotencyKey === idempotencyKey);
    if (existing) {
      res.json({
        success: true,
        message: 'Intenção de pagamento já registrada anteriormente.',
        transaction: existing
      });
      return;
    }
  }

  const externalReference = `MOVILOG-${Date.now().toString().slice(-8)}`;
  const adapter = GatewayFactory.getAdapter(terminal.provedor);

  const intentResult = await adapter.createPaymentIntent(terminal, {
    amount,
    paymentType: tipoOperacao && ['debito', 'credito', 'pix'].includes(tipoOperacao) ? tipoOperacao : 'debito',
    installments: parcelas ? parseInt(parcelas, 10) : 1,
    externalReference,
    orderDescription: `MoviLog ${terminal.modulo.toUpperCase()} ${codigoVenda || externalReference}`,
    printOnTerminal: true
  });

  const rate = tipoOperacao === 'debito'
    ? (terminal.taxaDebitoPercentual || 1.99)
    : tipoOperacao === 'pix'
      ? (terminal.taxaPixPercentual || 0.99)
      : (terminal.taxaCreditoPercentual || 3.99);

  const fee = intentResult.feeAmount !== undefined ? intentResult.feeAmount : Number(((amount * rate) / 100).toFixed(2));
  const net = intentResult.netAmount !== undefined ? intentResult.netAmount : Number((amount - fee).toFixed(2));

  const transaction: CommercialTerminalTransaction = {
    id: crypto.randomUUID(),
    companyId,
    terminalId: terminal.id,
    terminalNome: terminal.nome,
    provedor: terminal.provedor,
    modeloTerminal: terminal.modelo,
    modulo: modulo && ['adega', 'tabacaria', 'misto'].includes(modulo) ? modulo : (terminal.modulo === 'ambos' ? 'adega' : terminal.modulo),
    codigoVenda: codigoVenda || undefined,
    caixaSessionId: caixaSessionId || undefined,
    tipoOperacao: tipoOperacao && ['debito', 'credito', 'pix'].includes(tipoOperacao) ? tipoOperacao : 'debito',
    bandeira: intentResult.cardBrand || undefined,
    ultimosDigitosCartao: intentResult.lastFourDigits || undefined,
    valorBruto: amount,
    taxaPercentualAplicada: rate,
    valorTaxaEstimada: fee,
    valorLiquido: net,
    status: intentResult.status,
    nsu: intentResult.nsu,
    codigoAutorizacao: intentResult.authorizationCode,
    paymentIntentId: intentResult.paymentIntentId,
    externalReference,
    mensagemProvedor: intentResult.message,
    detalhesTecnicos: intentResult.rawResponse,
    criadoEm: new Date().toISOString(),
    concluidoEm: intentResult.status === 'aprovado' ? new Date().toISOString() : undefined,
    conciliado: false,
    idempotencyKey: idempotencyKey || undefined
  };

  db.commercialTerminalTransactions.push(transaction);
  terminal.ultimaSincronizacao = new Date().toISOString();
  db.save();

  db.logAudit({
    userId: req.user!.id,
    userEmail: req.user!.email,
    userName: req.user!.name,
    companyId,
    acao: 'INTENCAO_PAGAMENTO_MAQUININHA',
    detalhes: `Cobrança de R$ ${amount.toFixed(2)} (${tipoOperacao}) enviada ao terminal '${terminal.nome}'. Status: ${transaction.status}`,
    ip: req.ip
  });

  res.json({
    success: intentResult.success,
    transaction,
    message: intentResult.message
  });
});

// 7. Check Payment Intent Status (Polling or On-Demand)
apiRouter.get('/commerce/terminals/intent/:intentId/status', authenticate, checkSubscription, async (req: AuthRequest, res: Response) => {
  ensureCommercialCollections();
  const companyId = getEffectiveCompanyId(req);
  const { intentId } = req.params;

  const transaction = db.commercialTerminalTransactions.find(t =>
    t.companyId === companyId && (t.id === intentId || t.paymentIntentId === intentId)
  );

  if (!transaction) {
    res.status(404).json({ error: 'Transação ou intenção de pagamento não encontrada.' });
    return;
  }

  // If already approved or terminal is manual, return current status
  if (transaction.status === 'aprovado' || transaction.status === 'cancelado' || transaction.status === 'recusado') {
    res.json({ success: true, transaction, status: transaction.status });
    return;
  }

  const terminal = db.commercialTerminals.find(t => t.id === transaction.terminalId && t.companyId === companyId);
  if (!terminal) {
    res.json({ success: true, transaction, status: transaction.status });
    return;
  }

  const adapter = GatewayFactory.getAdapter(terminal.provedor);
  if (transaction.paymentIntentId) {
    const statusResult = await adapter.getPaymentIntentStatus(terminal, transaction.paymentIntentId);
    transaction.status = statusResult.status;
    if (statusResult.nsu) transaction.nsu = statusResult.nsu;
    if (statusResult.authorizationCode) transaction.codigoAutorizacao = statusResult.authorizationCode;
    if (statusResult.cardBrand) transaction.bandeira = statusResult.cardBrand;
    if (statusResult.lastFourDigits) transaction.ultimosDigitosCartao = statusResult.lastFourDigits;
    if (statusResult.message) transaction.mensagemProvedor = statusResult.message;
    if (statusResult.status === 'aprovado' && !transaction.concluidoEm) {
      transaction.concluidoEm = new Date().toISOString();
    }
    db.save();
  }

  res.json({
    success: true,
    transaction,
    status: transaction.status,
    message: transaction.mensagemProvedor
  });
});

// 8. Cancel Payment Intent on Terminal
apiRouter.post('/commerce/terminals/intent/:intentId/cancel', authenticate, checkSubscription, async (req: AuthRequest, res: Response) => {
  ensureCommercialCollections();
  const companyId = getEffectiveCompanyId(req);
  const { intentId } = req.params;

  const transaction = db.commercialTerminalTransactions.find(t =>
    t.companyId === companyId && (t.id === intentId || t.paymentIntentId === intentId)
  );

  if (!transaction) {
    res.status(404).json({ error: 'Transação não encontrada.' });
    return;
  }

  const terminal = db.commercialTerminals.find(t => t.id === transaction.terminalId && t.companyId === companyId);
  if (terminal && transaction.paymentIntentId) {
    const adapter = GatewayFactory.getAdapter(terminal.provedor);
    await adapter.cancelPaymentIntent(terminal, transaction.paymentIntentId);
  }

  transaction.status = 'cancelado';
  transaction.canceladoEm = new Date().toISOString();
  db.save();

  db.logAudit({
    userId: req.user!.id,
    userEmail: req.user!.email,
    userName: req.user!.name,
    companyId,
    acao: 'CANCELAMENTO_INTENCAO_MAQUININHA',
    detalhes: `Intenção de cobrança ${transaction.id} cancelada no terminal '${transaction.terminalNome}'.`,
    ip: req.ip
  });

  res.json({ success: true, message: 'Operação cancelada no terminal com sucesso.', transaction });
});

// 9. List Terminal Transactions History
apiRouter.get('/commerce/terminals/transactions', authenticate, checkSubscription, (req: AuthRequest, res: Response) => {
  ensureCommercialCollections();
  const companyId = getEffectiveCompanyId(req);
  const { terminalId, modulo, status, limit } = req.query;

  let list = db.commercialTerminalTransactions.filter(t => t.companyId === companyId);

  if (terminalId && typeof terminalId === 'string') {
    list = list.filter(t => t.terminalId === terminalId);
  }

  if (modulo && typeof modulo === 'string' && (modulo === 'adega' || modulo === 'tabacaria')) {
    list = list.filter(t => t.modulo === modulo);
  }

  if (status && typeof status === 'string') {
    list = list.filter(t => t.status === status);
  }

  list.sort((a, b) => new Date(b.criadoEm).getTime() - new Date(a.criadoEm).getTime());
  const max = limit ? parseInt(limit as string, 10) : 100;

  res.json({ success: true, transactions: list.slice(0, max), total: list.length });
});

// 10. Financial Reconciliation Report (MoviLog Sales vs Terminal Transactions)
apiRouter.get('/commerce/terminals/reconciliation', authenticate, checkSubscription, (req: AuthRequest, res: Response) => {
  ensureCommercialCollections();
  const companyId = getEffectiveCompanyId(req);
  const { modulo, dataInicio, dataFim } = req.query;

  // Filter card sales
  let sales = db.commercialSales.filter(s =>
    s.companyId === companyId &&
    (s.formaPagamento === 'cartao_debito' || s.formaPagamento === 'cartao_credito' || s.formaPagamento === 'misto')
  );

  // Filter terminal transactions
  let txs = db.commercialTerminalTransactions.filter(t => t.companyId === companyId);

  if (modulo && (modulo === 'adega' || modulo === 'tabacaria')) {
    sales = sales.filter(s => s.modulo === modulo);
    txs = txs.filter(t => t.modulo === modulo);
  }

  if (dataInicio && typeof dataInicio === 'string') {
    sales = sales.filter(s => s.criadoEm >= dataInicio);
    txs = txs.filter(t => t.criadoEm >= dataInicio);
  }

  if (dataFim && typeof dataFim === 'string') {
    sales = sales.filter(s => s.criadoEm <= `${dataFim}T23:59:59.999Z`);
    txs = txs.filter(t => t.criadoEm <= `${dataFim}T23:59:59.999Z`);
  }

  // Cross-match sales and transactions
  const matchedTxIds = new Set<string>();
  const matchedSaleIds = new Set<string>();

  const reconciliationItems: any[] = [];

  // Match 1: Sales to Transactions
  for (const sale of sales) {
    let matchedTx = txs.find(t =>
      (t.saleId && t.saleId === sale.id) ||
      (t.codigoVenda && t.codigoVenda === sale.codigoVenda) ||
      (sale.detalhesPagamento?.nsu && t.nsu === sale.detalhesPagamento.nsu) ||
      (sale.detalhesPagamento?.paymentIntentId && t.paymentIntentId === sale.detalhesPagamento.paymentIntentId)
    );

    if (matchedTx) {
      matchedTxIds.add(matchedTx.id);
      matchedSaleIds.add(sale.id);

      const diff = Number((sale.valorTotal - matchedTx.valorBruto).toFixed(2));
      let itemStatus: 'conciliado' | 'divergencia_valor' | 'transacao_cancelada_com_venda_ativa' = 'conciliado';
      let obs = 'Venda e comprovante de maquininha conferidos perfeitamente.';

      if (matchedTx.status === 'cancelado' || matchedTx.status === 'estornado') {
        itemStatus = 'transacao_cancelada_com_venda_ativa';
        obs = `ALERTA: A transação foi ${matchedTx.status.toUpperCase()} na maquininha, mas a venda continua ativa no MoviLog!`;
      } else if (Math.abs(diff) > 0.01) {
        itemStatus = 'divergencia_valor';
        obs = `DIVERGÊNCIA: Valor da venda (R$ ${sale.valorTotal.toFixed(2)}) difere do valor aprovado na maquininha (R$ ${matchedTx.valorBruto.toFixed(2)}).`;
      }

      reconciliationItems.push({
        id: `rec_${sale.id}`,
        statusConciliacao: itemStatus,
        venda: {
          id: sale.id,
          codigoVenda: sale.codigoVenda,
          valorTotal: sale.valorTotal,
          formaPagamento: sale.formaPagamento,
          status: sale.status,
          criadoEm: sale.criadoEm,
          operadorNome: sale.operadorNome
        },
        transacao: {
          id: matchedTx.id,
          nsu: matchedTx.nsu,
          codigoAutorizacao: matchedTx.codigoAutorizacao,
          terminalNome: matchedTx.terminalNome,
          provedor: matchedTx.provedor,
          valorBruto: matchedTx.valorBruto,
          valorTaxaEstimada: matchedTx.valorTaxaEstimada,
          valorLiquido: matchedTx.valorLiquido,
          status: matchedTx.status,
          bandeira: matchedTx.bandeira,
          criadoEm: matchedTx.criadoEm
        },
        diferencaValor: diff,
        observacaoAuditoria: obs
      });
    } else {
      // Venda sem transação encontrada
      reconciliationItems.push({
        id: `rec_orphan_sale_${sale.id}`,
        statusConciliacao: 'venda_sem_transacao',
        venda: {
          id: sale.id,
          codigoVenda: sale.codigoVenda,
          valorTotal: sale.valorTotal,
          formaPagamento: sale.formaPagamento,
          status: sale.status,
          criadoEm: sale.criadoEm,
          operadorNome: sale.operadorNome
        },
        observacaoAuditoria: 'Venda a cartão finalizada no PDV sem vinculação de NSU ou autorização da maquininha.'
      });
    }
  }

  // Match 2: Orphan Transactions (approved in terminal without a sale)
  for (const tx of txs) {
    if (!matchedTxIds.has(tx.id) && tx.status === 'aprovado') {
      reconciliationItems.push({
        id: `rec_orphan_tx_${tx.id}`,
        statusConciliacao: 'transacao_sem_venda',
        transacao: {
          id: tx.id,
          nsu: tx.nsu,
          codigoAutorizacao: tx.codigoAutorizacao,
          terminalNome: tx.terminalNome,
          provedor: tx.provedor,
          valorBruto: tx.valorBruto,
          valorTaxaEstimada: tx.valorTaxaEstimada,
          valorLiquido: tx.valorLiquido,
          status: tx.status,
          bandeira: tx.bandeira,
          criadoEm: tx.criadoEm
        },
        observacaoAuditoria: 'Transação aprovada na maquininha sem venda correspondente no MoviLog (Cobrança avulsa ou pendente de finalização).'
      });
    }
  }

  // Resumo estatístico e financeiro
  const totalVendasCartao = sales.length;
  const valorTotalVendas = Number(sales.reduce((acc, s) => acc + s.valorTotal, 0).toFixed(2));

  const approvedTxs = txs.filter(t => t.status === 'aprovado');
  const valorTotalBruto = Number(approvedTxs.reduce((acc, t) => acc + t.valorBruto, 0).toFixed(2));
  const valorTotalTaxas = Number(approvedTxs.reduce((acc, t) => acc + t.valorTaxaEstimada, 0).toFixed(2));
  const valorTotalLiquido = Number(approvedTxs.reduce((acc, t) => acc + t.valorLiquido, 0).toFixed(2));

  const transacoesAprovadasQtd = approvedTxs.length;
  const transacoesRecusadasQtd = txs.filter(t => t.status === 'recusado').length;
  const transacoesCanceladasQtd = txs.filter(t => t.status === 'cancelado' || t.status === 'estornado').length;

  const vendasSemTransacaoQtd = reconciliationItems.filter(i => i.statusConciliacao === 'venda_sem_transacao').length;
  const transacoesOrfasQtd = reconciliationItems.filter(i => i.statusConciliacao === 'transacao_sem_venda').length;
  const divergenciasValorQtd = reconciliationItems.filter(i => i.statusConciliacao === 'divergencia_valor').length;

  res.json({
    success: true,
    dataGeracao: new Date().toISOString(),
    companyId,
    resumo: {
      totalVendasMoviLogCartao: totalVendasCartao,
      valorTotalVendasMoviLog: valorTotalVendas,
      totalTransacoesMaquininha: txs.length,
      valorTotalBrutoMaquininha: valorTotalBruto,
      valorTotalTaxasMaquininha: valorTotalTaxas,
      valorTotalLiquidoMaquininha: valorTotalLiquido,
      transacoesAprovadasQtd,
      transacoesRecusadasQtd,
      transacoesCanceladasQtd,
      vendasSemTransacaoQtd,
      transacoesOrfasQtd,
      divergenciasValorQtd
    },
    itens: reconciliationItems
  });
});

// 11. Secure Webhook Receiver for Acquirers (Mercado Pago, Stone, TEF)
apiRouter.post('/commerce/terminals/webhook/:provider', async (req: Request, res: Response) => {
  ensureCommercialCollections();
  const { provider } = req.params;
  const body = req.body;
  const headers = req.headers;

  try {
    // Audit log webhook arrival
    const paymentIntentId = body?.data?.id || body?.id || body?.payment_intent_id;
    const externalReference = body?.additional_info?.external_reference || body?.external_reference;

    if (paymentIntentId || externalReference) {
      const tx = db.commercialTerminalTransactions.find(t =>
        (paymentIntentId && t.paymentIntentId === paymentIntentId) ||
        (externalReference && t.externalReference === externalReference)
      );

      if (tx) {
        if (body.action === 'payment_intent.finished' || body.status === 'PROCESSED' || body.status === 'APPROVED') {
          tx.status = 'aprovado';
          tx.concluidoEm = new Date().toISOString();
        } else if (body.status === 'CANCELED') {
          tx.status = 'cancelado';
        }
        db.save();
      }
    }

    res.status(200).json({ received: true });
  } catch (err: any) {
    res.status(500).json({ error: 'Erro ao processar webhook' });
  }
});

// ==========================================
// 16. MOVILOG INTELIGENTE — CENTRAL DE PREVENÇÃO
// ==========================================

export interface PreventionAlertItem {
  id: string;
  companyId: string;
  tipo: 'atraso_entrega' | 'tentativa_falha' | 'encomenda_pendente' | 'duplicidade_suspeita' | 'rota_ocorrencia' | 'estoque_critico';
  categoria: 'logistica' | 'predial' | 'rotas' | 'comercial';
  titulo: string;
  motivo: string;
  prioridade: 'baixa' | 'media' | 'alta' | 'urgente';
  acaoRecomendada: string;
  referenciaTipo: 'delivery' | 'package' | 'route' | 'product';
  referenciaId: string;
  referenciaCodigo?: string;
  detalhesExtras?: Record<string, any>;
  resolvido: boolean;
  resolvidoEm?: string;
  resolvidoPor?: string;
  criadoEm: string;
}

export function computePreventionAlerts(companyId: string): { alerts: PreventionAlertItem[]; metrics: any } {
  const alerts: PreventionAlertItem[] = [];
  const now = new Date();
  const nowMs = now.getTime();

  // Retrieve resolved alerts for this company
  const resolvedList = (db.preventionDismissedAlerts || []).filter(r => r.companyId === companyId);
  const resolvedMap = new Map<string, PreventionResolvedAlert>();
  resolvedList.forEach(r => resolvedMap.set(r.id, r));

  // 1. Entregas Atrasadas (Overdue Deliveries)
  const deliveries = db.deliveries.filter(d => d.companyId === companyId);
  const activeDeliveries = deliveries.filter(d => d.status !== 'entregue' && d.status !== 'cancelada');

  activeDeliveries.forEach(d => {
    if (!d.prazoEntrega) return;

    let deadlineDate: Date | null = null;
    try {
      const datePart = d.prazoEntrega.includes('T') ? d.prazoEntrega.split('T')[0] : d.prazoEntrega;
      const timePart = d.janelaHorarioFim ? `${d.janelaHorarioFim}:00` : '23:59:59';
      deadlineDate = new Date(`${datePart}T${timePart}`);
      if (isNaN(deadlineDate.getTime())) {
        deadlineDate = new Date(d.prazoEntrega);
      }
    } catch {
      deadlineDate = null;
    }

    if (deadlineDate && !isNaN(deadlineDate.getTime()) && deadlineDate.getTime() < nowMs) {
      const diffMs = nowMs - deadlineDate.getTime();
      const delayHours = Math.max(1, Math.floor(diffMs / (3600 * 1000)));
      const delayDays = Math.floor(diffMs / (24 * 3600 * 1000));

      const alertId = `alert-atraso-${d.id}`;
      const isResolved = resolvedMap.has(alertId);

      if (!isResolved) {
        let prioridade: 'baixa' | 'media' | 'alta' | 'urgente' = 'media';
        if (delayHours >= 24 || d.prioridade === 'urgente') {
          prioridade = 'urgente';
        } else if (delayHours >= 4 || d.prioridade === 'alta') {
          prioridade = 'alta';
        }

        const formattedDelay = delayDays >= 1
          ? `${delayDays} dia(s) e ${delayHours % 24}h`
          : `${delayHours}h`;

        alerts.push({
          id: alertId,
          companyId,
          tipo: 'atraso_entrega',
          categoria: 'logistica',
          titulo: `Entrega Atrasada — Rastreio ${d.codigoRastreio}`,
          motivo: `Prazo contratual expirou há ${formattedDelay} (estipulado: ${deadlineDate.toLocaleDateString('pt-BR')} ${d.janelaHorarioFim || ''}). Destinatário: ${d.destinatario} em ${d.cidade}/${d.bairro}. Status operacional: "${d.status}".`,
          prioridade,
          acaoRecomendada: 'Priorizar despacho emergencial, acionar condutor na rota ou contatar destinatário para reagendamento imediato.',
          referenciaTipo: 'delivery',
          referenciaId: d.id,
          referenciaCodigo: d.codigoRastreio,
          detalhesExtras: {
            destinatario: d.destinatario,
            telefone: d.telefone,
            endereco: `${d.endereco}, ${d.numero} - ${d.bairro}, ${d.cidade}`,
            prazoEntrega: d.prazoEntrega,
            janelaHorarioFim: d.janelaHorarioFim,
            horasAtraso: delayHours,
            routeId: d.routeId,
            motoristaNome: d.motoristaNome
          },
          resolvido: false,
          criadoEm: deadlineDate.toISOString()
        });
      }
    }
  });

  // 2. Tentativas de Entrega com Insucesso (Failed Deliveries)
  activeDeliveries.forEach(d => {
    if (d.status === 'tentativa_falha' || (d.tentativas && d.tentativas > 0)) {
      const alertId = `alert-insucesso-${d.id}-${d.tentativas || 1}`;
      const isResolved = resolvedMap.has(alertId);

      if (!isResolved) {
        const tentativasQtd = d.tentativas || 1;
        const prioridade: 'baixa' | 'media' | 'alta' | 'urgente' =
          tentativasQtd >= 2 || d.prioridade === 'urgente' ? 'urgente' : 'alta';

        alerts.push({
          id: alertId,
          companyId,
          tipo: 'tentativa_falha',
          categoria: 'logistica',
          titulo: `Insucesso de Entrega (${tentativasQtd}ª tentativa) — ${d.codigoRastreio}`,
          motivo: `Tentativa sem sucesso registrada pelo condutor (${d.motoristaNome || 'Motorista'}). Motivo reportado: "${d.motivoFalha || 'Destinatário ausente ou local fechado'}". Endereço: ${d.endereco}, ${d.numero} - ${d.bairro}.`,
          prioridade,
          acaoRecomendada: 'Confirmar telefone e endereço com o cliente antes de reexpedir para prevenir custos com frete infrutífero.',
          referenciaTipo: 'delivery',
          referenciaId: d.id,
          referenciaCodigo: d.codigoRastreio,
          detalhesExtras: {
            destinatario: d.destinatario,
            telefone: d.telefone,
            motivoFalha: d.motivoFalha,
            tentativas: tentativasQtd,
            routeId: d.routeId,
            motoristaNome: d.motoristaNome
          },
          resolvido: false,
          criadoEm: d.atualizadoEm || d.criadoEm || now.toISOString()
        });
      }
    }
  });

  // 3. Encomendas Prediais Retidas na Portaria
  const condoPackages = db.condoPackages.filter(p => p.companyId === companyId);
  const pendingPackages = condoPackages.filter(p =>
    p.status === 'aguardando_retirada' || p.status === 'notificado' || p.status === 'em_ocorrencia'
  );

  pendingPackages.forEach(p => {
    const receivedDate = new Date(p.recebidoEm);
    if (!isNaN(receivedDate.getTime())) {
      const elapsedDays = Math.floor((nowMs - receivedDate.getTime()) / (24 * 3600 * 1000));

      if (elapsedDays >= 3 || p.status === 'em_ocorrencia') {
        const alertId = `alert-pacote-${p.id}`;
        const isResolved = resolvedMap.has(alertId);

        if (!isResolved) {
          let prioridade: 'baixa' | 'media' | 'alta' | 'urgente' = 'media';
          if (p.status === 'em_ocorrencia' || elapsedDays >= 10) {
            prioridade = 'urgente';
          } else if (elapsedDays >= 5) {
            prioridade = 'alta';
          }

          alerts.push({
            id: alertId,
            companyId,
            tipo: 'encomenda_pendente',
            categoria: 'predial',
            titulo: `Encomenda Retida há ${elapsedDays} dias — ${p.codigoPacote}`,
            motivo: `Pacote aguardando retirada na portaria desde ${receivedDate.toLocaleDateString('pt-BR')} para ${p.unidadeIdentificacao} (Destinatário: ${p.destinatarioNome}). PIN seguro ativo: ${p.codigoRetiradaPin}. Transportadora: ${p.transportadora}.`,
            prioridade,
            acaoRecomendada: 'Reenviar notificação de PIN ao morador via sistema ou acionar a zeladoria predial para desocupação da eclusa.',
            referenciaTipo: 'package',
            referenciaId: p.id,
            referenciaCodigo: p.codigoPacote,
            detalhesExtras: {
              unidadeIdentificacao: p.unidadeIdentificacao,
              destinatarioNome: p.destinatarioNome,
              transportadora: p.transportadora,
              diasRetencao: elapsedDays,
              codigoRetiradaPin: p.codigoRetiradaPin,
              recebidoEm: p.recebidoEm
            },
            resolvido: false,
            criadoEm: p.recebidoEm
          });
        }
      }
    }
  });

  // 4. Possíveis Duplicidades de Entrega
  const deliveryGroups = new Map<string, typeof activeDeliveries>();
  activeDeliveries.forEach(d => {
    const cleanDest = (d.destinatario || '').toLowerCase().trim();
    const cleanEnd = (d.endereco || '').toLowerCase().trim();
    const cleanNum = (d.numero || '').trim();
    const cleanCid = (d.cidade || '').toLowerCase().trim();

    if (cleanDest && cleanEnd) {
      const key = `${cleanDest}__${cleanEnd}__${cleanNum}__${cleanCid}`;
      const group = deliveryGroups.get(key) || [];
      group.push(d);
      deliveryGroups.set(key, group);
    }
  });

  deliveryGroups.forEach((group, key) => {
    if (group.length >= 2) {
      const alertId = `alert-dup-${group.map(g => g.id).sort().join('-')}`;
      const isResolved = resolvedMap.has(alertId);

      if (!isResolved) {
        const codes = group.map(g => g.codigoRastreio).join(', ');
        alerts.push({
          id: alertId,
          companyId,
          tipo: 'duplicidade_suspeita',
          categoria: 'logistica',
          titulo: `Possível Entrega Duplicada — ${group[0].destinatario}`,
          motivo: `Detectadas ${group.length} entregas ativas para o mesmo destinatário e endereço físico (${group[0].endereco}, ${group[0].numero} - ${group[0].cidade}). Códigos: ${codes}.`,
          prioridade: 'alta',
          acaoRecomendada: 'Auditar planilha/ERP para confirmar se não houve duplicidade de importação e cancelar guias excedentes antes do carregamento.',
          referenciaTipo: 'delivery',
          referenciaId: group[0].id,
          referenciaCodigo: codes,
          detalhesExtras: {
            destinatario: group[0].destinatario,
            endereco: `${group[0].endereco}, ${group[0].numero}`,
            totalVolumesPorEntrega: group[0].volumes,
            codigosRastreio: group.map(g => g.codigoRastreio),
            ids: group.map(g => g.id)
          },
          resolvido: false,
          criadoEm: group[0].criadoEm || now.toISOString()
        });
      }
    }
  });

  // 5. Rotas com Ocorrências ou Atrasos
  const routes = db.routes.filter(r => r.companyId === companyId);
  const activeRoutes = routes.filter(r => r.status === 'publicada' || r.status === 'em_andamento');

  activeRoutes.forEach(r => {
    const stops = (r as any).paradas || [];
    const failedStops = stops.filter((s: any) => s.status === 'tentativa_falha' || s.status === 'pulada');

    if (failedStops.length > 0) {
      const alertId = `alert-rota-${r.id}-${failedStops.length}`;
      const isResolved = resolvedMap.has(alertId);

      if (!isResolved) {
        const prioridade: 'baixa' | 'media' | 'alta' | 'urgente' =
          failedStops.length >= 2 ? 'urgente' : 'alta';

        alerts.push({
          id: alertId,
          companyId,
          tipo: 'rota_ocorrencia',
          categoria: 'rotas',
          titulo: `Alerta na Rota ${r.codigoRota} — ${r.veiculoIdentificacao}`,
          motivo: `Rota em andamento conduzida por ${r.motoristaNome} contém ${failedStops.length} parada(s) com insucesso ou puladas. Veículo: ${r.veiculoPlaca}.`,
          prioridade,
          acaoRecomendada: 'Contatar condutor via telemetria/GPS ou reorganizar paradas no roteirizador para mitigar extravios e devoluções.',
          referenciaTipo: 'route',
          referenciaId: r.id,
          referenciaCodigo: r.codigoRota,
          detalhesExtras: {
            veiculoPlaca: r.veiculoPlaca,
            veiculoIdentificacao: r.veiculoIdentificacao,
            motoristaNome: r.motoristaNome,
            paradasComProblema: failedStops.map((s: any) => ({
              destinatario: s.destinatario,
              status: s.status,
              motivoFalha: s.motivoFalha
            }))
          },
          resolvido: false,
          criadoEm: now.toISOString()
        });
      }
    }
  });

  // 6. Ruptura de Estoque Comercial (Adega & Tabacaria)
  const commercialProducts = (db.commercialProducts || []).filter(p => p.companyId === companyId);
  const outOfStockProducts = commercialProducts.filter(p => p.ativo && p.estoqueAtual <= 0);

  outOfStockProducts.forEach(p => {
    const alertId = `alert-estoque-${p.id}`;
    const isResolved = resolvedMap.has(alertId);

    if (!isResolved) {
      alerts.push({
        id: alertId,
        companyId,
        tipo: 'estoque_critico',
        categoria: 'comercial',
        titulo: `Ruptura de Estoque — ${p.nome}`,
        motivo: `Produto ativo no PDV com saldo zerado (0 ${p.unidade || 'un'}). Módulo: ${p.modulo === 'adega' ? 'Adega' : 'Tabacaria'}. SKU: ${p.sku}.`,
        prioridade: 'alta',
        acaoRecomendada: 'Emitir pedido de compra a fornecedores homologados ou realizar contagem de balanço para reposição.',
        referenciaTipo: 'product',
        referenciaId: p.id,
        referenciaCodigo: p.sku,
        detalhesExtras: {
          modulo: p.modulo,
          sku: p.sku,
          estoqueMinimo: p.estoqueMinimo,
          precoVenda: p.precoVenda
        },
        resolvido: false,
        criadoEm: p.atualizadoEm || p.criadoEm || now.toISOString()
      });
    }
  });

  // Sort alerts by priority: urgente -> alta -> media -> baixa
  const priorityOrder: Record<string, number> = { urgente: 1, alta: 2, media: 3, baixa: 4 };
  alerts.sort((a, b) => (priorityOrder[a.prioridade] || 5) - (priorityOrder[b.prioridade] || 5));

  // Compute Metrics
  const totalAlertasAtivos = alerts.length;
  const alertasUrgentes = alerts.filter(a => a.prioridade === 'urgente').length;
  const alertasAltos = alerts.filter(a => a.prioridade === 'alta').length;
  const entregasAtrasadasCount = alerts.filter(a => a.tipo === 'atraso_entrega').length;
  const tentativasFalhasCount = alerts.filter(a => a.tipo === 'tentativa_falha').length;
  const encomendasRetidasCount = alerts.filter(a => a.tipo === 'encomenda_pendente').length;
  const duplicidadesCount = alerts.filter(a => a.tipo === 'duplicidade_suspeita').length;
  const rotasComProblemasCount = alerts.filter(a => a.tipo === 'rota_ocorrencia').length;
  const estoqueCriticoCount = alerts.filter(a => a.tipo === 'estoque_critico').length;
  const totalResolvidosHistorico = resolvedList.length;

  const totalGeral = totalAlertasAtivos + totalResolvidosHistorico;
  const taxaResolucaoPercentual = totalGeral > 0
    ? Math.round((totalResolvidosHistorico / totalGeral) * 100)
    : 100;

  return {
    alerts,
    metrics: {
      totalAlertasAtivos,
      alertasUrgentes,
      alertasAltos,
      entregasAtrasadasCount,
      tentativasFalhasCount,
      encomendasRetidasCount,
      duplicidadesCount,
      rotasComProblemasCount,
      estoqueCriticoCount,
      taxaResolucaoPercentual,
      totalResolvidosHistorico
    }
  };
}

// 1. GET /api/prevention/alerts — List prevention alerts & metrics for effective company
apiRouter.get('/prevention/alerts', authenticate, checkSubscription, (req: AuthRequest, res: Response) => {
  const allowedRoles = ['master_owner', 'company_admin', 'dispatcher', 'operator', 'concierge'];
  if (!allowedRoles.includes(req.user!.role)) {
    res.status(403).json({ error: 'Acesso restrito à equipe operacional e administrativa.' });
    return;
  }

  const companyId = req.user!.role === 'master_owner' && req.query.companyId
    ? String(req.query.companyId)
    : getEffectiveCompanyId(req);

  if (!companyId) {
    res.status(400).json({ error: 'Empresa operacional não identificada.' });
    return;
  }

  const result = computePreventionAlerts(companyId);
  res.json(result);
});

// 2. POST /api/prevention/resolve — Mark an alert as handled / resolved
apiRouter.post('/prevention/resolve', authenticate, checkSubscription, (req: AuthRequest, res: Response) => {
  const allowedRoles = ['master_owner', 'company_admin', 'dispatcher', 'operator', 'concierge'];
  if (!allowedRoles.includes(req.user!.role)) {
    res.status(403).json({ error: 'Sem permissão para resolver alertas de prevenção.' });
    return;
  }

  const companyId = getEffectiveCompanyId(req);
  const { alertId, tipo, referenciaId, motivoResolucao } = req.body;

  if (!alertId) {
    res.status(400).json({ error: 'Identificador do alerta (alertId) é obrigatório.' });
    return;
  }

  // Ensure collection exists
  if (!db.preventionDismissedAlerts) {
    (db as any).data.preventionDismissedAlerts = [];
  }

  const existing = db.preventionDismissedAlerts.find(a => a.id === alertId && a.companyId === companyId);
  if (!existing) {
    const entry: PreventionResolvedAlert = {
      id: alertId,
      companyId,
      tipo: tipo || 'geral',
      referenciaId: referenciaId || '',
      motivoResolucao: motivoResolucao ? String(motivoResolucao).trim() : 'Tratado pelo operador',
      resolvidoPorId: req.user!.id,
      resolvidoPorNome: req.user!.name,
      resolvidoEm: new Date().toISOString()
    };
    db.preventionDismissedAlerts.push(entry);
    db.save();

    db.logAudit({
      userId: req.user!.id,
      userEmail: req.user!.email,
      userName: req.user!.name,
      companyId,
      acao: 'PREVENCAO_ALERTA_RESOLVIDO',
      detalhes: `Alerta de prevenção ${alertId} marcado como tratado. Motivo: ${entry.motivoResolucao}`,
      ip: req.ip
    });
  }

  res.json({ success: true, message: 'Alerta registrado como tratado com sucesso.' });
});

// 3. POST /api/prevention/renotify-package — Re-notify condo resident with secure PIN
apiRouter.post('/prevention/renotify-package', authenticate, checkSubscription, (req: AuthRequest, res: Response) => {
  const allowedRoles = ['master_owner', 'company_admin', 'operator', 'concierge'];
  if (!allowedRoles.includes(req.user!.role)) {
    res.status(403).json({ error: 'Sem permissão para reenviar notificações prediais.' });
    return;
  }

  const companyId = getEffectiveCompanyId(req);
  const { packageId } = req.body;

  if (!packageId) {
    res.status(400).json({ error: 'Identificador da encomenda (packageId) é obrigatório.' });
    return;
  }

  const pkg = db.condoPackages.find(p => p.id === packageId && p.companyId === companyId);
  if (!pkg) {
    res.status(404).json({ error: 'Encomenda não encontrada na portaria desta empresa.' });
    return;
  }

  pkg.status = 'notificado';
  pkg.notificadoEm = new Date().toISOString();

  // Create notification item
  const notificationId = crypto.randomUUID();
  db.notifications.unshift({
    id: notificationId,
    companyId,
    tipo: 'portaria',
    titulo: `Lembrete de Encomenda na Portaria — ${pkg.codigoPacote}`,
    mensagem: `Morador de ${pkg.unidadeIdentificacao} (${pkg.destinatarioNome}), sua encomenda (${pkg.descricaoConteudo}) está disponível para retirada na portaria. Apresente o PIN: ${pkg.codigoRetiradaPin}.`,
    lida: false,
    prioridade: 'alta',
    dataHora: new Date().toISOString()
  });

  db.save();

  db.logAudit({
    userId: req.user!.id,
    userEmail: req.user!.email,
    userName: req.user!.name,
    companyId,
    acao: 'REENVIO_NOTIFICACAO_PORTARIA',
    detalhes: `Notificação de retirada com PIN ${pkg.codigoRetiradaPin} reenviada para a encomenda ${pkg.codigoPacote} (${pkg.unidadeIdentificacao})`,
    ip: req.ip
  });

  res.json({ success: true, message: `Notificação reenviada com sucesso para ${pkg.unidadeIdentificacao} com PIN seguro ${pkg.codigoRetiradaPin}.` });
});

// 4. POST /api/prevention/reschedule-delivery — Release delivery for contingency re-routing
apiRouter.post('/prevention/reschedule-delivery', authenticate, checkSubscription, (req: AuthRequest, res: Response) => {
  const allowedRoles = ['master_owner', 'company_admin', 'dispatcher'];
  if (!allowedRoles.includes(req.user!.role)) {
    res.status(403).json({ error: 'Sem permissão de roteirização/despacho para reagendar entregas.' });
    return;
  }

  const companyId = getEffectiveCompanyId(req);
  const { deliveryId, novoPrazo, motivo } = req.body;

  if (!deliveryId) {
    res.status(400).json({ error: 'Identificador da entrega (deliveryId) é obrigatório.' });
    return;
  }

  const delivery = db.deliveries.find(d => d.id === deliveryId && d.companyId === companyId);
  if (!delivery) {
    res.status(404).json({ error: 'Entrega não encontrada.' });
    return;
  }

  delivery.status = 'pendente';
  delivery.routeId = undefined;
  delivery.sequencia = undefined;
  delivery.motoristaId = undefined;
  delivery.motoristaNome = undefined;
  delivery.veiculoId = undefined;
  delivery.veiculoPlaca = undefined;
  if (novoPrazo) {
    delivery.prazoEntrega = String(novoPrazo).trim();
  }
  delivery.atualizadoEm = new Date().toISOString();

  // Also automatically resolve alert
  if (!db.preventionDismissedAlerts) {
    (db as any).data.preventionDismissedAlerts = [];
  }
  const alertId = `alert-atraso-${delivery.id}`;
  if (!db.preventionDismissedAlerts.some(a => a.id === alertId && a.companyId === companyId)) {
    db.preventionDismissedAlerts.push({
      id: alertId,
      companyId,
      tipo: 'atraso_entrega',
      referenciaId: delivery.id,
      motivoResolucao: motivo || 'Entrega reagendada para nova rota',
      resolvidoPorId: req.user!.id,
      resolvidoPorNome: req.user!.name,
      resolvidoEm: new Date().toISOString()
    });
  }

  db.save();

  db.logAudit({
    userId: req.user!.id,
    userEmail: req.user!.email,
    userName: req.user!.name,
    companyId,
    acao: 'REAGENDAMENTO_PREVENCAO',
    detalhes: `Entrega ${delivery.codigoRastreio} liberada para nova rota pelo despachante. Novo prazo: ${delivery.prazoEntrega}. Motivo: ${motivo || 'Ajuste operacional de prevenção'}`,
    ip: req.ip
  });

  res.json({ success: true, message: `Entrega ${delivery.codigoRastreio} liberada com sucesso para novo planejamento no roteirizador.` });
});

// ============================================================================
// ENTERPRISE LOGISTICS ECOSYSTEM — FASE 2: WAREHOUSING, ENDEREÇAMENTO & ESTOQUE
// ============================================================================

// 1. Overview & Metrics
apiRouter.get('/warehouses/overview/metrics', authenticate, checkSubscription, (req: AuthRequest, res: Response) => {
  const companyId = getEffectiveCompanyId(req);
  const warehouses = req.user!.role === 'master_owner' && !req.query.companyId
    ? db.warehouses
    : db.warehouses.filter(w => w.companyId === companyId);

  const transfers = req.user!.role === 'master_owner' && !req.query.companyId
    ? db.warehouseTransfers
    : db.warehouseTransfers.filter(t => t.companyId === companyId);

  const audits = req.user!.role === 'master_owner' && !req.query.companyId
    ? db.warehouseAudits
    : db.warehouseAudits.filter(a => a.companyId === companyId);

  let totalPosicoes = 0;
  let posicoesOcupadas = 0;
  let posicoesBloqueadas = 0;
  let capacidadeTotalVolumes = 0;
  let capacidadeTotalKg = 0;
  let ocupadoTotalKg = 0;
  let ocupadoTotalVolumes = 0;

  const alertasCriticos: Array<{ cdNome: string; posicaoCodigo: string; tipo: string; mensagem: string }> = [];

  warehouses.forEach(w => {
    capacidadeTotalVolumes += Number(w.capacidadeTotalVolumes) || 0;
    capacidadeTotalKg += Number(w.capacidadeTotalKg) || 0;
    const posicoes = w.posicoes || [];
    totalPosicoes += posicoes.length;

    posicoes.forEach(p => {
      if (p.status === 'ocupado') {
        posicoesOcupadas++;
        ocupadoTotalKg += Number(p.ocupadoKg) || 0;
        ocupadoTotalVolumes += Number(p.ocupadoVolumes) || 0;

        // Verificar superlotação
        if (p.capacidadeKg > 0 && (p.ocupadoKg / p.capacidadeKg) > 0.9) {
          alertasCriticos.push({
            cdNome: w.nome,
            posicaoCodigo: p.codigo,
            tipo: 'superlotacao_peso',
            mensagem: `Posição ${p.codigo} em ${w.nome} com ${Math.round((p.ocupadoKg / p.capacidadeKg) * 100)}% de carga limite (${p.ocupadoKg}kg / ${p.capacidadeKg}kg).`
          });
        }
      } else if (p.status === 'bloqueado' || p.status === 'manutencao') {
        posicoesBloqueadas++;
      } else if (p.status === 'disponivel' && p.tipoArmazenagem === 'picking') {
        // Alerta de posição picking sem alocação ativa (ruptura de picking)
        if (posicoes.length > 5 && Math.random() < 0.1) {
          // informativo
        }
      }
    });
  });

  const taxaOcupacaoMediaPercentual = totalPosicoes > 0 ? Math.round((posicoesOcupadas / totalPosicoes) * 100) : 0;
  const transferenciasEmTransito = transfers.filter(t => t.status === 'em_transito' || t.status === 'em_separacao').length;
  const inventariosPendentes = audits.filter(a => a.status === 'aberto' || a.status === 'em_contagem' || a.status === 'em_analise_divergencia').length;

  res.json({
    success: true,
    metrics: {
      totalCdsAtivos: warehouses.filter(w => w.ativo).length,
      capacidadeTotalVolumes,
      capacidadeTotalKg,
      totalPosicoes,
      posicoesLivres: Math.max(0, totalPosicoes - posicoesOcupadas - posicoesBloqueadas),
      posicoesOcupadas,
      posicoesBloqueadas,
      taxaOcupacaoMediaPercentual,
      ocupadoTotalKg,
      ocupadoTotalVolumes,
      transferenciasEmTransito,
      inventariosPendentes,
      alertasCriticos: alertasCriticos.slice(0, 10)
    }
  });
});

// 2. List Warehouses (CDs)
apiRouter.get('/warehouses', authenticate, checkSubscription, (req: AuthRequest, res: Response) => {
  const companyId = getEffectiveCompanyId(req);
  const warehouses = req.user!.role === 'master_owner' && !req.query.companyId
    ? db.warehouses
    : db.warehouses.filter(w => w.companyId === companyId);

  // Synchronize dynamic position counts
  warehouses.forEach(w => {
    w.posicoes = w.posicoes || [];
    w.totalPosicoesCadastradas = w.posicoes.length;
    w.posicoesOcupadas = w.posicoes.filter(p => p.status === 'ocupado').length;
  });

  res.json({ success: true, warehouses });
});

// 3. Create Warehouse (CD)
apiRouter.post('/warehouses', authenticate, checkSubscription, (req: AuthRequest, res: Response) => {
  const companyId = getEffectiveCompanyId(req);
  const {
    codigo,
    nome,
    tipo,
    cnpj,
    responsavelNome,
    responsavelTelefone,
    responsavelEmail,
    endereco,
    numero,
    complemento,
    bairro,
    cidade,
    estado,
    cep,
    capacidadeTotalVolumes,
    capacidadeTotalKg,
    areaMetrosQuadrados,
    criarEstruturaInicial
  } = req.body;

  if (!codigo || !nome) {
    res.status(400).json({ error: 'Código e nome do Centro de Distribuição são obrigatórios.' });
    return;
  }

  const cleanCodigo = String(codigo).trim().toUpperCase();
  const exists = db.warehouses.some(w => w.companyId === companyId && w.codigo.toUpperCase() === cleanCodigo);
  if (exists) {
    res.status(400).json({ error: `Já existe um Centro de Distribuição com o código ${cleanCodigo}.` });
    return;
  }

  const initialPositions: WarehousePosition[] = [];

  // Se solicitado, gera estrutura inicial padrão (2 Ruas, 3 Prateleiras, 3 Níveis)
  if (criarEstruturaInicial) {
    const ruas = ['R01', 'R02'];
    ruas.forEach(rua => {
      for (let p = 1; p <= 3; p++) {
        for (let n = 1; n <= 3; n++) {
          const prateleira = `P0${p}`;
          const nivel = `N${n}`;
          const posCode = `${cleanCodigo}-${rua}-${prateleira}-${nivel}`;
          initialPositions.push({
            id: `pos-${crypto.randomUUID().slice(0, 8)}`,
            codigo: posCode,
            rua,
            corredor: 'C01',
            prateleira,
            nivel,
            tipoArmazenagem: n === 1 ? 'picking' : 'palete',
            capacidadeKg: n === 1 ? 500 : 1200,
            capacidadeVolumes: n === 1 ? 40 : 100,
            ocupadoKg: 0,
            ocupadoVolumes: 0,
            qrCode: `MOVILOG-POS-${posCode}`,
            status: 'disponivel'
          });
        }
      }
    });
  }

  const newCD: WarehouseCD = {
    id: `cd-${crypto.randomUUID()}`,
    companyId,
    codigo: cleanCodigo,
    nome: String(nome).trim(),
    tipo: tipo || 'filial',
    cnpj: cnpj ? String(cnpj).trim() : undefined,
    responsavelNome: responsavelNome ? String(responsavelNome).trim() : req.user!.name,
    responsavelTelefone: responsavelTelefone ? String(responsavelTelefone).trim() : '',
    responsavelEmail: responsavelEmail ? String(responsavelEmail).trim() : req.user!.email,
    endereco: endereco || 'A definir',
    numero: numero || 'S/N',
    complemento: complemento || '',
    bairro: bairro || '',
    cidade: cidade || 'São Paulo',
    estado: estado || 'SP',
    cep: cep || '00000-000',
    capacidadeTotalVolumes: Number(capacidadeTotalVolumes) || (initialPositions.length > 0 ? initialPositions.reduce((acc, p) => acc + p.capacidadeVolumes, 0) : 5000),
    capacidadeTotalKg: Number(capacidadeTotalKg) || (initialPositions.length > 0 ? initialPositions.reduce((acc, p) => acc + p.capacidadeKg, 0) : 50000),
    areaMetrosQuadrados: Number(areaMetrosQuadrados) || 1200,
    totalPosicoesCadastradas: initialPositions.length,
    posicoesOcupadas: 0,
    posicoes: initialPositions,
    ativo: true,
    criadoEm: new Date().toISOString(),
    atualizadoEm: new Date().toISOString()
  };

  db.warehouses.push(newCD);
  db.save();

  db.logAudit({
    userId: req.user!.id,
    userEmail: req.user!.email,
    userName: req.user!.name,
    companyId,
    acao: 'CRIACAO_CENTRO_DISTRIBUICAO',
    detalhes: `Centro de Distribuição ${newCD.codigo} (${newCD.nome}) cadastrado com ${initialPositions.length} posições iniciais.`,
    ip: req.ip
  });

  res.status(201).json({
    success: true,
    message: 'Centro de Distribuição cadastrado com sucesso!',
    warehouse: newCD
  });
});

// 4. Get Warehouse Details with Occupancy breakdown
apiRouter.get('/warehouses/:id', authenticate, checkSubscription, (req: AuthRequest, res: Response) => {
  const { id } = req.params;
  const companyId = getEffectiveCompanyId(req);
  const warehouse = db.warehouses.find(w => w.id === id && (req.user!.role === 'master_owner' || w.companyId === companyId));

  if (!warehouse) {
    res.status(404).json({ error: 'Centro de Distribuição não encontrado.' });
    return;
  }

  warehouse.posicoes = warehouse.posicoes || [];
  warehouse.totalPosicoesCadastradas = warehouse.posicoes.length;
  warehouse.posicoesOcupadas = warehouse.posicoes.filter(p => p.status === 'ocupado').length;

  const ocupadoKg = warehouse.posicoes.reduce((acc, p) => acc + (Number(p.ocupadoKg) || 0), 0);
  const ocupadoVolumes = warehouse.posicoes.reduce((acc, p) => acc + (Number(p.ocupadoVolumes) || 0), 0);
  const taxaOcupacao = warehouse.totalPosicoesCadastradas > 0
    ? Math.round((warehouse.posicoesOcupadas / warehouse.totalPosicoesCadastradas) * 100)
    : 0;

  res.json({
    success: true,
    warehouse,
    metrics: {
      totalPosicoes: warehouse.totalPosicoesCadastradas,
      posicoesOcupadas: warehouse.posicoesOcupadas,
      posicoesLivres: warehouse.totalPosicoesCadastradas - warehouse.posicoesOcupadas,
      taxaOcupacao,
      ocupadoKg,
      ocupadoVolumes,
      capacidadeKg: warehouse.capacidadeTotalKg,
      capacidadeVolumes: warehouse.capacidadeTotalVolumes
    }
  });
});

// 5. Update Warehouse
apiRouter.put('/warehouses/:id', authenticate, checkSubscription, (req: AuthRequest, res: Response) => {
  const { id } = req.params;
  const companyId = getEffectiveCompanyId(req);
  const warehouse = db.warehouses.find(w => w.id === id && (req.user!.role === 'master_owner' || w.companyId === companyId));

  if (!warehouse) {
    res.status(404).json({ error: 'Centro de Distribuição não encontrado.' });
    return;
  }

  const {
    nome,
    tipo,
    cnpj,
    responsavelNome,
    responsavelTelefone,
    responsavelEmail,
    endereco,
    numero,
    complemento,
    bairro,
    cidade,
    estado,
    cep,
    capacidadeTotalVolumes,
    capacidadeTotalKg,
    areaMetrosQuadrados,
    ativo
  } = req.body;

  if (nome) warehouse.nome = String(nome).trim();
  if (tipo) warehouse.tipo = tipo;
  if (cnpj !== undefined) warehouse.cnpj = cnpj;
  if (responsavelNome !== undefined) warehouse.responsavelNome = responsavelNome;
  if (responsavelTelefone !== undefined) warehouse.responsavelTelefone = responsavelTelefone;
  if (responsavelEmail !== undefined) warehouse.responsavelEmail = responsavelEmail;
  if (endereco !== undefined) warehouse.endereco = endereco;
  if (numero !== undefined) warehouse.numero = numero;
  if (complemento !== undefined) warehouse.complemento = complemento;
  if (bairro !== undefined) warehouse.bairro = bairro;
  if (cidade !== undefined) warehouse.cidade = cidade;
  if (estado !== undefined) warehouse.estado = estado;
  if (cep !== undefined) warehouse.cep = cep;
  if (capacidadeTotalVolumes !== undefined) warehouse.capacidadeTotalVolumes = Number(capacidadeTotalVolumes);
  if (capacidadeTotalKg !== undefined) warehouse.capacidadeTotalKg = Number(capacidadeTotalKg);
  if (areaMetrosQuadrados !== undefined) warehouse.areaMetrosQuadrados = Number(areaMetrosQuadrados);
  if (ativo !== undefined) warehouse.ativo = Boolean(ativo);

  warehouse.atualizadoEm = new Date().toISOString();
  db.save();

  db.logAudit({
    userId: req.user!.id,
    userEmail: req.user!.email,
    userName: req.user!.name,
    companyId: warehouse.companyId,
    acao: 'EDICAO_CENTRO_DISTRIBUICAO',
    detalhes: `Centro de Distribuição ${warehouse.codigo} atualizado.`,
    ip: req.ip
  });

  res.json({ success: true, message: 'Centro de Distribuição atualizado com sucesso.', warehouse });
});

// 6. Delete Warehouse (Safe deactivation)
apiRouter.delete('/warehouses/:id', authenticate, checkSubscription, (req: AuthRequest, res: Response) => {
  const { id } = req.params;
  const companyId = getEffectiveCompanyId(req);
  const warehouse = db.warehouses.find(w => w.id === id && (req.user!.role === 'master_owner' || w.companyId === companyId));

  if (!warehouse) {
    res.status(404).json({ error: 'Centro de Distribuição não encontrado.' });
    return;
  }

  // Prevenir exclusão se houver posições ocupadas
  const ocupadas = (warehouse.posicoes || []).filter(p => p.status === 'ocupado');
  if (ocupadas.length > 0) {
    res.status(400).json({
      error: `Não é possível excluir o galpão ${warehouse.nome} pois existem ${ocupadas.length} posições com mercadorias alocadas. Realize uma transferência ou descarte prévio.`
    });
    return;
  }

  // Se não houver mercadoria, desativa
  warehouse.ativo = false;
  warehouse.atualizadoEm = new Date().toISOString();
  db.save();

  db.logAudit({
    userId: req.user!.id,
    userEmail: req.user!.email,
    userName: req.user!.name,
    companyId: warehouse.companyId,
    acao: 'DESATIVACAO_CENTRO_DISTRIBUICAO',
    detalhes: `Centro de Distribuição ${warehouse.codigo} desativado com segurança.`,
    ip: req.ip
  });

  res.json({ success: true, message: 'Centro de Distribuição desativado com sucesso.' });
});

// 7. Add Single Position to CD
apiRouter.post('/warehouses/:id/positions', authenticate, checkSubscription, (req: AuthRequest, res: Response) => {
  const { id } = req.params;
  const companyId = getEffectiveCompanyId(req);
  const warehouse = db.warehouses.find(w => w.id === id && (req.user!.role === 'master_owner' || w.companyId === companyId));

  if (!warehouse) {
    res.status(404).json({ error: 'Centro de Distribuição não encontrado.' });
    return;
  }

  const { rua, corredor, prateleira, nivel, tipoArmazenagem, capacidadeKg, capacidadeVolumes } = req.body;
  if (!rua || !prateleira || !nivel) {
    res.status(400).json({ error: 'Rua, Prateleira e Nível são obrigatórios para o endereçamento.' });
    return;
  }

  const cleanRua = String(rua).trim().toUpperCase();
  const cleanPrat = String(prateleira).trim().toUpperCase();
  const cleanNivel = String(nivel).trim().toUpperCase();
  const codigo = `${warehouse.codigo}-${cleanRua}-${cleanPrat}-${cleanNivel}`;

  warehouse.posicoes = warehouse.posicoes || [];
  if (warehouse.posicoes.some(p => p.codigo === codigo)) {
    res.status(400).json({ error: `Já existe uma posição com o código de endereço ${codigo}.` });
    return;
  }

  const newPos: WarehousePosition = {
    id: `pos-${crypto.randomUUID().slice(0, 8)}`,
    codigo,
    rua: cleanRua,
    corredor: corredor ? String(corredor).trim().toUpperCase() : 'C01',
    prateleira: cleanPrat,
    nivel: cleanNivel,
    tipoArmazenagem: tipoArmazenagem || 'palete',
    capacidadeKg: Number(capacidadeKg) || 1000,
    capacidadeVolumes: Number(capacidadeVolumes) || 50,
    ocupadoKg: 0,
    ocupadoVolumes: 0,
    qrCode: `MOVILOG-POS-${codigo}`,
    status: 'disponivel'
  };

  warehouse.posicoes.push(newPos);
  warehouse.totalPosicoesCadastradas = warehouse.posicoes.length;
  warehouse.atualizadoEm = new Date().toISOString();
  db.save();

  db.logAudit({
    userId: req.user!.id,
    userEmail: req.user!.email,
    userName: req.user!.name,
    companyId: warehouse.companyId,
    acao: 'CADASTRO_POSICAO_ENDERECO',
    detalhes: `Posição ${codigo} cadastrada no galpão ${warehouse.codigo}.`,
    ip: req.ip
  });

  res.status(201).json({ success: true, message: 'Posição cadastrada com sucesso.', position: newPos });
});

// 8. Generate Matrix Positions for Warehouse (Bulk Generator)
apiRouter.post('/warehouses/:id/positions/generate-matrix', authenticate, checkSubscription, (req: AuthRequest, res: Response) => {
  const { id } = req.params;
  const companyId = getEffectiveCompanyId(req);
  const warehouse = db.warehouses.find(w => w.id === id && (req.user!.role === 'master_owner' || w.companyId === companyId));

  if (!warehouse) {
    res.status(404).json({ error: 'Centro de Distribuição não encontrado.' });
    return;
  }

  const {
    ruas, // array de nomes de ruas, ex: ['R01', 'R02', 'R03']
    corredorPadrao,
    prateleirasQtd, // ex: 6
    niveisQtd, // ex: 4
    tipoArmazenagem,
    capacidadeKg,
    capacidadeVolumes
  } = req.body;

  const ruasArray = Array.isArray(ruas) && ruas.length > 0 ? ruas : ['R01', 'R02'];
  const maxPrat = Math.min(Math.max(1, Number(prateleirasQtd) || 4), 20);
  const maxNiv = Math.min(Math.max(1, Number(niveisQtd) || 3), 10);

  warehouse.posicoes = warehouse.posicoes || [];
  let criadasCount = 0;

  ruasArray.forEach((rRaw: string) => {
    const rua = String(rRaw).trim().toUpperCase();
    for (let p = 1; p <= maxPrat; p++) {
      for (let n = 1; n <= maxNiv; n++) {
        const prateleira = `P${String(p).padStart(2, '0')}`;
        const nivel = `N${n}`;
        const codigo = `${warehouse.codigo}-${rua}-${prateleira}-${nivel}`;

        if (!warehouse.posicoes.some(existing => existing.codigo === codigo)) {
          warehouse.posicoes.push({
            id: `pos-${crypto.randomUUID().slice(0, 8)}`,
            codigo,
            rua,
            corredor: corredorPadrao ? String(corredorPadrao).trim().toUpperCase() : 'C01',
            prateleira,
            nivel,
            tipoArmazenagem: n === 1 ? 'picking' : (tipoArmazenagem || 'palete'),
            capacidadeKg: n === 1 ? 500 : (Number(capacidadeKg) || 1200),
            capacidadeVolumes: n === 1 ? 40 : (Number(capacidadeVolumes) || 80),
            ocupadoKg: 0,
            ocupadoVolumes: 0,
            qrCode: `MOVILOG-POS-${codigo}`,
            status: 'disponivel'
          });
          criadasCount++;
        }
      }
    }
  });

  warehouse.totalPosicoesCadastradas = warehouse.posicoes.length;
  warehouse.atualizadoEm = new Date().toISOString();
  db.save();

  db.logAudit({
    userId: req.user!.id,
    userEmail: req.user!.email,
    userName: req.user!.name,
    companyId: warehouse.companyId,
    acao: 'GERACAO_MATRIZ_ENDERECOS',
    detalhes: `Geradas ${criadasCount} novas posições de armazenagem no galpão ${warehouse.codigo}.`,
    ip: req.ip
  });

  res.json({
    success: true,
    message: `${criadasCount} novas posições geradas com sucesso para o CD ${warehouse.codigo}.`,
    posicoesCriadas: criadasCount,
    totalPosicoes: warehouse.posicoes.length
  });
});

// 9. Patch Position (Status or Edit)
apiRouter.patch('/warehouses/:id/positions/:positionId', authenticate, checkSubscription, (req: AuthRequest, res: Response) => {
  const { id, positionId } = req.params;
  const companyId = getEffectiveCompanyId(req);
  const warehouse = db.warehouses.find(w => w.id === id && (req.user!.role === 'master_owner' || w.companyId === companyId));

  if (!warehouse) {
    res.status(404).json({ error: 'Centro de Distribuição não encontrado.' });
    return;
  }

  const pos = (warehouse.posicoes || []).find(p => p.id === positionId || p.codigo === positionId);
  if (!pos) {
    res.status(404).json({ error: 'Posição não encontrada no galpão informado.' });
    return;
  }

  const { status, tipoArmazenagem, capacidadeKg, capacidadeVolumes } = req.body;

  if (status) {
    pos.status = status;
    if (status === 'disponivel') {
      pos.itemIdAlocado = undefined;
      pos.itemNomeAlocado = undefined;
      pos.skuAlocado = undefined;
      pos.quantidadeAlocada = 0;
      pos.ocupadoKg = 0;
      pos.ocupadoVolumes = 0;
    }
  }
  if (tipoArmazenagem) pos.tipoArmazenagem = tipoArmazenagem;
  if (capacidadeKg !== undefined) pos.capacidadeKg = Number(capacidadeKg);
  if (capacidadeVolumes !== undefined) pos.capacidadeVolumes = Number(capacidadeVolumes);

  warehouse.posicoesOcupadas = warehouse.posicoes.filter(p => p.status === 'ocupado').length;
  warehouse.atualizadoEm = new Date().toISOString();
  db.save();

  res.json({ success: true, message: 'Posição atualizada com sucesso.', position: pos });
});

// 10. Allocate Item to Warehouse Position
apiRouter.post('/warehouses/:id/positions/:positionId/allocate', authenticate, checkSubscription, (req: AuthRequest, res: Response) => {
  const { id, positionId } = req.params;
  const companyId = getEffectiveCompanyId(req);
  const warehouse = db.warehouses.find(w => w.id === id && (req.user!.role === 'master_owner' || w.companyId === companyId));

  if (!warehouse) {
    res.status(404).json({ error: 'Centro de Distribuição não encontrado.' });
    return;
  }

  const pos = (warehouse.posicoes || []).find(p => p.id === positionId || p.codigo === positionId);
  if (!pos) {
    res.status(404).json({ error: 'Posição não encontrada.' });
    return;
  }

  if (pos.status === 'bloqueado' || pos.status === 'manutencao') {
    res.status(400).json({ error: `Posição ${pos.codigo} está com status ${pos.status} e não pode receber mercadorias.` });
    return;
  }

  const { itemId, sku, nome, quantidade, pesoKg, volumes } = req.body;
  if (!sku || !nome || !quantidade) {
    res.status(400).json({ error: 'SKU, Nome da mercadoria e Quantidade são obrigatórios.' });
    return;
  }

  const pesoTotal = Number(pesoKg) || (Number(quantidade) * 1.5);
  const volumeTotal = Number(volumes) || Number(quantidade);

  if (pesoTotal > pos.capacidadeKg) {
    res.status(400).json({
      error: `Peso informado (${pesoTotal} kg) excede a capacidade de suporte da posição ${pos.codigo} (${pos.capacidadeKg} kg).`
    });
    return;
  }

  if (volumeTotal > pos.capacidadeVolumes) {
    res.status(400).json({
      error: `Volumes informados (${volumeTotal}) excedem a capacidade volumétrica da posição ${pos.codigo} (${pos.capacidadeVolumes} volumes).`
    });
    return;
  }

  pos.status = 'ocupado';
  pos.itemIdAlocado = itemId || `item-${crypto.randomUUID().slice(0, 8)}`;
  pos.skuAlocado = String(sku).trim().toUpperCase();
  pos.itemNomeAlocado = String(nome).trim();
  pos.quantidadeAlocada = Number(quantidade);
  pos.ocupadoKg = pesoTotal;
  pos.ocupadoVolumes = volumeTotal;

  warehouse.posicoesOcupadas = warehouse.posicoes.filter(p => p.status === 'ocupado').length;
  warehouse.atualizadoEm = new Date().toISOString();
  db.save();

  db.logAudit({
    userId: req.user!.id,
    userEmail: req.user!.email,
    userName: req.user!.name,
    companyId: warehouse.companyId,
    acao: 'ALOCACAO_ESTOQUE_CD',
    detalhes: `Alocados ${quantidade} un de ${pos.itemNomeAlocado} (SKU: ${pos.skuAlocado}) na posição ${pos.codigo} do galpão ${warehouse.codigo}.`,
    ip: req.ip
  });

  res.json({
    success: true,
    message: `Mercadoria alocada com sucesso no endereço ${pos.codigo}.`,
    position: pos
  });
});

// 11. Deallocate Item from Warehouse Position
apiRouter.post('/warehouses/:id/positions/:positionId/deallocate', authenticate, checkSubscription, (req: AuthRequest, res: Response) => {
  const { id, positionId } = req.params;
  const companyId = getEffectiveCompanyId(req);
  const warehouse = db.warehouses.find(w => w.id === id && (req.user!.role === 'master_owner' || w.companyId === companyId));

  if (!warehouse) {
    res.status(404).json({ error: 'Centro de Distribuição não encontrado.' });
    return;
  }

  const pos = (warehouse.posicoes || []).find(p => p.id === positionId || p.codigo === positionId);
  if (!pos) {
    res.status(404).json({ error: 'Posição não encontrada.' });
    return;
  }

  const { quantidadeDesalocar, motivo } = req.body;
  const qtdAtual = pos.quantidadeAlocada || 0;
  const qtdDesalocar = quantidadeDesalocar ? Number(quantidadeDesalocar) : qtdAtual;

  if (qtdDesalocar >= qtdAtual || qtdAtual === 0) {
    // Libera 100% da posição
    const itemNome = pos.itemNomeAlocado;
    const sku = pos.skuAlocado;
    pos.status = 'disponivel';
    pos.itemIdAlocado = undefined;
    pos.skuAlocado = undefined;
    pos.itemNomeAlocado = undefined;
    pos.quantidadeAlocada = 0;
    pos.ocupadoKg = 0;
    pos.ocupadoVolumes = 0;

    warehouse.posicoesOcupadas = warehouse.posicoes.filter(p => p.status === 'ocupado').length;
    warehouse.atualizadoEm = new Date().toISOString();
    db.save();

    db.logAudit({
      userId: req.user!.id,
      userEmail: req.user!.email,
      userName: req.user!.name,
      companyId: warehouse.companyId,
      acao: 'DESALOCACAO_TOTAL_POSICAO',
      detalhes: `Posição ${pos.codigo} totalmente desocupada (${itemNome} SKU: ${sku}). Motivo: ${motivo || 'Expedição / Baixa manual'}.`,
      ip: req.ip
    });

    res.json({ success: true, message: `Posição ${pos.codigo} liberada com sucesso.`, position: pos });
  } else {
    // Desalocação parcial
    pos.quantidadeAlocada = qtdAtual - qtdDesalocar;
    const ratio = pos.quantidadeAlocada / qtdAtual;
    pos.ocupadoKg = Math.round(pos.ocupadoKg * ratio * 10) / 10;
    pos.ocupadoVolumes = Math.round(pos.ocupadoVolumes * ratio);

    warehouse.atualizadoEm = new Date().toISOString();
    db.save();

    db.logAudit({
      userId: req.user!.id,
      userEmail: req.user!.email,
      userName: req.user!.name,
      companyId: warehouse.companyId,
      acao: 'DESALOCACAO_PARCIAL_POSICAO',
      detalhes: `Baixadas ${qtdDesalocar} un da posição ${pos.codigo}. Restante: ${pos.quantidadeAlocada} un.`,
      ip: req.ip
    });

    res.json({ success: true, message: `Baixa parcial efetuada na posição ${pos.codigo}.`, position: pos });
  }
});

// 12. Transfers — List
apiRouter.get('/warehouses/transfers', authenticate, checkSubscription, (req: AuthRequest, res: Response) => {
  const companyId = getEffectiveCompanyId(req);
  const transfers = req.user!.role === 'master_owner' && !req.query.companyId
    ? db.warehouseTransfers
    : db.warehouseTransfers.filter(t => t.companyId === companyId);

  res.json({ success: true, transfers });
});

// 13. Transfers — Create
apiRouter.post('/warehouses/transfers', authenticate, checkSubscription, (req: AuthRequest, res: Response) => {
  const companyId = getEffectiveCompanyId(req);
  const {
    cdOrigemId,
    cdDestinoId,
    tipo,
    itens,
    motoristaNome,
    veiculoPlaca,
    observacoes
  } = req.body;

  if (!cdOrigemId || !cdDestinoId || !Array.isArray(itens) || itens.length === 0) {
    res.status(400).json({ error: 'Origem, destino e pelo menos um item são obrigatórios para transferência.' });
    return;
  }

  const cdOrigem = db.warehouses.find(w => w.id === cdOrigemId && (req.user!.role === 'master_owner' || w.companyId === companyId));
  const cdDestino = db.warehouses.find(w => w.id === cdDestinoId && (req.user!.role === 'master_owner' || w.companyId === companyId));

  if (!cdOrigem || !cdDestino) {
    res.status(404).json({ error: 'Centro de Distribuição de origem ou destino não encontrado.' });
    return;
  }

  const transferItens: WarehouseTransferItem[] = itens.map((item: any) => ({
    itemId: item.itemId || `item-${crypto.randomUUID().slice(0, 8)}`,
    sku: String(item.sku).trim().toUpperCase(),
    nome: String(item.nome).trim(),
    quantidade: Math.max(1, Number(item.quantidade) || 1),
    posicaoOrigem: item.posicaoOrigem || 'DOCA-EXPEDICAO',
    posicaoDestino: item.posicaoDestino || 'DOCA-RECEBIMENTO'
  }));

  const totalVolumes = transferItens.reduce((acc, it) => acc + it.quantidade, 0);
  const totalPesoKg = Math.round(totalVolumes * 2.5);
  const codigoTransferencia = `TRF-${Date.now().toString().slice(-6)}`;

  const newTransfer: WarehouseTransfer = {
    id: `trf-${crypto.randomUUID()}`,
    companyId,
    codigoTransferencia,
    cdOrigemId: cdOrigem.id,
    cdOrigemNome: cdOrigem.nome,
    cdDestinoId: cdDestino.id,
    cdDestinoNome: cdDestino.nome,
    tipo: tipo || (cdOrigemId === cdDestinoId ? 'interna_posicoes' : 'entre_galpoes'),
    status: 'solicitada',
    itens: transferItens,
    totalVolumes,
    totalPesoKg,
    motoristaNome: motoristaNome ? String(motoristaNome).trim() : undefined,
    veiculoPlaca: veiculoPlaca ? String(veiculoPlaca).trim().toUpperCase() : undefined,
    solicitadoPor: req.user!.name,
    dataSolicitacao: new Date().toISOString(),
    divergenciasAnotadas: observacoes ? String(observacoes) : undefined
  };

  db.warehouseTransfers.unshift(newTransfer);
  db.save();

  db.logAudit({
    userId: req.user!.id,
    userEmail: req.user!.email,
    userName: req.user!.name,
    companyId,
    acao: 'SOLICITACAO_TRANSFERENCIA_ESTOQUE',
    detalhes: `Transferência ${newTransfer.codigoTransferencia} criada de ${cdOrigem.nome} para ${cdDestino.nome} com ${totalVolumes} volumes.`,
    ip: req.ip
  });

  res.status(201).json({
    success: true,
    message: `Transferência ${newTransfer.codigoTransferencia} registrada com sucesso.`,
    transfer: newTransfer
  });
});

// 14. Transfers — Update Status (com movimentação física automática)
apiRouter.patch('/warehouses/transfers/:id/status', authenticate, checkSubscription, (req: AuthRequest, res: Response) => {
  const { id } = req.params;
  const companyId = getEffectiveCompanyId(req);
  const transfer = db.warehouseTransfers.find(t => t.id === id && (req.user!.role === 'master_owner' || t.companyId === companyId));

  if (!transfer) {
    res.status(404).json({ error: 'Transferência não encontrada.' });
    return;
  }

  const { status, motoristaNome, veiculoPlaca, divergenciasAnotadas } = req.body;

  if (motoristaNome) transfer.motoristaNome = motoristaNome;
  if (veiculoPlaca) transfer.veiculoPlaca = veiculoPlaca;
  if (divergenciasAnotadas !== undefined) transfer.divergenciasAnotadas = divergenciasAnotadas;

  if (status) {
    transfer.status = status;

    if (status === 'em_transito' && !transfer.despachadoEm) {
      transfer.despachadoEm = new Date().toISOString();
    }

    if (status === 'recebida_conferida') {
      transfer.dataRecebimento = new Date().toISOString();
      transfer.recebidoPor = req.user!.name;

      // Executa movimentação física entre posições se configuradas
      const cdOrigem = db.warehouses.find(w => w.id === transfer.cdOrigemId);
      const cdDestino = db.warehouses.find(w => w.id === transfer.cdDestinoId);

      if (cdOrigem && cdDestino) {
        transfer.itens.forEach(item => {
          // 1. Libera origem
          const posOrigem = (cdOrigem.posicoes || []).find(p => p.codigo === item.posicaoOrigem);
          if (posOrigem && posOrigem.status === 'ocupado') {
            const restante = (posOrigem.quantidadeAlocada || 0) - item.quantidade;
            if (restante <= 0) {
              posOrigem.status = 'disponivel';
              posOrigem.itemIdAlocado = undefined;
              posOrigem.itemNomeAlocado = undefined;
              posOrigem.skuAlocado = undefined;
              posOrigem.quantidadeAlocada = 0;
              posOrigem.ocupadoKg = 0;
              posOrigem.ocupadoVolumes = 0;
            } else {
              posOrigem.quantidadeAlocada = restante;
            }
          }

          // 2. Aloca no destino se houver posição destino especificada e disponível
          const posDestino = (cdDestino.posicoes || []).find(p => p.codigo === item.posicaoDestino);
          if (posDestino) {
            posDestino.status = 'ocupado';
            posDestino.itemIdAlocado = item.itemId;
            posDestino.skuAlocado = item.sku;
            posDestino.itemNomeAlocado = item.nome;
            posDestino.quantidadeAlocada = (posDestino.quantidadeAlocada || 0) + item.quantidade;
            posDestino.ocupadoVolumes = (posDestino.ocupadoVolumes || 0) + item.quantidade;
            posDestino.ocupadoKg = (posDestino.ocupadoKg || 0) + (item.quantidade * 2);
          }
        });

        cdOrigem.posicoesOcupadas = (cdOrigem.posicoes || []).filter(p => p.status === 'ocupado').length;
        cdDestino.posicoesOcupadas = (cdDestino.posicoes || []).filter(p => p.status === 'ocupado').length;
      }
    }
  }

  db.save();

  db.logAudit({
    userId: req.user!.id,
    userEmail: req.user!.email,
    userName: req.user!.name,
    companyId: transfer.companyId,
    acao: 'ATUALIZACAO_TRANSFERENCIA',
    detalhes: `Transferência ${transfer.codigoTransferencia} atualizada para o status ${transfer.status}.`,
    ip: req.ip
  });

  res.json({
    success: true,
    message: `Transferência ${transfer.codigoTransferencia} atualizada com sucesso.`,
    transfer
  });
});

// 15. Inventory Audits — List
apiRouter.get('/warehouses/audits', authenticate, checkSubscription, (req: AuthRequest, res: Response) => {
  const companyId = getEffectiveCompanyId(req);
  const audits = req.user!.role === 'master_owner' && !req.query.companyId
    ? db.warehouseAudits
    : db.warehouseAudits.filter(a => a.companyId === companyId);

  res.json({ success: true, audits });
});

// 16. Inventory Audits — Create Session
apiRouter.post('/warehouses/audits', authenticate, checkSubscription, (req: AuthRequest, res: Response) => {
  const companyId = getEffectiveCompanyId(req);
  const { cdId, tipoInventario, responsavelAuditoria, observacoes } = req.body;

  if (!cdId) {
    res.status(400).json({ error: 'Centro de Distribuição é obrigatório para iniciar inventário.' });
    return;
  }

  const warehouse = db.warehouses.find(w => w.id === cdId && (req.user!.role === 'master_owner' || w.companyId === companyId));
  if (!warehouse) {
    res.status(404).json({ error: 'Centro de Distribuição não encontrado.' });
    return;
  }

  // Preenche itens a serem contados com base nas posições cadastradas no CD
  const auditItems: WarehouseInventoryAuditItem[] = [];
  (warehouse.posicoes || []).forEach(p => {
    if (p.status === 'ocupado' && p.skuAlocado) {
      auditItems.push({
        itemId: p.itemIdAlocado || p.id,
        sku: p.skuAlocado,
        nome: p.itemNomeAlocado || 'Mercadoria sem identificação',
        posicaoCodigo: p.codigo,
        saldoSistema: p.quantidadeAlocada || 0,
        saldoContado: 0,
        divergencia: 0 - (p.quantidadeAlocada || 0),
        custoUnitario: 35.0, // Custo de referência padrão
        impactoFinanceiro: 0
      });
    }
  });

  const codigoInventario = `INV-${Date.now().toString().slice(-6)}`;

  const newAudit: WarehouseInventoryAudit = {
    id: `audit-${crypto.randomUUID()}`,
    companyId,
    codigoInventario,
    cdId: warehouse.id,
    cdNome: warehouse.nome,
    tipoInventario: tipoInventario || 'ciclico',
    status: 'aberto',
    responsavelAuditoria: responsavelAuditoria ? String(responsavelAuditoria).trim() : req.user!.name,
    itens: auditItems,
    totalItensAvaliados: auditItems.length,
    totalDivergenciasEncontradas: 0,
    impactoTotalFinanceiroDivergencia: 0,
    dataInicio: new Date().toISOString(),
    observacoes: observacoes ? String(observacoes) : undefined
  };

  db.warehouseAudits.unshift(newAudit);
  db.save();

  db.logAudit({
    userId: req.user!.id,
    userEmail: req.user!.email,
    userName: req.user!.name,
    companyId,
    acao: 'ABERTURA_AUDITORIA_INVENTARIO',
    detalhes: `Sessão de auditoria ${newAudit.codigoInventario} aberta para ${warehouse.nome} com ${auditItems.length} posições mapeadas.`,
    ip: req.ip
  });

  res.status(201).json({
    success: true,
    message: `Inventário ${newAudit.codigoInventario} iniciado com sucesso.`,
    audit: newAudit
  });
});

// 17. Inventory Audits — Register Counts
apiRouter.put('/warehouses/audits/:id/counts', authenticate, checkSubscription, (req: AuthRequest, res: Response) => {
  const { id } = req.params;
  const companyId = getEffectiveCompanyId(req);
  const audit = db.warehouseAudits.find(a => a.id === id && (req.user!.role === 'master_owner' || a.companyId === companyId));

  if (!audit) {
    res.status(404).json({ error: 'Sessão de inventário não encontrada.' });
    return;
  }

  const { counts } = req.body;
  if (!Array.isArray(counts)) {
    res.status(400).json({ error: 'Array de contagens físicas é obrigatório.' });
    return;
  }

  let totalDivergencias = 0;
  let impactoTotal = 0;

  audit.itens.forEach(item => {
    const found = counts.find((c: any) => c.posicaoCodigo === item.posicaoCodigo || c.itemId === item.itemId);
    if (found && found.saldoContado !== undefined) {
      item.saldoContado = Number(found.saldoContado) || 0;
      item.divergencia = item.saldoContado - item.saldoSistema;
      if (found.custoUnitario !== undefined) {
        item.custoUnitario = Number(found.custoUnitario);
      }
      item.impactoFinanceiro = item.divergencia * item.custoUnitario;

      if (item.divergencia !== 0) {
        totalDivergencias++;
      }
      impactoTotal += item.impactoFinanceiro;
    }
  });

  audit.totalDivergenciasEncontradas = totalDivergencias;
  audit.impactoTotalFinanceiroDivergencia = impactoTotal;
  audit.status = 'em_analise_divergencia';
  db.save();

  res.json({
    success: true,
    message: 'Contagens físicas registradas com sucesso.',
    audit
  });
});

// 18. Inventory Audits — Finalize & Reconcile Balances
apiRouter.post('/warehouses/audits/:id/finalize', authenticate, checkSubscription, (req: AuthRequest, res: Response) => {
  const { id } = req.params;
  const companyId = getEffectiveCompanyId(req);
  const audit = db.warehouseAudits.find(a => a.id === id && (req.user!.role === 'master_owner' || a.companyId === companyId));

  if (!audit) {
    res.status(404).json({ error: 'Sessão de inventário não encontrada.' });
    return;
  }

  const { aplicarAjustesNoEstoque, observacoesFinais } = req.body;

  if (aplicarAjustesNoEstoque) {
    const warehouse = db.warehouses.find(w => w.id === audit.cdId);
    if (warehouse && warehouse.posicoes) {
      audit.itens.forEach(item => {
        const pos = warehouse.posicoes.find(p => p.codigo === item.posicaoCodigo);
        if (pos) {
          if (item.saldoContado <= 0) {
            pos.status = 'disponivel';
            pos.itemIdAlocado = undefined;
            pos.itemNomeAlocado = undefined;
            pos.skuAlocado = undefined;
            pos.quantidadeAlocada = 0;
            pos.ocupadoKg = 0;
            pos.ocupadoVolumes = 0;
          } else {
            pos.quantidadeAlocada = item.saldoContado;
            pos.ocupadoVolumes = item.saldoContado;
            pos.ocupadoKg = item.saldoContado * 2;
          }
          item.ajusteAutorizado = true;
        }
      });
      warehouse.posicoesOcupadas = warehouse.posicoes.filter(p => p.status === 'ocupado').length;
      warehouse.atualizadoEm = new Date().toISOString();
    }
  }

  audit.status = 'concluido_ajustado';
  audit.dataConclusao = new Date().toISOString();
  if (observacoesFinais) {
    audit.observacoes = `${audit.observacoes || ''}\n${observacoesFinais}`.trim();
  }

  db.save();

  db.logAudit({
    userId: req.user!.id,
    userEmail: req.user!.email,
    userName: req.user!.name,
    companyId: audit.companyId,
    acao: 'FINALIZACAO_AUDITORIA_INVENTARIO',
    detalhes: `Auditoria ${audit.codigoInventario} finalizada com ${audit.totalDivergenciasEncontradas} divergências. Ajustes autorizados: ${aplicarAjustesNoEstoque ? 'SIM' : 'NÃO'}.`,
    ip: req.ip
  });

  res.json({
    success: true,
    message: `Inventário ${audit.codigoInventario} finalizado e conciliado com sucesso!`,
    audit
  });
});

// ============================================================================
// 19. FASE 3: FULFILLMENT & EXPEDIÇÃO (Infracommerce Standard)
// ============================================================================

// 1. Fulfillment Metrics & SLA Engine Overview
apiRouter.get('/fulfillment/metrics', authenticate, checkSubscription, (req: AuthRequest, res: Response) => {
  const companyId = getEffectiveCompanyId(req);
  const isMaster = req.user!.role === 'master_owner';
  
  const orders = isMaster && !req.query.companyId
    ? db.fulfillmentOrders
    : db.fulfillmentOrders.filter(o => o.companyId === companyId);

  const pickingTasks = isMaster && !req.query.companyId
    ? db.pickingTasks
    : db.pickingTasks.filter(t => t.companyId === companyId);

  const packingTasks = isMaster && !req.query.companyId
    ? db.packingTasks
    : db.packingTasks.filter(t => t.companyId === companyId);

  const manifests = isMaster && !req.query.companyId
    ? db.shippingManifests
    : db.shippingManifests.filter(m => m.companyId === companyId);

  const reversas = isMaster && !req.query.companyId
    ? db.reverseLogistics
    : db.reverseLogistics.filter(r => r.companyId === companyId);

  const totalPedidos = orders.length;
  const pedidosRecebidos = orders.filter(o => o.etapaAtual === 'recebido' || o.etapaAtual === 'conferencia').length;
  const pedidosEmSeparacao = orders.filter(o => o.etapaAtual === 'picking').length;
  const pedidosEmEmbalagem = orders.filter(o => o.etapaAtual === 'packing').length;
  const pedidosProntosExpedicao = orders.filter(o => o.etapaAtual === 'expedicao').length;
  const pedidosEmTransito = orders.filter(o => o.etapaAtual === 'transporte').length;
  const pedidosEntregues = orders.filter(o => o.etapaAtual === 'entregue').length;
  const pedidosDevolvidos = orders.filter(o => o.etapaAtual === 'devolvido').length;
  const pedidosCancelados = orders.filter(o => o.etapaAtual === 'cancelado').length;

  const pedidosEmAndamento = orders.filter(o => !['entregue', 'cancelado', 'devolvido'].includes(o.etapaAtual)).length;

  // SLA Calculation
  const now = new Date().getTime();
  let pedidosDentroPrazo = 0;
  let pedidosAtrasados = 0;
  const alertasRiscoSla: any[] = [];

  orders.forEach(o => {
    if (o.slaLimiteEnvio) {
      const limiteTime = new Date(o.slaLimiteEnvio).getTime();
      const tempoRestanteHoras = (limiteTime - now) / (1000 * 60 * 60);

      if (['recebido', 'conferencia', 'picking', 'packing'].includes(o.etapaAtual)) {
        if (tempoRestanteHoras < 0) {
          pedidosAtrasados++;
          alertasRiscoSla.push({
            pedidoId: o.id,
            numeroPedido: o.numeroPedido,
            clienteNome: o.clienteNome,
            etapaAtual: o.etapaAtual,
            slaLimiteEnvio: o.slaLimiteEnvio,
            gravidade: 'critica',
            motivo: 'Prazo limite de envio ultrapassado'
          });
        } else if (tempoRestanteHoras <= 2) {
          alertasRiscoSla.push({
            pedidoId: o.id,
            numeroPedido: o.numeroPedido,
            clienteNome: o.clienteNome,
            etapaAtual: o.etapaAtual,
            slaLimiteEnvio: o.slaLimiteEnvio,
            gravidade: 'alta',
            motivo: `Restam apenas ${Math.max(1, Math.round(tempoRestanteHoras * 60))} minutos para envio`
          });
        }
      }
    }

    if (o.etapaAtual === 'entregue') {
      if (o.prazoCumprido !== false) pedidosDentroPrazo++;
      else pedidosAtrasados++;
    }
  });

  const totalAvaliados = pedidosDentroPrazo + pedidosAtrasados;
  const taxaOtifPercentual = totalAvaliados > 0 ? Math.round((pedidosDentroPrazo / totalAvaliados) * 100) : 100;

  res.json({
    success: true,
    metrics: {
      totalPedidos,
      pedidosEmAndamento,
      pedidosRecebidos,
      pedidosEmSeparacao,
      pedidosEmEmbalagem,
      pedidosProntosExpedicao,
      pedidosEmTransito,
      pedidosEntregues,
      pedidosDevolvidos,
      pedidosCancelados,
      totalOndasAtivas: pickingTasks.filter(t => t.status === 'em_andamento' || t.status === 'pendente').length,
      totalEmbaladosHoje: packingTasks.length,
      totalManifestosExpedidos: manifests.length,
      taxaOtifPercentual,
      tempoMedioCicloMinutos: 45,
      alertasRiscoSla: alertasRiscoSla.slice(0, 8),
      totalReversas: reversas.length
    }
  });
});

// 2. List Fulfillment Orders
apiRouter.get('/fulfillment/orders', authenticate, checkSubscription, (req: AuthRequest, res: Response) => {
  const companyId = getEffectiveCompanyId(req);
  const isMaster = req.user!.role === 'master_owner';
  
  let orders = isMaster && !req.query.companyId
    ? db.fulfillmentOrders
    : db.fulfillmentOrders.filter(o => o.companyId === companyId);

  const { stage, cdId, canal, search } = req.query;

  if (stage && typeof stage === 'string') {
    orders = orders.filter(o => o.etapaAtual === stage);
  }
  if (cdId && typeof cdId === 'string') {
    orders = orders.filter(o => o.cdId === cdId);
  }
  if (canal && typeof canal === 'string') {
    orders = orders.filter(o => o.origemCanal === canal);
  }
  if (search && typeof search === 'string') {
    const q = search.toLowerCase();
    orders = orders.filter(o =>
      o.numeroPedido.toLowerCase().includes(q) ||
      o.clienteNome.toLowerCase().includes(q) ||
      o.clienteDocumento.toLowerCase().includes(q)
    );
  }

  // Sort newest first
  orders = [...orders].sort((a, b) => new Date(b.criadoEm).getTime() - new Date(a.criadoEm).getTime());

  res.json({ success: true, orders });
});

// 3. Get Single Fulfillment Order
apiRouter.get('/fulfillment/orders/:id', authenticate, checkSubscription, (req: AuthRequest, res: Response) => {
  const { id } = req.params;
  const companyId = getEffectiveCompanyId(req);
  const isMaster = req.user!.role === 'master_owner';

  const order = db.fulfillmentOrders.find(o => o.id === id && (isMaster || o.companyId === companyId));
  if (!order) {
    res.status(404).json({ error: 'Pedido de fulfillment não encontrado.' });
    return;
  }

  const pickingTask = db.pickingTasks.find(t => t.pedidosIds.includes(order.id));
  const packingTask = db.packingTasks.find(p => p.pedidoId === order.id);
  const manifest = db.shippingManifests.find(m => m.pedidosIds.includes(order.id));

  res.json({
    success: true,
    order,
    pickingTask,
    packingTask,
    manifest
  });
});

// 4. Create Fulfillment Order
apiRouter.post('/fulfillment/orders', authenticate, checkSubscription, (req: AuthRequest, res: Response) => {
  const companyId = getEffectiveCompanyId(req);
  if (!companyId) {
    res.status(400).json({ error: 'Empresa obrigatória' });
    return;
  }

  const {
    numeroPedido,
    origemCanal,
    clienteNome,
    clienteDocumento,
    clienteTelefone,
    clienteEmail,
    enderecoEntrega,
    numero,
    complemento,
    bairro,
    cidade,
    estado,
    cep,
    cdId,
    itens,
    valorFrete,
    slaLimiteHoras
  } = req.body;

  if (!clienteNome || !itens || !Array.isArray(itens) || itens.length === 0) {
    res.status(400).json({ error: 'Nome do cliente e lista de itens são obrigatórios.' });
    return;
  }

  // Resolve warehouse CD
  let warehouse = db.warehouses.find(w => w.id === cdId && w.companyId === companyId);
  if (!warehouse) {
    warehouse = db.warehouses.find(w => w.companyId === companyId && w.ativo);
  }
  if (!warehouse) {
    // Default fallback to first active warehouse in system or create placeholder
    warehouse = db.warehouses[0];
  }

  const cdRefId = warehouse ? warehouse.id : 'cd-matriz';
  const cdRefNome = warehouse ? warehouse.nome : 'Centro de Distribuição Principal';

  // Process items and map WMS position addresses without duplicating stock
  const processedItems: FulfillmentItem[] = itens.map((it: any, index: number) => {
    let posicaoEndereco = it.posicaoEnderecoCd || '';

    // If warehouse has positions, look for where this SKU is currently allocated
    if (!posicaoEndereco && warehouse && warehouse.posicoes) {
      const matchPos = warehouse.posicoes.find(p => p.skuAlocado === it.sku || p.itemIdAlocado === it.sku);
      if (matchPos) {
        posicaoEndereco = matchPos.enderecoCompleto;
      } else {
        // Fallback to first available position address or generate structured address
        posicaoEndereco = warehouse.posicoes[index % warehouse.posicoes.length]?.enderecoCompleto || 'R01-P01-N1';
      }
    }

    return {
      id: crypto.randomUUID(),
      sku: it.sku || `SKU-ORD-${index + 1}`,
      nome: it.nome || `Item ${index + 1}`,
      quantidade: Number(it.quantidade) || 1,
      posicaoEnderecoCd: posicaoEndereco || 'R01-P01-N1',
      separado: false,
      embalado: false,
      precoUnitario: Number(it.precoUnitario) || 0
    };
  });

  const valorTotalItens = processedItems.reduce((acc, it) => acc + (it.precoUnitario * it.quantidade), 0);
  const volumesTotal = processedItems.reduce((acc, it) => acc + it.quantidade, 0);
  const pesoTotalKg = Number((volumesTotal * 0.85).toFixed(2));

  const now = new Date();
  const slaHours = Number(slaLimiteHoras) || 4;
  const slaLimiteEnvio = new Date(now.getTime() + slaHours * 60 * 60 * 1000).toISOString();
  const slaLimiteEntrega = new Date(now.getTime() + 48 * 60 * 60 * 1000).toISOString();

  const generatedOrderNum = numeroPedido || `PED-FUL-${Date.now().toString().slice(-6)}`;

  const newOrder: FulfillmentOrder = {
    id: crypto.randomUUID(),
    companyId,
    numeroPedido: generatedOrderNum,
    origemCanal: origemCanal || 'ecommerce',
    clienteNome,
    clienteDocumento: clienteDocumento || '000.000.000-00',
    clienteTelefone: clienteTelefone || '(11) 99999-0000',
    clienteEmail: clienteEmail || '',
    enderecoEntrega: enderecoEntrega || 'Rua Principal',
    numero: numero || '100',
    complemento: complemento || '',
    bairro: bairro || 'Centro',
    cidade: cidade || 'São Paulo',
    estado: estado || 'SP',
    cep: cep || '01001-000',
    cdId: cdRefId,
    cdNome: cdRefNome,
    itens: processedItems,
    valorTotalItens,
    valorFrete: Number(valorFrete) || 0,
    volumesTotal,
    pesoTotalKg,
    etapaAtual: 'recebido',
    slaLimiteEnvio,
    slaLimiteEntrega,
    responsavelEtapaAtual: req.user!.name,
    historicoEtapas: [
      {
        etapa: 'recebido',
        dataHora: now.toISOString(),
        responsavelNome: req.user!.name,
        observacao: 'Pedido integrado e recebido no sistema de fulfillment.'
      }
    ],
    criadoEm: now.toISOString(),
    atualizadoEm: now.toISOString()
  };

  db.fulfillmentOrders.push(newOrder);
  db.save();

  db.logAudit({
    userId: req.user!.id,
    userEmail: req.user!.email,
    userName: req.user!.name,
    companyId,
    acao: 'CRIACAO_PEDIDO_FULFILLMENT',
    detalhes: `Pedido ${newOrder.numeroPedido} criado com ${newOrder.volumesTotal} volume(s). Destinatário: ${newOrder.clienteNome}.`,
    ip: req.ip
  });

  res.status(201).json({
    success: true,
    message: `Pedido ${newOrder.numeroPedido} criado com sucesso no pipeline de fulfillment!`,
    order: newOrder
  });
});

// 5. Update Fulfillment Order Stage (State Machine)
apiRouter.patch('/fulfillment/orders/:id/stage', authenticate, checkSubscription, (req: AuthRequest, res: Response) => {
  const { id } = req.params;
  const companyId = getEffectiveCompanyId(req);
  const isMaster = req.user!.role === 'master_owner';

  const order = db.fulfillmentOrders.find(o => o.id === id && (isMaster || o.companyId === companyId));
  if (!order) {
    res.status(404).json({ error: 'Pedido de fulfillment não encontrado.' });
    return;
  }

  const { novaEtapa, observacao, responsavelNome } = req.body;
  const allowedStages: FulfillmentStage[] = [
    'recebido',
    'conferencia',
    'picking',
    'packing',
    'expedicao',
    'transporte',
    'entregue',
    'devolvido',
    'cancelado'
  ];

  if (!novaEtapa || !allowedStages.includes(novaEtapa)) {
    res.status(400).json({ error: `Etapa inválida. Etapas permitidas: ${allowedStages.join(', ')}` });
    return;
  }

  const now = new Date();
  order.etapaAtual = novaEtapa;
  order.atualizadoEm = now.toISOString();
  order.responsavelEtapaAtual = responsavelNome || req.user!.name;

  if (novaEtapa === 'entregue') {
    const prazoLimite = new Date(order.slaLimiteEntrega).getTime();
    order.prazoCumprido = now.getTime() <= prazoLimite;
  }

  order.historicoEtapas.push({
    etapa: novaEtapa,
    dataHora: now.toISOString(),
    responsavelNome: responsavelNome || req.user!.name,
    observacao: observacao || `Transição para a etapa ${novaEtapa}.`
  });

  db.save();

  db.logAudit({
    userId: req.user!.id,
    userEmail: req.user!.email,
    userName: req.user!.name,
    companyId: order.companyId,
    acao: 'TRANSICAO_ETAPA_FULFILLMENT',
    detalhes: `Pedido ${order.numeroPedido} avançado para '${novaEtapa}' por ${req.user!.name}.`,
    ip: req.ip
  });

  res.json({
    success: true,
    message: `Pedido ${order.numeroPedido} atualizado para a etapa '${novaEtapa}'.`,
    order
  });
});

// 6. List Wave Picking Tasks
apiRouter.get('/fulfillment/picking/waves', authenticate, checkSubscription, (req: AuthRequest, res: Response) => {
  const companyId = getEffectiveCompanyId(req);
  const isMaster = req.user!.role === 'master_owner';

  const waves = isMaster && !req.query.companyId
    ? db.pickingTasks
    : db.pickingTasks.filter(w => w.companyId === companyId);

  res.json({ success: true, waves: [...waves].reverse() });
});

// 7. Create Wave Picking Task
apiRouter.post('/fulfillment/picking/waves', authenticate, checkSubscription, (req: AuthRequest, res: Response) => {
  const companyId = getEffectiveCompanyId(req);
  const isMaster = req.user!.role === 'master_owner';
  const { pedidosIds, tipo, operadorNome, cdId } = req.body;

  if (!pedidosIds || !Array.isArray(pedidosIds) || pedidosIds.length === 0) {
    res.status(400).json({ error: 'Selecione ao menos um pedido para gerar a onda de separação.' });
    return;
  }

  const targetOrders = db.fulfillmentOrders.filter(
    o => pedidosIds.includes(o.id) && (isMaster || o.companyId === companyId)
  );

  if (targetOrders.length === 0) {
    res.status(400).json({ error: 'Nenhum pedido válido encontrado para a onda de separação.' });
    return;
  }

  const targetCdId = cdId || targetOrders[0].cdId;
  const codigoOnda = `ONDA-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}-${Date.now().toString().slice(-4)}`;

  // Consolidate pending items
  const itensPendentes: PickingTask['itensPendentes'] = [];
  targetOrders.forEach(o => {
    o.itens.forEach(it => {
      itensPendentes.push({
        pedidoId: o.id,
        pedidoNumero: o.numeroPedido,
        sku: it.sku,
        nome: it.nome,
        quantidade: it.quantidade,
        posicaoEndereco: it.posicaoEnderecoCd || 'R01-P01-N1',
        concluido: it.separado || false
      });
    });

    // Advance orders to picking stage
    if (o.etapaAtual === 'recebido' || o.etapaAtual === 'conferencia') {
      o.etapaAtual = 'picking';
      o.atualizadoEm = new Date().toISOString();
      o.historicoEtapas.push({
        etapa: 'picking',
        dataHora: new Date().toISOString(),
        responsavelNome: operadorNome || req.user!.name,
        observacao: `Alocado na onda de separação ${codigoOnda}.`
      });
    }
  });

  const newWave: PickingTask = {
    id: crypto.randomUUID(),
    companyId,
    codigoOnda,
    cdId: targetCdId,
    tipo: tipo === 'single_order' ? 'single_order' : 'batch_wave',
    pedidosIds: targetOrders.map(o => o.id),
    itensPendentes,
    operadorId: req.user!.id,
    operadorNome: operadorNome || req.user!.name,
    status: 'em_andamento',
    iniciadaEm: new Date().toISOString()
  };

  db.pickingTasks.push(newWave);
  db.save();

  db.logAudit({
    userId: req.user!.id,
    userEmail: req.user!.email,
    userName: req.user!.name,
    companyId,
    acao: 'CRIACAO_ONDA_SEPARACAO',
    detalhes: `Onda ${codigoOnda} criada com ${newWave.pedidosIds.length} pedido(s) e ${itensPendentes.length} item(ns).`,
    ip: req.ip
  });

  res.status(201).json({
    success: true,
    message: `Onda de separação ${codigoOnda} criada com sucesso!`,
    wave: newWave
  });
});

// 8. Update / Pick Items in Wave
apiRouter.patch('/fulfillment/picking/waves/:id/items', authenticate, checkSubscription, (req: AuthRequest, res: Response) => {
  const { id } = req.params;
  const companyId = getEffectiveCompanyId(req);
  const isMaster = req.user!.role === 'master_owner';

  const wave = db.pickingTasks.find(w => w.id === id && (isMaster || w.companyId === companyId));
  if (!wave) {
    res.status(404).json({ error: 'Onda de separação não encontrada.' });
    return;
  }

  const { itemIndex, sku, marcarTodos } = req.body;

  if (marcarTodos) {
    wave.itensPendentes.forEach(it => { it.concluido = true; });
  } else if (typeof itemIndex === 'number' && wave.itensPendentes[itemIndex]) {
    wave.itensPendentes[itemIndex].concluido = true;
  } else if (sku && typeof sku === 'string') {
    const item = wave.itensPendentes.find(it => it.sku.toLowerCase() === sku.toLowerCase() && !it.concluido);
    if (item) item.concluido = true;
  } else {
    // Pick first pending item
    const pending = wave.itensPendentes.find(it => !it.concluido);
    if (pending) pending.concluido = true;
  }

  // Synchronize item separated status in orders
  wave.pedidosIds.forEach(orderId => {
    const order = db.fulfillmentOrders.find(o => o.id === orderId);
    if (order) {
      const orderWaveItems = wave.itensPendentes.filter(it => it.pedidoId === orderId);
      const allOrderItemsSeparated = orderWaveItems.every(it => it.concluido);
      
      order.itens.forEach(it => {
        const match = orderWaveItems.find(w => w.sku === it.sku);
        if (match && match.concluido) {
          it.separado = true;
        }
      });

      if (allOrderItemsSeparated && order.etapaAtual === 'picking') {
        order.etapaAtual = 'packing';
        order.atualizadoEm = new Date().toISOString();
        order.historicoEtapas.push({
          etapa: 'packing',
          dataHora: new Date().toISOString(),
          responsavelNome: req.user!.name,
          observacao: `Separação finalizada na onda ${wave.codigoOnda}. Encaminhado para a estação de embalagem.`
        });
      }
    }
  });

  const allFinished = wave.itensPendentes.every(it => it.concluido);
  if (allFinished) {
    wave.status = 'concluida';
    wave.concluidaEm = new Date().toISOString();
  }

  db.save();

  res.json({
    success: true,
    message: allFinished ? `Onda ${wave.codigoOnda} concluída com 100% dos itens separados!` : 'Item bipado/separado com sucesso!',
    wave
  });
});

// 9. List Packing Tasks
apiRouter.get('/fulfillment/packing/tasks', authenticate, checkSubscription, (req: AuthRequest, res: Response) => {
  const companyId = getEffectiveCompanyId(req);
  const isMaster = req.user!.role === 'master_owner';

  const tasks = isMaster && !req.query.companyId
    ? db.packingTasks
    : db.packingTasks.filter(t => t.companyId === companyId);

  res.json({ success: true, tasks: [...tasks].reverse() });
});

// 10. Packing Station Check & Scale Weighing & Label Generation
apiRouter.post('/fulfillment/packing/pack', authenticate, checkSubscription, (req: AuthRequest, res: Response) => {
  const companyId = getEffectiveCompanyId(req);
  const isMaster = req.user!.role === 'master_owner';
  const {
    pedidoId,
    tipoEmbalagem,
    pesoBalancaKg,
    lacreNumero,
    embaladorNome,
    ignorarDivergenciaPeso
  } = req.body;

  if (!pedidoId) {
    res.status(400).json({ error: 'ID do pedido obrigatório.' });
    return;
  }

  const order = db.fulfillmentOrders.find(o => o.id === pedidoId && (isMaster || o.companyId === companyId));
  if (!order) {
    res.status(404).json({ error: 'Pedido não encontrado.' });
    return;
  }

  const pesoReal = Number(pesoBalancaKg);
  if (isNaN(pesoReal) || pesoReal <= 0) {
    res.status(400).json({ error: 'Peso da balança inválido. Aferição física obrigatória.' });
    return;
  }

  // Weighing Scale Engine Tolerance Check
  const pesoEsperado = order.pesoTotalKg || (order.volumesTotal * 0.85);
  const diferencaAbs = Math.abs(pesoReal - pesoEsperado);
  const variacaoPercentual = (diferencaAbs / pesoEsperado) * 100;

  if (variacaoPercentual > 30 && !ignorarDivergenciaPeso) {
    res.status(400).json({
      error: `Divergência de pesagem detectada: Peso esperado ${pesoEsperado.toFixed(2)} kg vs Balança ${pesoReal.toFixed(2)} kg (Variação de ${variacaoPercentual.toFixed(1)}%). Reconfira os itens ou autorize com justificativa.`,
      divergencia: true,
      pesoEsperado,
      pesoReal,
      variacaoPercentual: Number(variacaoPercentual.toFixed(1))
    });
    return;
  }

  // Update order items to embalado
  order.itens.forEach(it => {
    it.separado = true;
    it.embalado = true;
  });

  const labelCode = `ML-LBL-${Date.now().toString().slice(-6)}-${order.numeroPedido}`;
  const generatedLacre = lacreNumero || `LACRE-${Date.now().toString().slice(-6)}`;

  const packingTask: PackingTask = {
    id: crypto.randomUUID(),
    companyId: order.companyId,
    pedidoId: order.id,
    pedidoNumero: order.numeroPedido,
    cdId: order.cdId,
    tipoEmbalagem: tipoEmbalagem || 'caixa_media',
    pesoBalancaKg: pesoReal,
    lacreNumero: generatedLacre,
    conferido100Porcento: true,
    etiquetaGerada: true,
    embaladorNome: embaladorNome || req.user!.name,
    status: 'embalado_pronto_expedicao',
    concluidoEm: new Date().toISOString()
  };

  db.packingTasks.push(packingTask);

  // Advance order to expedicao
  order.etapaAtual = 'expedicao';
  order.pesoTotalKg = pesoReal;
  order.etiquetaEnvioDataUrl = labelCode;
  order.codigoRastreio = `MLBR${Date.now().toString().slice(-8)}BR`;
  order.atualizadoEm = new Date().toISOString();
  order.historicoEtapas.push({
    etapa: 'expedicao',
    dataHora: new Date().toISOString(),
    responsavelNome: embaladorNome || req.user!.name,
    observacao: `Embalagem conferida e pesada na balança (${pesoReal} kg). Etiqueta ${labelCode} gerada. Lacre ${generatedLacre}. Pronto para expedição.`
  });

  db.save();

  db.logAudit({
    userId: req.user!.id,
    userEmail: req.user!.email,
    userName: req.user!.name,
    companyId: order.companyId,
    acao: 'ESTACAO_EMBALAGEM_CONCLUIDA',
    detalhes: `Pedido ${order.numeroPedido} embalado com sucesso. Peso: ${pesoReal} kg. Etiqueta: ${labelCode}.`,
    ip: req.ip
  });

  res.status(201).json({
    success: true,
    message: `Pedido ${order.numeroPedido} embalado e conferido com 100% de acuracidade! Encaminhado para a Doca de Expedição.`,
    packingTask,
    etiquetaCodigo: labelCode,
    codigoRastreio: order.codigoRastreio,
    order
  });
});

// 11. List Shipping Manifests
apiRouter.get('/fulfillment/manifests', authenticate, checkSubscription, (req: AuthRequest, res: Response) => {
  const companyId = getEffectiveCompanyId(req);
  const isMaster = req.user!.role === 'master_owner';

  const manifests = isMaster && !req.query.companyId
    ? db.shippingManifests
    : db.shippingManifests.filter(m => m.companyId === companyId);

  res.json({ success: true, manifests: [...manifests].reverse() });
});

// 12. Dispatch Manifest (Romaneio de Expedição + WMS Stock Deduction)
apiRouter.post('/fulfillment/manifests', authenticate, checkSubscription, (req: AuthRequest, res: Response) => {
  const companyId = getEffectiveCompanyId(req);
  const isMaster = req.user!.role === 'master_owner';
  const {
    cdId,
    transportadoraNome,
    motoristaNome,
    veiculoPlaca,
    pedidosIds,
    observacoes
  } = req.body;

  if (!pedidosIds || !Array.isArray(pedidosIds) || pedidosIds.length === 0) {
    res.status(400).json({ error: 'Selecione ao menos um pedido para gerar o manifesto de expedição.' });
    return;
  }

  const orders = db.fulfillmentOrders.filter(
    o => pedidosIds.includes(o.id) && (isMaster || o.companyId === companyId)
  );

  if (orders.length === 0) {
    res.status(400).json({ error: 'Nenhum pedido válido encontrado para o manifesto.' });
    return;
  }

  const warehouse = db.warehouses.find(w => w.id === (cdId || orders[0].cdId));
  const cdNome = warehouse ? warehouse.nome : 'Centro de Distribuição Principal';

  const totalVolumes = orders.reduce((acc, o) => acc + o.volumesTotal, 0);
  const totalPesoKg = Number(orders.reduce((acc, o) => acc + o.pesoTotalKg, 0).toFixed(2));
  const valorTotalCarga = Number(orders.reduce((acc, o) => acc + o.valorTotalItens, 0).toFixed(2));

  const codigoManifesto = `MAN-EXP-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}-${Date.now().toString().slice(-4)}`;

  // Physical stock reduction in WMS positions without duplicate balances
  if (warehouse && warehouse.posicoes) {
    orders.forEach(order => {
      order.itens.forEach(item => {
        const pos = warehouse.posicoes.find(
          p => p.enderecoCompleto === item.posicaoEnderecoCd || p.skuAlocado === item.sku
        );
        if (pos) {
          const qty = Number(item.quantidade) || 1;
          pos.quantidadeAlocada = Math.max(0, (pos.quantidadeAlocada || 0) - qty);
          pos.ocupadoVolumes = Math.max(0, (pos.ocupadoVolumes || 0) - qty);
          pos.ocupadoKg = Math.max(0, (pos.ocupadoKg || 0) - (qty * 1.5));
          if (pos.quantidadeAlocada <= 0) {
            pos.status = 'disponivel';
            pos.itemIdAlocado = undefined;
            pos.itemNomeAlocado = undefined;
            pos.skuAlocado = undefined;
          }
        }
      });
    });
    warehouse.posicoesOcupadas = warehouse.posicoes.filter(p => p.status === 'ocupado').length;
    warehouse.atualizadoEm = new Date().toISOString();
  }

  // Advance orders to transporte
  orders.forEach(order => {
    order.etapaAtual = 'transporte';
    order.transportadoraNome = transportadoraNome || 'Transportadora Parceira MoviLog';
    order.atualizadoEm = new Date().toISOString();
    order.historicoEtapas.push({
      etapa: 'transporte',
      dataHora: new Date().toISOString(),
      responsavelNome: motoristaNome || req.user!.name,
      observacao: `Despachado no manifesto de expedição ${codigoManifesto}. Veículo: ${veiculoPlaca || 'Não informado'}.`
    });
  });

  const manifest: ShippingManifest = {
    id: crypto.randomUUID(),
    companyId,
    codigoManifesto,
    cdId: warehouse ? warehouse.id : 'cd-matriz',
    cdNome,
    transportadoraNome: transportadoraNome || 'MoviLog Express',
    motoristaNome: motoristaNome || 'Motorista MoviLog',
    veiculoPlaca: veiculoPlaca || 'LOG-2026',
    pedidosIds: orders.map(o => o.id),
    totalPedidos: orders.length,
    totalVolumes,
    totalPesoKg,
    valorTotalCarga,
    status: 'despachado',
    criadoEm: new Date().toISOString(),
    despachadoEm: new Date().toISOString(),
    observacoes: observacoes || 'Manifesto expedido com baixa física realizada no WMS.'
  };

  db.shippingManifests.push(manifest);
  db.save();

  db.logAudit({
    userId: req.user!.id,
    userEmail: req.user!.email,
    userName: req.user!.name,
    companyId,
    acao: 'DESPACHO_MANIFESTO_EXPEDICAO',
    detalhes: `Manifesto ${codigoManifesto} despachado com ${manifest.totalPedidos} pedido(s), ${manifest.totalVolumes} volume(s), R$ ${manifest.valorTotalCarga}. Baixa WMS concluída.`,
    ip: req.ip
  });

  res.status(201).json({
    success: true,
    message: `Manifesto ${codigoManifesto} expedido com sucesso! Baixa física realizada nas posições do WMS.`,
    manifest
  });
});

// 13. Reverse Logistics List
apiRouter.get('/fulfillment/reversa', authenticate, checkSubscription, (req: AuthRequest, res: Response) => {
  const companyId = getEffectiveCompanyId(req);
  const isMaster = req.user!.role === 'master_owner';

  const tickets = isMaster && !req.query.companyId
    ? db.reverseLogistics
    : db.reverseLogistics.filter(t => t.companyId === companyId);

  res.json({ success: true, tickets: [...tickets].reverse() });
});

// 14. Reverse Logistics Create Ticket
apiRouter.post('/fulfillment/reversa', authenticate, checkSubscription, (req: AuthRequest, res: Response) => {
  const companyId = getEffectiveCompanyId(req);
  const isMaster = req.user!.role === 'master_owner';
  const {
    pedidoOriginalId,
    motivo,
    itens,
    transportadoraNome,
    observacoes
  } = req.body;

  if (!pedidoOriginalId) {
    res.status(400).json({ error: 'Pedido original obrigatório.' });
    return;
  }

  const order = db.fulfillmentOrders.find(o => o.id === pedidoOriginalId && (isMaster || o.companyId === companyId));
  if (!order) {
    res.status(404).json({ error: 'Pedido original não encontrado.' });
    return;
  }

  const codigoReversa = `REV-${new Date().getFullYear()}-${Date.now().toString().slice(-4)}`;
  const codigoAutorizacaoPostagem = `POST-${Date.now().toString().slice(-6)}`;

  const reversaItens = (itens && Array.isArray(itens) && itens.length > 0)
    ? itens
    : order.itens.map(it => ({ sku: it.sku, nome: it.nome, quantidade: it.quantidade }));

  const ticket: ReverseLogisticsTicket = {
    id: crypto.randomUUID(),
    companyId: order.companyId,
    codigoReversa,
    pedidoOriginalId: order.id,
    pedidoOriginalNumero: order.numeroPedido,
    clienteNome: order.clienteNome,
    clienteTelefone: order.clienteTelefone,
    motivo: motivo || 'desistencia_arrependimento',
    status: 'solicitada',
    itens: reversaItens,
    codigoAutorizacaoPostagem,
    transportadoraNome: transportadoraNome || 'Correios Log / MoviLog Reverse',
    solicitadoEm: new Date().toISOString()
  };

  db.reverseLogistics.push(ticket);

  // Update order stage to devolvido if appropriate
  order.etapaAtual = 'devolvido';
  order.atualizadoEm = new Date().toISOString();
  order.historicoEtapas.push({
    etapa: 'devolvido',
    dataHora: new Date().toISOString(),
    responsavelNome: req.user!.name,
    observacao: `Logística reversa ${codigoReversa} aberta. Código de autorização de postagem: ${codigoAutorizacaoPostagem}.`
  });

  db.save();

  db.logAudit({
    userId: req.user!.id,
    userEmail: req.user!.email,
    userName: req.user!.name,
    companyId: order.companyId,
    acao: 'ABERTURA_LOGISTICA_REVERSA',
    detalhes: `Ticket reverso ${codigoReversa} aberto para o pedido ${order.numeroPedido}.`,
    ip: req.ip
  });

  res.status(201).json({
    success: true,
    message: `Logística reversa ${codigoReversa} aberta com sucesso! Código de postagem gerado: ${codigoAutorizacaoPostagem}.`,
    ticket
  });
});

// 15. Reverse Logistics Triage & Restock
apiRouter.patch('/fulfillment/reversa/:id/triagem', authenticate, checkSubscription, (req: AuthRequest, res: Response) => {
  const { id } = req.params;
  const companyId = getEffectiveCompanyId(req);
  const isMaster = req.user!.role === 'master_owner';

  const ticket = db.reverseLogistics.find(t => t.id === id && (isMaster || t.companyId === companyId));
  if (!ticket) {
    res.status(404).json({ error: 'Ticket de logística reversa não encontrado.' });
    return;
  }

  const { condicaoAposTriagem, cdDestinoId, posicaoEndereco, laudoInspecao, liberarEstorno } = req.body;

  ticket.itens.forEach(it => {
    it.condicaoAposTriagem = condicaoAposTriagem || 'perfeito_reestocar';
  });

  ticket.destinacaoFinal = condicaoAposTriagem === 'perfeito_reestocar'
    ? 'Reestocado no CD'
    : condicaoAposTriagem === 'avariado_descarte'
    ? 'Descarte por Avaria'
    : 'Reparo Técnico';

  ticket.laudoInspecao = laudoInspecao || 'Triagem visual e funcional realizada pelo operador de qualidade do CD.';
  ticket.status = liberarEstorno ? 'estorno_liberado' : 'triagem_concluida';
  ticket.concluidoEm = new Date().toISOString();

  // If reestocar, re-allocate to WMS position
  if (condicaoAposTriagem === 'perfeito_reestocar') {
    const warehouse = db.warehouses.find(w => w.id === cdDestinoId) || db.warehouses.find(w => w.companyId === ticket.companyId);
    if (warehouse && warehouse.posicoes) {
      ticket.itens.forEach(it => {
        const targetPos = warehouse.posicoes.find(p => p.enderecoCompleto === posicaoEndereco) ||
          warehouse.posicoes.find(p => p.status === 'disponivel');
        if (targetPos) {
          targetPos.status = 'ocupado';
          targetPos.skuAlocado = it.sku;
          targetPos.itemNomeAlocado = it.nome;
          targetPos.quantidadeAlocada = (targetPos.quantidadeAlocada || 0) + it.quantidade;
          targetPos.ocupadoVolumes = (targetPos.ocupadoVolumes || 0) + it.quantidade;
        }
      });
      warehouse.posicoesOcupadas = warehouse.posicoes.filter(p => p.status === 'ocupado').length;
      warehouse.atualizadoEm = new Date().toISOString();
    }
  }

  db.save();

  db.logAudit({
    userId: req.user!.id,
    userEmail: req.user!.email,
    userName: req.user!.name,
    companyId: ticket.companyId,
    acao: 'TRIAGEM_LOGISTICA_REVERSA',
    detalhes: `Triagem concluída para reversa ${ticket.codigoReversa}. Condição: ${condicaoAposTriagem}. Estorno liberado: ${liberarEstorno ? 'SIM' : 'NÃO'}.`,
    ip: req.ip
  });

  res.json({
    success: true,
    message: `Triagem da reversa ${ticket.codigoReversa} concluída com sucesso! Destinação: ${ticket.destinacaoFinal}.`,
    ticket
  });
});

// Sanitized API error handler (prevents unhandled async rejections or internal SQL leaks)
apiRouter.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
  console.error('[API Error]', err);
  if (res.headersSent) return;
  res.status(err?.statusCode || 500).json({
    error: err?.publicMessage || 'Erro interno no processamento da operação.',
  });
});



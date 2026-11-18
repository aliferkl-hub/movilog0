import { relations } from 'drizzle-orm';
import {
  bigint,
  boolean,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';

// ============================================================================
// 1. CORE PLATFORM, AUTHENTICATION, SESSIONS & MULTI-TENANT TABLES
// ============================================================================

export const systemConfig = pgTable('system_config', {
  id: text('id').primaryKey(), // 'default'
  nomePlataforma: text('nome_plataforma').notNull(),
  whatsappComercial: text('whatsapp_comercial').notNull(),
  mensagemWhatsappPadrao: text('mensagem_whatsapp_padrao').notNull(),
  diasDemonstracao: integer('dias_demonstracao').notNull().default(7),
  masterEmail: text('master_email').notNull(),
  masterInitialized: boolean('master_initialized').notNull().default(false),
  modoManutencao: boolean('modo_manutencao').notNull().default(false),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
});

export const plans = pgTable('plans', {
  id: text('id').primaryKey(),
  nome: text('nome').notNull(),
  tipo: text('tipo').notNull(),
  descricao: text('descricao').notNull(),
  precoMensal: doublePrecision('preco_mensal').notNull().default(0),
  precoAnual: doublePrecision('preco_anual').notNull().default(0),
  duracaoDias: integer('duracao_dias').notNull().default(30),
  modulosPermitidos: jsonb('modulos_permitidos').$type<string[]>().notNull(),
  limites: jsonb('limites')
    .$type<{ maxUsuarios: number; maxUnidades: number; maxOperacoesMes: number }>()
    .notNull(),
  recursos: jsonb('recursos').$type<string[]>().notNull(),
  destaque: boolean('destaque').default(false),
  ativo: boolean('ativo').notNull().default(true),
});

export const companies = pgTable(
  'companies',
  {
    id: text('id').primaryKey(),
    razaoSocial: text('razao_social').notNull(),
    nomeFantasia: text('nome_fantasia').notNull(),
    cnpj: text('cnpj'),
    responsavel: text('responsavel').notNull(),
    email: text('email').notNull(),
    telefone: text('telefone').notNull(),
    endereco: text('endereco').notNull(),
    segmento: text('segmento').notNull(),
    quantidadeFuncionarios: integer('quantidade_funcionarios').notNull().default(1),
    tipoOperacao: text('tipo_operacao').notNull(),
    modulos: jsonb('modulos').$type<string[]>().notNull(),
    planoId: text('plano_id').notNull(),
    statusCadastro: text('status_cadastro').notNull(),
    statusAssinatura: text('status_assinatura').notNull(),
    demoStartDate: text('demo_start_date'),
    demoEndDate: text('demo_end_date'),
    subscriptionStartDate: text('subscription_start_date'),
    subscriptionEndDate: text('subscription_end_date'),
    limites: jsonb('limites')
      .$type<{ maxUsuarios: number; maxUnidades: number; maxOperacoesMes: number }>()
      .notNull(),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (table) => [
    index('companies_plano_idx').on(table.planoId),
    index('companies_status_assinatura_idx').on(table.statusAssinatura),
  ]
);

export const users = pgTable(
  'users',
  {
    id: text('id').primaryKey(),
    email: text('email').notNull(),
    name: text('name').notNull(),
    passwordHash: text('password_hash').notNull(),
    salt: text('salt').notNull(),
    role: text('role').notNull(),
    companyId: text('company_id').references(() => companies.id, { onDelete: 'restrict' }),
    phone: text('phone'),
    active: boolean('active').notNull().default(true),
    createdAt: text('created_at').notNull(),
  },
  (table) => [
    uniqueIndex('users_email_unique_idx').on(table.email),
    index('users_company_idx').on(table.companyId),
    index('users_role_idx').on(table.role),
  ]
);

export const sessions = pgTable(
  'sessions',
  {
    tokenHash: text('token_hash').primaryKey(), // SHA-256 hex digest of bearer token
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    expiresAt: bigint('expires_at', { mode: 'number' }).notNull(),
    revokedAt: bigint('revoked_at', { mode: 'number' }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index('sessions_user_idx').on(table.userId),
    index('sessions_expires_idx').on(table.expiresAt),
  ]
);

export const payments = pgTable(
  'payments',
  {
    id: text('id').primaryKey(),
    companyId: text('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'restrict' }),
    companyName: text('company_name').notNull(),
    planoId: text('plano_id').notNull(),
    planoNome: text('plano_nome').notNull(),
    valor: doublePrecision('valor').notNull(),
    periodoMeses: integer('periodo_meses').notNull(),
    metodoPagamento: text('metodo_pagamento').notNull(),
    comprovanteReferencia: text('comprovante_referencia').notNull(),
    comprovanteUrl: text('comprovante_url'),
    status: text('status').notNull(),
    solicitadoEm: text('solicitado_em').notNull(),
    aprovadoEm: text('aprovado_em'),
    aprovadoPor: text('aprovado_por'),
    observacoes: text('observacoes'),
  },
  (table) => [index('payments_company_status_idx').on(table.companyId, table.status)]
);

export const auditLogs = pgTable(
  'audit_logs',
  {
    id: text('id').primaryKey(),
    timestamp: text('timestamp').notNull(),
    userId: text('user_id').notNull(),
    userEmail: text('user_email').notNull(),
    userName: text('user_name').notNull(),
    companyId: text('company_id'),
    companyName: text('company_name'),
    acao: text('acao').notNull(),
    detalhes: text('detalhes').notNull(),
    ip: text('ip'),
  },
  (table) => [
    index('audit_logs_timestamp_idx').on(table.timestamp),
    index('audit_logs_company_idx').on(table.companyId),
    index('audit_logs_user_idx').on(table.userId),
  ]
);

// ============================================================================
// 2. LOGISTICS, INVENTORY, FLEET, ROUTES & CONDO TABLES
// ============================================================================

export const logisticsReceipts = pgTable(
  'logistics_receipts',
  {
    id: text('id').primaryKey(),
    companyId: text('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'restrict' }),
    numeroRecebimento: text('numero_recebimento').notNull(),
    status: text('status').notNull(),
    dataHora: text('data_hora').notNull(),
    payload: jsonb('payload').$type<Record<string, any>>().notNull(),
  },
  (table) => [index('logistics_receipts_company_idx').on(table.companyId)]
);

export const inventory = pgTable(
  'inventory',
  {
    id: text('id').primaryKey(),
    companyId: text('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'restrict' }),
    sku: text('sku').notNull(),
    nome: text('nome').notNull(),
    quantidade: doublePrecision('quantidade').notNull().default(0),
    payload: jsonb('payload').$type<Record<string, any>>().notNull(),
  },
  (table) => [index('inventory_company_sku_idx').on(table.companyId, table.sku)]
);

export const stockMovements = pgTable(
  'stock_movements',
  {
    id: text('id').primaryKey(),
    companyId: text('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'restrict' }),
    itemId: text('item_id').notNull(),
    tipo: text('tipo').notNull(),
    dataHora: text('data_hora').notNull(),
    payload: jsonb('payload').$type<Record<string, any>>().notNull(),
  },
  (table) => [index('stock_movements_company_idx').on(table.companyId)]
);

export const shipments = pgTable(
  'shipments',
  {
    id: text('id').primaryKey(),
    companyId: text('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'restrict' }),
    numeroExpedicao: text('numero_expedicao').notNull(),
    status: text('status').notNull(),
    dataCriacao: text('data_criacao').notNull(),
    payload: jsonb('payload').$type<Record<string, any>>().notNull(),
  },
  (table) => [index('shipments_company_idx').on(table.companyId)]
);

export const deliveries = pgTable(
  'deliveries',
  {
    id: text('id').primaryKey(),
    companyId: text('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'restrict' }),
    codigoRastreio: text('codigo_rastreio').notNull(),
    status: text('status').notNull(),
    routeId: text('route_id'),
    motoristaId: text('motorista_id'),
    criadoEm: text('criado_em').notNull(),
    payload: jsonb('payload').$type<Record<string, any>>().notNull(),
  },
  (table) => [
    index('deliveries_company_status_idx').on(table.companyId, table.status),
    index('deliveries_rastreio_idx').on(table.codigoRastreio),
    index('deliveries_route_idx').on(table.routeId),
  ]
);

export const vehicles = pgTable(
  'vehicles',
  {
    id: text('id').primaryKey(),
    companyId: text('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'restrict' }),
    placa: text('placa').notNull(),
    statusOperacional: text('status_operacional').notNull(),
    motoristaVinculadoId: text('motorista_vinculado_id'),
    payload: jsonb('payload').$type<Record<string, any>>().notNull(),
  },
  (table) => [index('vehicles_company_idx').on(table.companyId)]
);

export const routes = pgTable(
  'routes',
  {
    id: text('id').primaryKey(),
    companyId: text('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'restrict' }),
    codigoRota: text('codigo_rota').notNull(),
    status: text('status').notNull(),
    motoristaId: text('motorista_id').notNull(),
    veiculoId: text('veiculo_id').notNull(),
    criadaEm: text('criada_em').notNull(),
    payload: jsonb('payload').$type<Record<string, any>>().notNull(),
  },
  (table) => [
    index('routes_company_status_idx').on(table.companyId, table.status),
    index('routes_motorista_idx').on(table.motoristaId),
  ]
);

export const condoUnits = pgTable(
  'condo_units',
  {
    id: text('id').primaryKey(),
    companyId: text('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'restrict' }),
    bloco: text('bloco').notNull(),
    numeroUnidade: text('numero_unidade').notNull(),
    ativo: boolean('ativo').notNull().default(true),
    payload: jsonb('payload').$type<Record<string, any>>().notNull(),
  },
  (table) => [index('condo_units_company_idx').on(table.companyId)]
);

export const condoPackages = pgTable(
  'condo_packages',
  {
    id: text('id').primaryKey(),
    companyId: text('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'restrict' }),
    codigoPacote: text('codigo_pacote').notNull(),
    unitId: text('unit_id').notNull(),
    status: text('status').notNull(),
    recebidoEm: text('recebido_em').notNull(),
    payload: jsonb('payload').$type<Record<string, any>>().notNull(),
  },
  (table) => [
    index('condo_packages_company_status_idx').on(table.companyId, table.status),
    index('condo_packages_codigo_idx').on(table.codigoPacote),
  ]
);

export const condoVisitors = pgTable(
  'condo_visitors',
  {
    id: text('id').primaryKey(),
    companyId: text('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'restrict' }),
    status: text('status').notNull(),
    dataHoraEntrada: text('data_hora_entrada').notNull(),
    payload: jsonb('payload').$type<Record<string, any>>().notNull(),
  },
  (table) => [index('condo_visitors_company_idx').on(table.companyId)]
);

// ============================================================================
// 3. FISCAL, FINANCIAL & NOTIFICATIONS TABLES
// ============================================================================

export const fiscalConfigs = pgTable(
  'fiscal_configs',
  {
    id: text('id').primaryKey(),
    companyId: text('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'restrict' }),
    cnpj: text('cnpj').notNull(),
    atualizadoEm: text('atualizado_em').notNull(),
    payload: jsonb('payload').$type<Record<string, any>>().notNull(),
  },
  (table) => [index('fiscal_configs_company_idx').on(table.companyId)]
);

export const fiscalDocuments = pgTable(
  'fiscal_documents',
  {
    id: text('id').primaryKey(),
    companyId: text('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'restrict' }),
    tipo: text('tipo').notNull(),
    numero: integer('numero').notNull(),
    serie: integer('serie').notNull(),
    chaveAcesso: text('chave_acesso').notNull(),
    status: text('status').notNull(),
    dataEmissao: text('data_emissao').notNull(),
    payload: jsonb('payload').$type<Record<string, any>>().notNull(),
  },
  (table) => [
    index('fiscal_documents_company_idx').on(table.companyId),
    index('fiscal_documents_chave_idx').on(table.chaveAcesso),
  ]
);

export const financialRecords = pgTable(
  'financial_records',
  {
    id: text('id').primaryKey(),
    companyId: text('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'restrict' }),
    tipo: text('tipo').notNull(),
    categoria: text('categoria').notNull(),
    valor: doublePrecision('valor').notNull(),
    status: text('status').notNull(),
    dataCompetencia: text('data_competencia').notNull(),
    payload: jsonb('payload').$type<Record<string, any>>().notNull(),
  },
  (table) => [index('financial_records_company_idx').on(table.companyId)]
);

export const notifications = pgTable(
  'notifications',
  {
    id: text('id').primaryKey(),
    companyId: text('company_id'),
    tipo: text('tipo').notNull(),
    lida: boolean('lida').notNull().default(false),
    prioridade: text('prioridade').notNull(),
    dataHora: text('data_hora').notNull(),
    payload: jsonb('payload').$type<Record<string, any>>().notNull(),
  },
  (table) => [index('notifications_company_lida_idx').on(table.companyId, table.lida)]
);

// ============================================================================
// 4. COMMERCIAL (ADEGA & TABACARIA PDV, PIX & TERMINALS) TABLES
// ============================================================================

export const commercialProducts = pgTable(
  'commercial_products',
  {
    id: text('id').primaryKey(),
    companyId: text('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'restrict' }),
    modulo: text('modulo').notNull(),
    sku: text('sku').notNull(),
    codigoBarras: text('codigo_barras'),
    nome: text('nome').notNull(),
    estoqueAtual: doublePrecision('estoque_atual').notNull().default(0),
    ativo: boolean('ativo').notNull().default(true),
    payload: jsonb('payload').$type<Record<string, any>>().notNull(),
  },
  (table) => [
    index('commercial_products_company_sku_idx').on(table.companyId, table.sku),
    index('commercial_products_barcode_idx').on(table.companyId, table.codigoBarras),
  ]
);

export const commercialStockMovements = pgTable(
  'commercial_stock_movements',
  {
    id: text('id').primaryKey(),
    companyId: text('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'restrict' }),
    productId: text('product_id').notNull(),
    tipo: text('tipo').notNull(),
    criadoEm: text('criado_em').notNull(),
    payload: jsonb('payload').$type<Record<string, any>>().notNull(),
  },
  (table) => [index('commercial_stock_movements_company_idx').on(table.companyId, table.productId)]
);

export const commercialSales = pgTable(
  'commercial_sales',
  {
    id: text('id').primaryKey(),
    companyId: text('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'restrict' }),
    codigoVenda: text('codigo_venda').notNull(),
    caixaSessionId: text('caixa_session_id'),
    status: text('status').notNull(),
    valorTotal: doublePrecision('valor_total').notNull(),
    idempotencyKey: text('idempotency_key'),
    criadoEm: text('criado_em').notNull(),
    payload: jsonb('payload').$type<Record<string, any>>().notNull(),
  },
  (table) => [
    index('commercial_sales_company_idx').on(table.companyId, table.criadoEm),
    index('commercial_sales_idempotency_idx').on(table.companyId, table.idempotencyKey),
  ]
);

export const commercialCashSessions = pgTable(
  'commercial_cash_sessions',
  {
    id: text('id').primaryKey(),
    companyId: text('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'restrict' }),
    codigoSessao: text('codigo_sessao').notNull(),
    operadorId: text('operador_id').notNull(),
    status: text('status').notNull(),
    abertoEm: text('aberto_em').notNull(),
    payload: jsonb('payload').$type<Record<string, any>>().notNull(),
  },
  (table) => [index('commercial_cash_sessions_company_status_idx').on(table.companyId, table.status)]
);

export const commercialSuppliers = pgTable(
  'commercial_suppliers',
  {
    id: text('id').primaryKey(),
    companyId: text('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'restrict' }),
    razaoSocial: text('razao_social').notNull(),
    ativo: boolean('ativo').notNull().default(true),
    payload: jsonb('payload').$type<Record<string, any>>().notNull(),
  },
  (table) => [index('commercial_suppliers_company_idx').on(table.companyId)]
);

export const commercialPurchases = pgTable(
  'commercial_purchases',
  {
    id: text('id').primaryKey(),
    companyId: text('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'restrict' }),
    fornecedorId: text('fornecedor_id').notNull(),
    status: text('status').notNull(),
    dataCompra: text('data_compra').notNull(),
    payload: jsonb('payload').$type<Record<string, any>>().notNull(),
  },
  (table) => [index('commercial_purchases_company_idx').on(table.companyId)]
);

export const pixCharges = pgTable(
  'pix_charges',
  {
    id: text('id').primaryKey(),
    companyId: text('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'restrict' }),
    txid: text('txid').notNull(),
    status: text('status').notNull(),
    idempotencyKey: text('idempotency_key'),
    criadoEm: text('criado_em').notNull(),
    payload: jsonb('payload').$type<Record<string, any>>().notNull(),
  },
  (table) => [
    index('pix_charges_company_txid_idx').on(table.companyId, table.txid),
  ]
);

export const commercialTerminals = pgTable(
  'commercial_terminals',
  {
    id: text('id').primaryKey(),
    companyId: text('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'restrict' }),
    provedor: text('provedor').notNull(),
    identificadorProvedor: text('identificador_provedor').notNull(),
    ativo: boolean('ativo').notNull().default(true),
    payload: jsonb('payload').$type<Record<string, any>>().notNull(),
  },
  (table) => [index('commercial_terminals_company_idx').on(table.companyId)]
);

export const commercialTerminalTransactions = pgTable(
  'commercial_terminal_transactions',
  {
    id: text('id').primaryKey(),
    companyId: text('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'restrict' }),
    terminalId: text('terminal_id').notNull(),
    paymentIntentId: text('payment_intent_id'),
    status: text('status').notNull(),
    idempotencyKey: text('idempotency_key'),
    criadoEm: text('criado_em').notNull(),
    payload: jsonb('payload').$type<Record<string, any>>().notNull(),
  },
  (table) => [
    index('commercial_terminal_tx_company_idx').on(table.companyId),
    index('commercial_terminal_tx_intent_idx').on(table.paymentIntentId),
  ]
);

// ============================================================================
// 5. PREVENTION, ENTERPRISE WAREHOUSES, FULFILLMENT & CONTROL TOWER TABLES
// ============================================================================

export const preventionDismissedAlerts = pgTable(
  'prevention_dismissed_alerts',
  {
    id: text('id').primaryKey(),
    companyId: text('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'restrict' }),
    tipo: text('tipo').notNull(),
    referenciaId: text('referencia_id').notNull(),
    resolvidoEm: text('resolvido_em').notNull(),
    payload: jsonb('payload').$type<Record<string, any>>().notNull(),
  },
  (table) => [index('prevention_alerts_company_idx').on(table.companyId)]
);

export const warehouses = pgTable(
  'warehouses',
  {
    id: text('id').primaryKey(),
    companyId: text('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'restrict' }),
    codigo: text('codigo').notNull(),
    nome: text('nome').notNull(),
    ativo: boolean('ativo').notNull().default(true),
    payload: jsonb('payload').$type<Record<string, any>>().notNull(),
  },
  (table) => [index('warehouses_company_idx').on(table.companyId)]
);

export const warehouseTransfers = pgTable(
  'warehouse_transfers',
  {
    id: text('id').primaryKey(),
    companyId: text('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'restrict' }),
    codigoTransferencia: text('codigo_transferencia').notNull(),
    status: text('status').notNull(),
    dataSolicitacao: text('data_solicitacao').notNull(),
    payload: jsonb('payload').$type<Record<string, any>>().notNull(),
  },
  (table) => [index('warehouse_transfers_company_idx').on(table.companyId)]
);

export const warehouseAudits = pgTable(
  'warehouse_audits',
  {
    id: text('id').primaryKey(),
    companyId: text('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'restrict' }),
    codigoInventario: text('codigo_inventario').notNull(),
    cdId: text('cd_id').notNull(),
    status: text('status').notNull(),
    dataInicio: text('data_inicio').notNull(),
    payload: jsonb('payload').$type<Record<string, any>>().notNull(),
  },
  (table) => [index('warehouse_audits_company_idx').on(table.companyId)]
);

export const fulfillmentOrders = pgTable(
  'fulfillment_orders',
  {
    id: text('id').primaryKey(),
    companyId: text('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'restrict' }),
    numeroPedido: text('numero_pedido').notNull(),
    cdId: text('cd_id').notNull(),
    etapaAtual: text('etapa_atual').notNull(),
    criadoEm: text('criado_em').notNull(),
    payload: jsonb('payload').$type<Record<string, any>>().notNull(),
  },
  (table) => [index('fulfillment_orders_company_stage_idx').on(table.companyId, table.etapaAtual)]
);

export const pickingTasks = pgTable(
  'picking_tasks',
  {
    id: text('id').primaryKey(),
    companyId: text('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'restrict' }),
    codigoOnda: text('codigo_onda').notNull(),
    cdId: text('cd_id').notNull(),
    status: text('status').notNull(),
    payload: jsonb('payload').$type<Record<string, any>>().notNull(),
  },
  (table) => [index('picking_tasks_company_idx').on(table.companyId)]
);

export const packingTasks = pgTable(
  'packing_tasks',
  {
    id: text('id').primaryKey(),
    companyId: text('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'restrict' }),
    pedidoId: text('pedido_id').notNull(),
    cdId: text('cd_id').notNull(),
    status: text('status').notNull(),
    payload: jsonb('payload').$type<Record<string, any>>().notNull(),
  },
  (table) => [index('packing_tasks_company_idx').on(table.companyId)]
);

export const reverseLogistics = pgTable(
  'reverse_logistics',
  {
    id: text('id').primaryKey(),
    companyId: text('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'restrict' }),
    codigoReversa: text('codigo_reversa').notNull(),
    pedidoOriginalId: text('pedido_original_id').notNull(),
    status: text('status').notNull(),
    solicitadoEm: text('solicitado_em').notNull(),
    payload: jsonb('payload').$type<Record<string, any>>().notNull(),
  },
  (table) => [index('reverse_logistics_company_idx').on(table.companyId)]
);

export const carrierPartners = pgTable(
  'carrier_partners',
  {
    id: text('id').primaryKey(),
    companyId: text('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'restrict' }),
    codigo: text('codigo').notNull(),
    statusIntegracao: text('status_integracao').notNull(),
    payload: jsonb('payload').$type<Record<string, any>>().notNull(),
  },
  (table) => [index('carrier_partners_company_idx').on(table.companyId)]
);

export const b2bClients = pgTable(
  'b2b_clients',
  {
    id: text('id').primaryKey(),
    companyId: text('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'restrict' }),
    cnpj: text('cnpj').notNull(),
    statusContrato: text('status_contrato').notNull(),
    payload: jsonb('payload').$type<Record<string, any>>().notNull(),
  },
  (table) => [index('b2b_clients_company_idx').on(table.companyId)]
);

export const b2bCollections = pgTable(
  'b2b_collections',
  {
    id: text('id').primaryKey(),
    companyId: text('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'restrict' }),
    codigoSolicitacao: text('codigo_solicitacao').notNull(),
    status: text('status').notNull(),
    payload: jsonb('payload').$type<Record<string, any>>().notNull(),
  },
  (table) => [index('b2b_collections_company_idx').on(table.companyId)]
);

export const shippingManifests = pgTable(
  'shipping_manifests',
  {
    id: text('id').primaryKey(),
    companyId: text('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'restrict' }),
    codigoManifesto: text('codigo_manifesto').notNull(),
    cdId: text('cd_id').notNull(),
    status: text('status').notNull(),
    criadoEm: text('criado_em').notNull(),
    payload: jsonb('payload').$type<Record<string, any>>().notNull(),
  },
  (table) => [index('shipping_manifests_company_idx').on(table.companyId)]
);

export const aiInsights = pgTable(
  'ai_insights',
  {
    id: text('id').primaryKey(),
    companyId: text('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'restrict' }),
    tipo: text('tipo').notNull(),
    prioridade: text('prioridade').notNull(),
    statusAprovacao: text('status_aprovacao').notNull(),
    timestamp: text('timestamp').notNull(),
    payload: jsonb('payload').$type<Record<string, any>>().notNull(),
  },
  (table) => [index('ai_insights_company_idx').on(table.companyId)]
);

// ============================================================================
// 6. NORMALIZED CHILD & MIGRATION PARITY TABLES (COMPLETING 52 ENTITIES)
// ============================================================================

export const routeStops = pgTable(
  'route_stops',
  {
    id: text('id').primaryKey(), // `${routeId}:${ordem}:${deliveryId}`
    routeId: text('route_id')
      .notNull()
      .references(() => routes.id, { onDelete: 'cascade' }),
    companyId: text('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'restrict' }),
    ordem: integer('ordem').notNull(),
    deliveryId: text('delivery_id').notNull(),
    status: text('status').notNull(),
    payload: jsonb('payload').$type<Record<string, any>>().notNull(),
  },
  (table) => [index('route_stops_route_idx').on(table.routeId)]
);

export const commercialSaleItems = pgTable(
  'commercial_sale_items',
  {
    id: text('id').primaryKey(), // `${saleId}:${index}:${productId}`
    saleId: text('sale_id')
      .notNull()
      .references(() => commercialSales.id, { onDelete: 'cascade' }),
    companyId: text('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'restrict' }),
    productId: text('product_id').notNull(),
    quantidade: doublePrecision('quantidade').notNull(),
    total: doublePrecision('total').notNull(),
    payload: jsonb('payload').$type<Record<string, any>>().notNull(),
  },
  (table) => [index('commercial_sale_items_sale_idx').on(table.saleId)]
);

export const commercialCashMovements = pgTable(
  'commercial_cash_movements',
  {
    id: text('id').primaryKey(),
    cashSessionId: text('cash_session_id')
      .notNull()
      .references(() => commercialCashSessions.id, { onDelete: 'cascade' }),
    companyId: text('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'restrict' }),
    tipo: text('tipo').notNull(),
    valor: doublePrecision('valor').notNull(),
    dataHora: text('data_hora').notNull(),
    payload: jsonb('payload').$type<Record<string, any>>().notNull(),
  },
  (table) => [index('commercial_cash_movements_session_idx').on(table.cashSessionId)]
);

export const warehousePositions = pgTable(
  'warehouse_positions',
  {
    id: text('id').primaryKey(),
    warehouseId: text('warehouse_id')
      .notNull()
      .references(() => warehouses.id, { onDelete: 'cascade' }),
    companyId: text('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'restrict' }),
    codigo: text('codigo').notNull(),
    status: text('status').notNull(),
    itemIdAlocado: text('item_id_alocado'),
    payload: jsonb('payload').$type<Record<string, any>>().notNull(),
  },
  (table) => [index('warehouse_positions_wh_idx').on(table.warehouseId)]
);

export const warehouseTransferItems = pgTable(
  'warehouse_transfer_items',
  {
    id: text('id').primaryKey(),
    transferId: text('transfer_id')
      .notNull()
      .references(() => warehouseTransfers.id, { onDelete: 'cascade' }),
    companyId: text('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'restrict' }),
    itemId: text('item_id').notNull(),
    quantidade: doublePrecision('quantidade').notNull(),
    payload: jsonb('payload').$type<Record<string, any>>().notNull(),
  },
  (table) => [index('warehouse_transfer_items_tx_idx').on(table.transferId)]
);

export const warehouseAuditItems = pgTable(
  'warehouse_audit_items',
  {
    id: text('id').primaryKey(),
    auditId: text('audit_id')
      .notNull()
      .references(() => warehouseAudits.id, { onDelete: 'cascade' }),
    companyId: text('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'restrict' }),
    itemId: text('item_id').notNull(),
    divergencia: doublePrecision('divergencia').notNull(),
    payload: jsonb('payload').$type<Record<string, any>>().notNull(),
  },
  (table) => [index('warehouse_audit_items_audit_idx').on(table.auditId)]
);

export const fulfillmentOrderItems = pgTable(
  'fulfillment_order_items',
  {
    id: text('id').primaryKey(),
    orderId: text('order_id')
      .notNull()
      .references(() => fulfillmentOrders.id, { onDelete: 'cascade' }),
    companyId: text('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'restrict' }),
    sku: text('sku').notNull(),
    quantidade: doublePrecision('quantidade').notNull(),
    payload: jsonb('payload').$type<Record<string, any>>().notNull(),
  },
  (table) => [index('fulfillment_order_items_order_idx').on(table.orderId)]
);

export const pickingTaskItems = pgTable(
  'picking_task_items',
  {
    id: text('id').primaryKey(),
    pickingTaskId: text('picking_task_id')
      .notNull()
      .references(() => pickingTasks.id, { onDelete: 'cascade' }),
    companyId: text('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'restrict' }),
    pedidoId: text('pedido_id').notNull(),
    sku: text('sku').notNull(),
    concluido: boolean('concluido').notNull().default(false),
    payload: jsonb('payload').$type<Record<string, any>>().notNull(),
  },
  (table) => [index('picking_task_items_task_idx').on(table.pickingTaskId)]
);

export const migrationCheckpoints = pgTable('migration_checkpoints', {
  id: text('id').primaryKey(),
  executedAt: timestamp('executed_at', { withTimezone: true }).defaultNow().notNull(),
  sourceDbSha256: text('source_db_sha256').notNull(),
  sourceSessionsSha256: text('source_sessions_sha256').notNull(),
  parityVerified: boolean('parity_verified').notNull().default(false),
  summary: jsonb('summary').$type<Record<string, any>>().notNull(),
});

// ============================================================================
// 7. DRIZZLE RELATIONS
// ============================================================================

export const companiesRelations = relations(companies, ({ many }) => ({
  users: many(users),
  payments: many(payments),
  deliveries: many(deliveries),
  routes: many(routes),
  warehouses: many(warehouses),
  commercialProducts: many(commercialProducts),
  commercialSales: many(commercialSales),
}));

export const usersRelations = relations(users, ({ one, many }) => ({
  company: one(companies, {
    fields: [users.companyId],
    references: [companies.id],
  }),
  sessions: many(sessions),
}));

export const sessionsRelations = relations(sessions, ({ one }) => ({
  user: one(users, {
    fields: [sessions.userId],
    references: [users.id],
  }),
}));

export const routesRelations = relations(routes, ({ many }) => ({
  stops: many(routeStops),
}));

export const routeStopsRelations = relations(routeStops, ({ one }) => ({
  route: one(routes, {
    fields: [routeStops.routeId],
    references: [routes.id],
  }),
}));

export const commercialSalesRelations = relations(commercialSales, ({ many }) => ({
  items: many(commercialSaleItems),
}));

export const commercialSaleItemsRelations = relations(commercialSaleItems, ({ one }) => ({
  sale: one(commercialSales, {
    fields: [commercialSaleItems.saleId],
    references: [commercialSales.id],
  }),
}));

export const commercialCashSessionsRelations = relations(commercialCashSessions, ({ many }) => ({
  movements: many(commercialCashMovements),
}));

export const commercialCashMovementsRelations = relations(commercialCashMovements, ({ one }) => ({
  cashSession: one(commercialCashSessions, {
    fields: [commercialCashMovements.cashSessionId],
    references: [commercialCashSessions.id],
  }),
}));

export const warehousesRelations = relations(warehouses, ({ many }) => ({
  positions: many(warehousePositions),
}));

export const warehousePositionsRelations = relations(warehousePositions, ({ one }) => ({
  warehouse: one(warehouses, {
    fields: [warehousePositions.warehouseId],
    references: [warehouses.id],
  }),
}));

export const fulfillmentOrdersRelations = relations(fulfillmentOrders, ({ many }) => ({
  items: many(fulfillmentOrderItems),
}));

export const fulfillmentOrderItemsRelations = relations(fulfillmentOrderItems, ({ one }) => ({
  order: one(fulfillmentOrders, {
    fields: [fulfillmentOrderItems.orderId],
    references: [fulfillmentOrders.id],
  }),
}));

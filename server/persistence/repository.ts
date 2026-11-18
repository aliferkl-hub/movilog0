import { AsyncLocalStorage } from 'async_hooks';
import crypto from 'crypto';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { getPersistenceMode, getPgDb, schema } from '../../src/db/index.ts';
import type {
  AuditLog,
  CommercialPlan,
  CommercialProduct,
  CommercialStockMovement,
  Company,
  DatabaseSchema,
  DeliveryRoute,
  FulfillmentOrder,
  PickingTask,
  SystemConfig,
  User,
  WarehouseCD,
  WarehouseInventoryAudit,
  WarehouseTransfer,
  CommercialSale,
  CommercialCashSession,
} from '../db.ts';

export type CollectionKey = Exclude<keyof DatabaseSchema, 'systemConfig'>;

export const ALL_COLLECTION_KEYS: CollectionKey[] = [
  'users',
  'companies',
  'plans',
  'payments',
  'auditLogs',
  'logisticsReceipts',
  'inventory',
  'stockMovements',
  'shipments',
  'deliveries',
  'vehicles',
  'routes',
  'condoUnits',
  'condoPackages',
  'condoVisitors',
  'fiscalConfigs',
  'fiscalDocuments',
  'financialRecords',
  'notifications',
  'commercialProducts',
  'commercialStockMovements',
  'commercialSales',
  'commercialCashSessions',
  'commercialSuppliers',
  'commercialPurchases',
  'pixCharges',
  'commercialTerminals',
  'commercialTerminalTransactions',
  'preventionDismissedAlerts',
  'warehouses',
  'warehouseTransfers',
  'warehouseAudits',
  'fulfillmentOrders',
  'pickingTasks',
  'packingTasks',
  'reverseLogistics',
  'carrierPartners',
  'b2bClients',
  'b2bCollections',
  'shippingManifests',
  'aiInsights',
];

export const PAYLOAD_COLLECTION_KEYS = [
  'logisticsReceipts',
  'inventory',
  'stockMovements',
  'shipments',
  'deliveries',
  'vehicles',
  'routes',
  'condoUnits',
  'condoPackages',
  'condoVisitors',
  'fiscalConfigs',
  'fiscalDocuments',
  'financialRecords',
  'notifications',
  'commercialProducts',
  'commercialStockMovements',
  'commercialSales',
  'commercialCashSessions',
  'commercialSuppliers',
  'commercialPurchases',
  'pixCharges',
  'commercialTerminals',
  'commercialTerminalTransactions',
  'preventionDismissedAlerts',
  'warehouses',
  'warehouseTransfers',
  'warehouseAudits',
  'fulfillmentOrders',
  'pickingTasks',
  'packingTasks',
  'reverseLogistics',
  'carrierPartners',
  'b2bClients',
  'b2bCollections',
  'shippingManifests',
  'aiInsights',
] as const;

export type PayloadCollectionKey = (typeof PAYLOAD_COLLECTION_KEYS)[number];

export function hashSessionToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

export function isPostgresActive(): boolean {
  return getPersistenceMode() === 'postgres';
}

// ============================================================================
// TABLE MAPPING HELPERS (RELATIONAL COLUMNS <-> DOMAIN ENTITIES)
// ============================================================================

function toPayloadRow(key: PayloadCollectionKey, item: any): Record<string, any> {
  const base = { id: item.id, companyId: item.companyId ?? null, payload: item };
  switch (key) {
    case 'logisticsReceipts':
      return {
        ...base,
        numeroRecebimento: item.numeroRecebimento || '',
        status: item.status || 'conferido',
        dataHora: item.dataHora || new Date().toISOString(),
      };
    case 'inventory':
      return {
        ...base,
        sku: item.sku || '',
        nome: item.nome || '',
        quantidade: Number(item.quantidade || 0),
      };
    case 'stockMovements':
      return {
        ...base,
        itemId: item.itemId || '',
        tipo: item.tipo || 'ajuste',
        dataHora: item.dataHora || new Date().toISOString(),
      };
    case 'shipments':
      return {
        ...base,
        numeroExpedicao: item.numeroExpedicao || '',
        status: item.status || 'separacao',
        dataCriacao: item.dataCriacao || new Date().toISOString(),
      };
    case 'deliveries':
      return {
        ...base,
        codigoRastreio: item.codigoRastreio || '',
        status: item.status || 'pendente',
        routeId: item.routeId ?? null,
        motoristaId: item.motoristaId ?? null,
        criadoEm: item.criadoEm || new Date().toISOString(),
      };
    case 'vehicles':
      return {
        ...base,
        placa: item.placa || '',
        statusOperacional: item.statusOperacional || 'disponivel',
        motoristaVinculadoId: item.motoristaVinculadoId ?? null,
      };
    case 'routes':
      return {
        ...base,
        codigoRota: item.codigoRota || '',
        status: item.status || 'em_preparacao',
        motoristaId: item.motoristaId || '',
        veiculoId: item.veiculoId || '',
        criadaEm: item.criadaEm || new Date().toISOString(),
      };
    case 'condoUnits':
      return {
        ...base,
        bloco: item.bloco || '',
        numeroUnidade: item.numeroUnidade || '',
        ativo: item.ativo !== false,
      };
    case 'condoPackages':
      return {
        ...base,
        codigoPacote: item.codigoPacote || '',
        unitId: item.unitId || '',
        status: item.status || 'aguardando_retirada',
        recebidoEm: item.recebidoEm || new Date().toISOString(),
      };
    case 'condoVisitors':
      return {
        ...base,
        status: item.status || 'no_local',
        dataHoraEntrada: item.dataHoraEntrada || new Date().toISOString(),
      };
    case 'fiscalConfigs':
      return {
        ...base,
        cnpj: item.cnpj || '',
        atualizadoEm: item.atualizadoEm || new Date().toISOString(),
      };
    case 'fiscalDocuments':
      return {
        ...base,
        tipo: item.tipo || 'nfe',
        numero: Number(item.numero || 0),
        serie: Number(item.serie || 1),
        chaveAcesso: item.chaveAcesso || '',
        status: item.status || 'autorizado',
        dataEmissao: item.dataEmissao || new Date().toISOString(),
      };
    case 'financialRecords':
      return {
        ...base,
        tipo: item.tipo || 'despesa',
        categoria: item.categoria || 'outros',
        valor: Number(item.valor || 0),
        status: item.status || 'pendente',
        dataCompetencia: item.dataCompetencia || new Date().toISOString(),
      };
    case 'notifications':
      return {
        ...base,
        tipo: item.tipo || 'sistema',
        lida: Boolean(item.lida),
        prioridade: item.prioridade || 'media',
        dataHora: item.dataHora || new Date().toISOString(),
      };
    case 'commercialProducts':
      return {
        ...base,
        modulo: item.modulo || 'adega',
        sku: item.sku || '',
        codigoBarras: item.codigoBarras ?? null,
        nome: item.nome || '',
        estoqueAtual: Number(item.estoqueAtual || 0),
        ativo: item.ativo !== false,
      };
    case 'commercialStockMovements':
      return {
        ...base,
        productId: item.productId || '',
        tipo: item.tipo || 'ajuste_manual',
        criadoEm: item.criadoEm || new Date().toISOString(),
      };
    case 'commercialSales':
      return {
        ...base,
        codigoVenda: item.codigoVenda || '',
        caixaSessionId: item.caixaSessionId ?? null,
        status: item.status || 'concluida',
        valorTotal: Number(item.valorTotal || 0),
        idempotencyKey: item.idempotencyKey ?? null,
        criadoEm: item.criadoEm || new Date().toISOString(),
      };
    case 'commercialCashSessions':
      return {
        ...base,
        codigoSessao: item.codigoSessao || '',
        operadorId: item.operadorId || '',
        status: item.status || 'aberto',
        abertoEm: item.abertoEm || new Date().toISOString(),
      };
    case 'commercialSuppliers':
      return {
        ...base,
        razaoSocial: item.razaoSocial || '',
        ativo: item.ativo !== false,
      };
    case 'commercialPurchases':
      return {
        ...base,
        fornecedorId: item.fornecedorId || '',
        status: item.status || 'pendente',
        dataCompra: item.dataCompra || new Date().toISOString(),
      };
    case 'pixCharges':
      return {
        ...base,
        txid: item.txid || '',
        status: item.status || 'aguardando_pagamento',
        idempotencyKey: item.idempotencyKey ?? null,
        criadoEm: item.criadoEm || new Date().toISOString(),
      };
    case 'commercialTerminals':
      return {
        ...base,
        provedor: item.provedor || 'pos_manual',
        identificadorProvedor: item.identificadorProvedor || '',
        ativo: item.ativo !== false,
      };
    case 'commercialTerminalTransactions':
      return {
        ...base,
        terminalId: item.terminalId || '',
        paymentIntentId: item.paymentIntentId ?? null,
        status: item.status || 'pendente',
        idempotencyKey: item.idempotencyKey ?? null,
        criadoEm: item.criadoEm || new Date().toISOString(),
      };
    case 'preventionDismissedAlerts':
      return {
        ...base,
        tipo: item.tipo || '',
        referenciaId: item.referenciaId || '',
        resolvidoEm: item.resolvidoEm || new Date().toISOString(),
      };
    case 'warehouses':
      return {
        ...base,
        codigo: item.codigo || '',
        nome: item.nome || '',
        ativo: item.ativo !== false,
      };
    case 'warehouseTransfers':
      return {
        ...base,
        codigoTransferencia: item.codigoTransferencia || '',
        status: item.status || 'solicitada',
        dataSolicitacao: item.dataSolicitacao || new Date().toISOString(),
      };
    case 'warehouseAudits':
      return {
        ...base,
        codigoInventario: item.codigoInventario || '',
        cdId: item.cdId || '',
        status: item.status || 'aberto',
        dataInicio: item.dataInicio || new Date().toISOString(),
      };
    case 'fulfillmentOrders':
      return {
        ...base,
        numeroPedido: item.numeroPedido || '',
        cdId: item.cdId || '',
        etapaAtual: item.etapaAtual || 'recebido',
        criadoEm: item.criadoEm || new Date().toISOString(),
      };
    case 'pickingTasks':
      return {
        ...base,
        codigoOnda: item.codigoOnda || '',
        cdId: item.cdId || '',
        status: item.status || 'pendente',
      };
    case 'packingTasks':
      return {
        ...base,
        pedidoId: item.pedidoId || '',
        cdId: item.cdId || '',
        status: item.status || 'em_embalagem',
      };
    case 'reverseLogistics':
      return {
        ...base,
        codigoReversa: item.codigoReversa || '',
        pedidoOriginalId: item.pedidoOriginalId || '',
        status: item.status || 'solicitada',
        solicitadoEm: item.solicitadoEm || new Date().toISOString(),
      };
    case 'carrierPartners':
      return {
        ...base,
        codigo: item.codigo || '',
        statusIntegracao: item.statusIntegracao || 'ativo',
      };
    case 'b2bClients':
      return {
        ...base,
        cnpj: item.cnpj || '',
        statusContrato: item.statusContrato || 'ativo',
      };
    case 'b2bCollections':
      return {
        ...base,
        codigoSolicitacao: item.codigoSolicitacao || '',
        status: item.status || 'agendada',
      };
    case 'shippingManifests':
      return {
        ...base,
        codigoManifesto: item.codigoManifesto || '',
        cdId: item.cdId || '',
        status: item.status || 'gerado',
        criadoEm: item.criadoEm || new Date().toISOString(),
      };
    case 'aiInsights':
      return {
        ...base,
        tipo: item.tipo || 'gargalo_operacional',
        prioridade: item.prioridade || 'media',
        statusAprovacao: item.statusAprovacao || 'pendente_analise',
        timestamp: item.timestamp || new Date().toISOString(),
      };
  }
}

export const PAYLOAD_TABLES: Record<PayloadCollectionKey, any> = {
  logisticsReceipts: schema.logisticsReceipts,
  inventory: schema.inventory,
  stockMovements: schema.stockMovements,
  shipments: schema.shipments,
  deliveries: schema.deliveries,
  vehicles: schema.vehicles,
  routes: schema.routes,
  condoUnits: schema.condoUnits,
  condoPackages: schema.condoPackages,
  condoVisitors: schema.condoVisitors,
  fiscalConfigs: schema.fiscalConfigs,
  fiscalDocuments: schema.fiscalDocuments,
  financialRecords: schema.financialRecords,
  notifications: schema.notifications,
  commercialProducts: schema.commercialProducts,
  commercialStockMovements: schema.commercialStockMovements,
  commercialSales: schema.commercialSales,
  commercialCashSessions: schema.commercialCashSessions,
  commercialSuppliers: schema.commercialSuppliers,
  commercialPurchases: schema.commercialPurchases,
  pixCharges: schema.pixCharges,
  commercialTerminals: schema.commercialTerminals,
  commercialTerminalTransactions: schema.commercialTerminalTransactions,
  preventionDismissedAlerts: schema.preventionDismissedAlerts,
  warehouses: schema.warehouses,
  warehouseTransfers: schema.warehouseTransfers,
  warehouseAudits: schema.warehouseAudits,
  fulfillmentOrders: schema.fulfillmentOrders,
  pickingTasks: schema.pickingTasks,
  packingTasks: schema.packingTasks,
  reverseLogistics: schema.reverseLogistics,
  carrierPartners: schema.carrierPartners,
  b2bClients: schema.b2bClients,
  b2bCollections: schema.b2bCollections,
  shippingManifests: schema.shippingManifests,
  aiInsights: schema.aiInsights,
};

function isPayloadKey(key: CollectionKey): key is PayloadCollectionKey {
  return (PAYLOAD_COLLECTION_KEYS as readonly string[]).includes(key);
}

// Sync normalized child tables when parent documents are written
async function syncNormalizedChildren(
  tx: NodePgDatabase<typeof schema>,
  key: CollectionKey,
  item: any
): Promise<void> {
  if (!item?.id) return;

  if (key === 'routes') {
    const route = item as DeliveryRoute;
    await tx.delete(schema.routeStops).where(eq(schema.routeStops.routeId, route.id));
    if (Array.isArray(route.paradas) && route.paradas.length > 0) {
      await tx.insert(schema.routeStops).values(
        route.paradas.map((stop, idx) => ({
          id: `${route.id}:${stop.ordem ?? idx}:${stop.deliveryId}`,
          routeId: route.id,
          companyId: route.companyId,
          ordem: stop.ordem ?? idx + 1,
          deliveryId: stop.deliveryId,
          status: stop.status,
          payload: stop as any,
        }))
      );
    }
  } else if (key === 'commercialSales') {
    const sale = item as CommercialSale;
    await tx
      .delete(schema.commercialSaleItems)
      .where(eq(schema.commercialSaleItems.saleId, sale.id));
    if (Array.isArray(sale.itens) && sale.itens.length > 0) {
      await tx.insert(schema.commercialSaleItems).values(
        sale.itens.map((it, idx) => ({
          id: `${sale.id}:${idx}:${it.productId}`,
          saleId: sale.id,
          companyId: sale.companyId,
          productId: it.productId,
          quantidade: Number(it.quantidade || 0),
          total: Number(it.total || 0),
          payload: it as any,
        }))
      );
    }
  } else if (key === 'commercialCashSessions') {
    const sess = item as CommercialCashSession;
    await tx
      .delete(schema.commercialCashMovements)
      .where(eq(schema.commercialCashMovements.cashSessionId, sess.id));
    if (Array.isArray(sess.movimentacoesManuais) && sess.movimentacoesManuais.length > 0) {
      await tx.insert(schema.commercialCashMovements).values(
        sess.movimentacoesManuais.map((mv, idx) => ({
          id: mv.id || `${sess.id}:${idx}`,
          cashSessionId: sess.id,
          companyId: sess.companyId,
          tipo: mv.tipo,
          valor: Number(mv.valor || 0),
          dataHora: mv.dataHora,
          payload: mv as any,
        }))
      );
    }
  } else if (key === 'warehouses') {
    const wh = item as WarehouseCD;
    await tx
      .delete(schema.warehousePositions)
      .where(eq(schema.warehousePositions.warehouseId, wh.id));
    if (Array.isArray(wh.posicoes) && wh.posicoes.length > 0) {
      await tx.insert(schema.warehousePositions).values(
        wh.posicoes.map((pos) => ({
          id: pos.id,
          warehouseId: wh.id,
          companyId: wh.companyId,
          codigo: pos.codigo,
          status: pos.status,
          itemIdAlocado: pos.itemIdAlocado ?? null,
          payload: pos as any,
        }))
      );
    }
  } else if (key === 'warehouseTransfers') {
    const tr = item as WarehouseTransfer;
    await tx
      .delete(schema.warehouseTransferItems)
      .where(eq(schema.warehouseTransferItems.transferId, tr.id));
    if (Array.isArray(tr.itens) && tr.itens.length > 0) {
      await tx.insert(schema.warehouseTransferItems).values(
        tr.itens.map((it, idx) => ({
          id: `${tr.id}:${idx}:${it.itemId}`,
          transferId: tr.id,
          companyId: tr.companyId,
          itemId: it.itemId,
          quantidade: Number(it.quantidade || 0),
          payload: it as any,
        }))
      );
    }
  } else if (key === 'warehouseAudits') {
    const aud = item as WarehouseInventoryAudit;
    await tx
      .delete(schema.warehouseAuditItems)
      .where(eq(schema.warehouseAuditItems.auditId, aud.id));
    if (Array.isArray(aud.itens) && aud.itens.length > 0) {
      await tx.insert(schema.warehouseAuditItems).values(
        aud.itens.map((it, idx) => ({
          id: `${aud.id}:${idx}:${it.itemId}`,
          auditId: aud.id,
          companyId: aud.companyId,
          itemId: it.itemId,
          divergencia: Number(it.divergencia || 0),
          payload: it as any,
        }))
      );
    }
  } else if (key === 'fulfillmentOrders') {
    const ord = item as FulfillmentOrder;
    await tx
      .delete(schema.fulfillmentOrderItems)
      .where(eq(schema.fulfillmentOrderItems.orderId, ord.id));
    if (Array.isArray(ord.itens) && ord.itens.length > 0) {
      await tx.insert(schema.fulfillmentOrderItems).values(
        ord.itens.map((it, idx) => ({
          id: it.id || `${ord.id}:${idx}:${it.sku}`,
          orderId: ord.id,
          companyId: ord.companyId,
          sku: it.sku,
          quantidade: Number(it.quantidade || 0),
          payload: it as any,
        }))
      );
    }
  } else if (key === 'pickingTasks') {
    const task = item as PickingTask;
    await tx
      .delete(schema.pickingTaskItems)
      .where(eq(schema.pickingTaskItems.pickingTaskId, task.id));
    if (Array.isArray(task.itensPendentes) && task.itensPendentes.length > 0) {
      await tx.insert(schema.pickingTaskItems).values(
        task.itensPendentes.map((it, idx) => ({
          id: `${task.id}:${idx}:${it.pedidoId}:${it.sku}`,
          pickingTaskId: task.id,
          companyId: task.companyId,
          pedidoId: it.pedidoId,
          sku: it.sku,
          concluido: Boolean(it.concluido),
          payload: it as any,
        }))
      );
    }
  }
}

// ============================================================================
// UPSERT / READ PRIMITIVES (SHARED BETWEEN REQUEST CONTEXT & MIGRATION)
// ============================================================================

export async function upsertSystemConfigInTx(
  tx: NodePgDatabase<typeof schema>,
  config: SystemConfig
): Promise<void> {
  await tx
    .insert(schema.systemConfig)
    .values({
      id: 'default',
      nomePlataforma: config.nomePlataforma,
      whatsappComercial: config.whatsappComercial,
      mensagemWhatsappPadrao: config.mensagemWhatsappPadrao,
      diasDemonstracao: config.diasDemonstracao,
      masterEmail: config.masterEmail,
      masterInitialized: config.masterInitialized,
      modoManutencao: config.modoManutencao,
      updatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: schema.systemConfig.id,
      set: {
        nomePlataforma: config.nomePlataforma,
        whatsappComercial: config.whatsappComercial,
        mensagemWhatsappPadrao: config.mensagemWhatsappPadrao,
        diasDemonstracao: config.diasDemonstracao,
        masterEmail: config.masterEmail,
        masterInitialized: config.masterInitialized,
        modoManutencao: config.modoManutencao,
        updatedAt: new Date(),
      },
    });
}

export async function upsertCollectionItemInTx(
  tx: NodePgDatabase<typeof schema>,
  key: CollectionKey,
  item: any
): Promise<void> {
  if (key === 'users') {
    const u = item as User;
    await tx
      .insert(schema.users)
      .values({
        id: u.id,
        email: u.email,
        name: u.name,
        passwordHash: u.passwordHash,
        salt: u.salt,
        role: u.role,
        companyId: u.companyId ?? null,
        phone: u.phone ?? null,
        active: u.active,
        createdAt: u.createdAt,
      })
      .onConflictDoUpdate({
        target: schema.users.id,
        set: {
          email: u.email,
          name: u.name,
          passwordHash: u.passwordHash,
          salt: u.salt,
          role: u.role,
          companyId: u.companyId ?? null,
          phone: u.phone ?? null,
          active: u.active,
          createdAt: u.createdAt,
        },
      });
    return;
  }

  if (key === 'companies') {
    const c = item as Company;
    await tx
      .insert(schema.companies)
      .values({
        id: c.id,
        razaoSocial: c.razaoSocial,
        nomeFantasia: c.nomeFantasia,
        cnpj: c.cnpj ?? null,
        responsavel: c.responsavel,
        email: c.email,
        telefone: c.telefone,
        endereco: c.endereco,
        segmento: c.segmento,
        quantidadeFuncionarios: c.quantidadeFuncionarios,
        tipoOperacao: c.tipoOperacao,
        modulos: c.modulos,
        planoId: c.planoId,
        statusCadastro: c.statusCadastro,
        statusAssinatura: c.statusAssinatura,
        demoStartDate: c.demoStartDate ?? null,
        demoEndDate: c.demoEndDate ?? null,
        subscriptionStartDate: c.subscriptionStartDate ?? null,
        subscriptionEndDate: c.subscriptionEndDate ?? null,
        limites: c.limites,
        createdAt: c.createdAt,
        updatedAt: c.updatedAt,
      })
      .onConflictDoUpdate({
        target: schema.companies.id,
        set: {
          razaoSocial: c.razaoSocial,
          nomeFantasia: c.nomeFantasia,
          cnpj: c.cnpj ?? null,
          responsavel: c.responsavel,
          email: c.email,
          telefone: c.telefone,
          endereco: c.endereco,
          segmento: c.segmento,
          quantidadeFuncionarios: c.quantidadeFuncionarios,
          tipoOperacao: c.tipoOperacao,
          modulos: c.modulos,
          planoId: c.planoId,
          statusCadastro: c.statusCadastro,
          statusAssinatura: c.statusAssinatura,
          demoStartDate: c.demoStartDate ?? null,
          demoEndDate: c.demoEndDate ?? null,
          subscriptionStartDate: c.subscriptionStartDate ?? null,
          subscriptionEndDate: c.subscriptionEndDate ?? null,
          limites: c.limites,
          createdAt: c.createdAt,
          updatedAt: c.updatedAt,
        },
      });
    return;
  }

  if (key === 'plans') {
    const p = item as CommercialPlan;
    await tx
      .insert(schema.plans)
      .values({
        id: p.id,
        nome: p.nome,
        tipo: p.tipo,
        descricao: p.descricao,
        precoMensal: p.precoMensal,
        precoAnual: p.precoAnual,
        duracaoDias: p.duracaoDias,
        modulosPermitidos: p.modulosPermitidos,
        limites: p.limites,
        recursos: p.recursos,
        destaque: p.destaque ?? false,
        ativo: p.ativo,
      })
      .onConflictDoUpdate({
        target: schema.plans.id,
        set: {
          nome: p.nome,
          tipo: p.tipo,
          descricao: p.descricao,
          precoMensal: p.precoMensal,
          precoAnual: p.precoAnual,
          duracaoDias: p.duracaoDias,
          modulosPermitidos: p.modulosPermitidos,
          limites: p.limites,
          recursos: p.recursos,
          destaque: p.destaque ?? false,
          ativo: p.ativo,
        },
      });
    return;
  }

  if (key === 'payments') {
    await tx
      .insert(schema.payments)
      .values({
        id: item.id,
        companyId: item.companyId,
        companyName: item.companyName,
        planoId: item.planoId,
        planoNome: item.planoNome,
        valor: Number(item.valor || 0),
        periodoMeses: Number(item.periodoMeses || 1),
        metodoPagamento: item.metodoPagamento,
        comprovanteReferencia: item.comprovanteReferencia,
        comprovanteUrl: item.comprovanteUrl ?? null,
        status: item.status,
        solicitadoEm: item.solicitadoEm,
        aprovadoEm: item.aprovadoEm ?? null,
        aprovadoPor: item.aprovadoPor ?? null,
        observacoes: item.observacoes ?? null,
      })
      .onConflictDoUpdate({
        target: schema.payments.id,
        set: {
          companyId: item.companyId,
          companyName: item.companyName,
          planoId: item.planoId,
          planoNome: item.planoNome,
          valor: Number(item.valor || 0),
          periodoMeses: Number(item.periodoMeses || 1),
          metodoPagamento: item.metodoPagamento,
          comprovanteReferencia: item.comprovanteReferencia,
          comprovanteUrl: item.comprovanteUrl ?? null,
          status: item.status,
          solicitadoEm: item.solicitadoEm,
          aprovadoEm: item.aprovadoEm ?? null,
          aprovadoPor: item.aprovadoPor ?? null,
          observacoes: item.observacoes ?? null,
        },
      });
    return;
  }

  if (key === 'auditLogs') {
    const a = item as AuditLog;
    await tx
      .insert(schema.auditLogs)
      .values({
        id: a.id,
        timestamp: a.timestamp,
        userId: a.userId,
        userEmail: a.userEmail,
        userName: a.userName,
        companyId: a.companyId ?? null,
        companyName: a.companyName ?? null,
        acao: a.acao,
        detalhes: a.detalhes,
        ip: a.ip ?? null,
      })
      .onConflictDoUpdate({
        target: schema.auditLogs.id,
        set: {
          timestamp: a.timestamp,
          userId: a.userId,
          userEmail: a.userEmail,
          userName: a.userName,
          companyId: a.companyId ?? null,
          companyName: a.companyName ?? null,
          acao: a.acao,
          detalhes: a.detalhes,
          ip: a.ip ?? null,
        },
      });
    return;
  }

  if (isPayloadKey(key)) {
    const table = PAYLOAD_TABLES[key];
    const row = toPayloadRow(key, item);
    await tx.insert(table).values(row).onConflictDoUpdate({
      target: table.id,
      set: row,
    });
    await syncNormalizedChildren(tx, key, item);
  }
}

export async function deleteCollectionIdsInTx(
  tx: NodePgDatabase<typeof schema>,
  key: CollectionKey,
  ids: string[]
): Promise<void> {
  if (ids.length === 0) return;
  if (key === 'users') {
    await tx.delete(schema.users).where(inArray(schema.users.id, ids));
  } else if (key === 'companies') {
    await tx.delete(schema.companies).where(inArray(schema.companies.id, ids));
  } else if (key === 'plans') {
    await tx.delete(schema.plans).where(inArray(schema.plans.id, ids));
  } else if (key === 'payments') {
    await tx.delete(schema.payments).where(inArray(schema.payments.id, ids));
  } else if (key === 'auditLogs') {
    await tx.delete(schema.auditLogs).where(inArray(schema.auditLogs.id, ids));
  } else if (isPayloadKey(key)) {
    const table = PAYLOAD_TABLES[key];
    await tx.delete(table).where(inArray(table.id, ids));
  }
}

export async function readCollectionFromPg(
  pg: NodePgDatabase<typeof schema>,
  key: CollectionKey
): Promise<any[]> {
  if (key === 'users') {
    const rows = await pg.select().from(schema.users);
    return rows.map((r) => ({
      id: r.id,
      email: r.email,
      name: r.name,
      passwordHash: r.passwordHash,
      salt: r.salt,
      role: r.role,
      companyId: r.companyId,
      ...(r.phone !== null ? { phone: r.phone } : {}),
      active: r.active,
      createdAt: r.createdAt,
    }));
  }
  if (key === 'companies') {
    const rows = await pg.select().from(schema.companies);
    return rows.map((r) => ({
      id: r.id,
      razaoSocial: r.razaoSocial,
      nomeFantasia: r.nomeFantasia,
      ...(r.cnpj !== null ? { cnpj: r.cnpj } : {}),
      responsavel: r.responsavel,
      email: r.email,
      telefone: r.telefone,
      endereco: r.endereco,
      segmento: r.segmento,
      quantidadeFuncionarios: r.quantidadeFuncionarios,
      tipoOperacao: r.tipoOperacao,
      modulos: r.modulos,
      planoId: r.planoId,
      statusCadastro: r.statusCadastro,
      statusAssinatura: r.statusAssinatura,
      ...(r.demoStartDate !== null ? { demoStartDate: r.demoStartDate } : {}),
      ...(r.demoEndDate !== null ? { demoEndDate: r.demoEndDate } : {}),
      ...(r.subscriptionStartDate !== null ? { subscriptionStartDate: r.subscriptionStartDate } : {}),
      ...(r.subscriptionEndDate !== null ? { subscriptionEndDate: r.subscriptionEndDate } : {}),
      limites: r.limites,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
    }));
  }
  if (key === 'plans') {
    const rows = await pg.select().from(schema.plans);
    return rows.map((r) => ({
      id: r.id,
      nome: r.nome,
      tipo: r.tipo,
      descricao: r.descricao,
      precoMensal: r.precoMensal,
      precoAnual: r.precoAnual,
      duracaoDias: r.duracaoDias,
      modulosPermitidos: r.modulosPermitidos,
      limites: r.limites,
      recursos: r.recursos,
      destaque: Boolean(r.destaque),
      ativo: r.ativo,
    }));
  }
  if (key === 'payments') {
    const rows = await pg.select().from(schema.payments);
    return rows.map((r) => ({
      id: r.id,
      companyId: r.companyId,
      companyName: r.companyName,
      planoId: r.planoId,
      planoNome: r.planoNome,
      valor: r.valor,
      periodoMeses: r.periodoMeses,
      metodoPagamento: r.metodoPagamento,
      comprovanteReferencia: r.comprovanteReferencia,
      ...(r.comprovanteUrl !== null ? { comprovanteUrl: r.comprovanteUrl } : {}),
      status: r.status,
      solicitadoEm: r.solicitadoEm,
      ...(r.aprovadoEm !== null ? { aprovadoEm: r.aprovadoEm } : {}),
      ...(r.aprovadoPor !== null ? { aprovadoPor: r.aprovadoPor } : {}),
      ...(r.observacoes !== null ? { observacoes: r.observacoes } : {}),
    }));
  }
  if (key === 'auditLogs') {
    const rows = await pg.select().from(schema.auditLogs);
    return rows
      .sort((a, b) => b.timestamp.localeCompare(a.timestamp))
      .map((r) => ({
        id: r.id,
        timestamp: r.timestamp,
        userId: r.userId,
        userEmail: r.userEmail,
        userName: r.userName,
        ...(r.companyId !== null ? { companyId: r.companyId } : {}),
        ...(r.companyName !== null ? { companyName: r.companyName } : {}),
        acao: r.acao,
        detalhes: r.detalhes,
        ...(r.ip !== null ? { ip: r.ip } : {}),
      }));
  }
  if (isPayloadKey(key)) {
    const table = PAYLOAD_TABLES[key];
    const rows = await pg.select({ payload: table.payload }).from(table);
    return rows.map((r: any) => r.payload);
  }
  return [];
}

// ============================================================================
// REQUEST-SCOPED UNIT OF WORK (MULTI-INSTANCE SAFE, NO STALE GLOBAL CACHE)
// ============================================================================

export interface PgRequestContextState {
  data: Partial<DatabaseSchema>;
  loadedKeys: Set<CollectionKey>;
  systemConfigLoaded: boolean;
  initialSystemConfigSnapshot: string;
  initialSnapshots: Map<CollectionKey, Map<string, string>>;
  pendingFlushes: Promise<void>[];
}

const pgContextStorage = new AsyncLocalStorage<PgRequestContextState>();

export function getActivePgContext(): PgRequestContextState | undefined {
  return pgContextStorage.getStore();
}

export async function runWithPgContext<T>(fn: () => Promise<T>): Promise<T> {
  const ctx: PgRequestContextState = {
    data: {},
    loadedKeys: new Set(),
    systemConfigLoaded: false,
    initialSystemConfigSnapshot: '',
    initialSnapshots: new Map(),
    pendingFlushes: [],
  };
  return pgContextStorage.run(ctx, fn);
}

export async function preloadCollectionsIntoContext(
  keys: CollectionKey[],
  includeSystemConfig = false
): Promise<void> {
  const ctx = pgContextStorage.getStore();
  if (!ctx) return;
  const pg = getPgDb();

  if (includeSystemConfig && !ctx.systemConfigLoaded) {
    const rows = await pg.select().from(schema.systemConfig).where(eq(schema.systemConfig.id, 'default'));
    if (rows[0]) {
      const cfg: SystemConfig = {
        nomePlataforma: rows[0].nomePlataforma,
        whatsappComercial: rows[0].whatsappComercial,
        mensagemWhatsappPadrao: rows[0].mensagemWhatsappPadrao,
        diasDemonstracao: rows[0].diasDemonstracao,
        masterEmail: rows[0].masterEmail,
        masterInitialized: rows[0].masterInitialized,
        modoManutencao: rows[0].modoManutencao,
      };
      ctx.data.systemConfig = cfg;
      ctx.initialSystemConfigSnapshot = JSON.stringify(cfg);
      ctx.systemConfigLoaded = true;
    }
  }

  const toLoad = keys.filter((k) => !ctx.loadedKeys.has(k));
  if (toLoad.length === 0) return;

  await Promise.all(
    toLoad.map(async (key) => {
      const items = await readCollectionFromPg(pg, key);
      (ctx.data as any)[key] = items;
      ctx.loadedKeys.add(key);
      const snapMap = new Map<string, string>();
      for (const item of items) {
        if (item && item.id) {
          snapMap.set(item.id, JSON.stringify(item));
        }
      }
      ctx.initialSnapshots.set(key, snapMap);
    })
  );
}

/**
 * Computes deterministic per-row diffs for all collections loaded in the current
 * request context and persists changes atomically inside a PostgreSQL transaction.
 */
export async function flushPgContext(): Promise<void> {
  const ctx = pgContextStorage.getStore();
  if (!ctx) return;

  const pg = getPgDb();
  await pg.transaction(async (tx) => {
    if (ctx.systemConfigLoaded && ctx.data.systemConfig) {
      const nextCfgStr = JSON.stringify(ctx.data.systemConfig);
      if (nextCfgStr !== ctx.initialSystemConfigSnapshot) {
        await upsertSystemConfigInTx(tx, ctx.data.systemConfig);
        ctx.initialSystemConfigSnapshot = nextCfgStr;
      }
    }

    for (const key of ctx.loadedKeys) {
      const currentItems: any[] = ((ctx.data as any)[key] as any[]) || [];
      const initialSnap = ctx.initialSnapshots.get(key) || new Map<string, string>();
      const currentIds = new Set<string>();
      const nextSnap = new Map<string, string>();

      for (const item of currentItems) {
        if (!item || !item.id) continue;
        currentIds.add(item.id);
        const serialized = JSON.stringify(item);
        nextSnap.set(item.id, serialized);
        if (initialSnap.get(item.id) !== serialized) {
          await upsertCollectionItemInTx(tx, key, item);
        }
      }

      const deletedIds: string[] = [];
      for (const oldId of initialSnap.keys()) {
        if (!currentIds.has(oldId)) {
          deletedIds.push(oldId);
        }
      }
      if (deletedIds.length > 0) {
        await deleteCollectionIdsInTx(tx, key, deletedIds);
      }

      ctx.initialSnapshots.set(key, nextSnap);
    }
  });
}

// ============================================================================
// DIRECT TRANSACTIONAL REPOSITORY OPERATIONS (MULTI-INSTANCE SAFE)
// ============================================================================

export const pgRepo = {
  async runInTransaction<T>(fn: (tx: NodePgDatabase<typeof schema>) => Promise<T>): Promise<T> {
    try {
      return await getPgDb().transaction(fn);
    } catch (error) {
      console.error('[pgRepo.runInTransaction] Transaction failed:', error);
      throw new Error('Falha na transação de banco de dados.', { cause: error });
    }
  },

  async createSession(userId: string): Promise<string> {
    try {
      const rawToken = crypto.randomBytes(32).toString('hex');
      const tokenHash = hashSessionToken(rawToken);
      const expiresAt = Date.now() + 7 * 24 * 60 * 60 * 1000;
      await getPgDb().insert(schema.sessions).values({
        tokenHash,
        userId,
        expiresAt,
        revokedAt: null,
      });
      return rawToken;
    } catch (error) {
      console.error('[pgRepo.createSession] Failed:', error);
      throw new Error('Falha ao criar sessão no PostgreSQL.', { cause: error });
    }
  },

  async getSessionUser(token: string): Promise<User | null> {
    if (!token) return null;
    try {
      const tokenHash = hashSessionToken(token);
      const rows = await getPgDb()
        .select({
          session: schema.sessions,
          user: schema.users,
        })
        .from(schema.sessions)
        .innerJoin(schema.users, eq(schema.sessions.userId, schema.users.id))
        .where(and(eq(schema.sessions.tokenHash, tokenHash), isNull(schema.sessions.revokedAt)))
        .limit(1);

      const hit = rows[0];
      if (!hit) return null;

      if (Date.now() > hit.session.expiresAt) {
        await getPgDb()
          .update(schema.sessions)
          .set({ revokedAt: Date.now() })
          .where(eq(schema.sessions.tokenHash, tokenHash));
        return null;
      }

      if (!hit.user.active) return null;

      return {
        id: hit.user.id,
        email: hit.user.email,
        name: hit.user.name,
        passwordHash: hit.user.passwordHash,
        salt: hit.user.salt,
        role: hit.user.role as User['role'],
        companyId: hit.user.companyId,
        ...(hit.user.phone !== null ? { phone: hit.user.phone } : {}),
        active: hit.user.active,
        createdAt: hit.user.createdAt,
      };
    } catch (error) {
      console.error('[pgRepo.getSessionUser] Failed:', error);
      throw new Error('Falha ao validar sessão no PostgreSQL.', { cause: error });
    }
  },

  async destroySession(token: string): Promise<void> {
    if (!token) return;
    try {
      const tokenHash = hashSessionToken(token);
      await getPgDb()
        .update(schema.sessions)
        .set({ revokedAt: Date.now() })
        .where(eq(schema.sessions.tokenHash, tokenHash));
    } catch (error) {
      console.error('[pgRepo.destroySession] Failed:', error);
      throw new Error('Falha ao encerrar sessão no PostgreSQL.', { cause: error });
    }
  },

  async revokeAllUserSessions(userId: string): Promise<void> {
    try {
      await getPgDb()
        .update(schema.sessions)
        .set({ revokedAt: Date.now() })
        .where(and(eq(schema.sessions.userId, userId), isNull(schema.sessions.revokedAt)));
    } catch (error) {
      console.error('[pgRepo.revokeAllUserSessions] Failed:', error);
      throw new Error('Falha ao revogar sessões do usuário.', { cause: error });
    }
  },

  async findUserByEmail(email: string): Promise<User | null> {
    try {
      const normalized = email.trim().toLowerCase();
      const rows = await getPgDb()
        .select()
        .from(schema.users)
        .where(sql`lower(${schema.users.email}) = ${normalized}`)
        .limit(1);
      const r = rows[0];
      if (!r) return null;
      return {
        id: r.id,
        email: r.email,
        name: r.name,
        passwordHash: r.passwordHash,
        salt: r.salt,
        role: r.role as User['role'],
        companyId: r.companyId,
        ...(r.phone !== null ? { phone: r.phone } : {}),
        active: r.active,
        createdAt: r.createdAt,
      };
    } catch (error) {
      console.error('[pgRepo.findUserByEmail] Failed:', error);
      throw new Error('Falha ao consultar usuário.', { cause: error });
    }
  },

  async getCompanyById(companyId: string): Promise<Company | null> {
    try {
      const rows = await getPgDb()
        .select()
        .from(schema.companies)
        .where(eq(schema.companies.id, companyId))
        .limit(1);
      const r = rows[0];
      if (!r) return null;
      return {
        id: r.id,
        razaoSocial: r.razaoSocial,
        nomeFantasia: r.nomeFantasia,
        ...(r.cnpj !== null ? { cnpj: r.cnpj } : {}),
        responsavel: r.responsavel,
        email: r.email,
        telefone: r.telefone,
        endereco: r.endereco,
        segmento: r.segmento,
        quantidadeFuncionarios: r.quantidadeFuncionarios,
        tipoOperacao: r.tipoOperacao as Company['tipoOperacao'],
        modulos: r.modulos as Company['modulos'],
        planoId: r.planoId,
        statusCadastro: r.statusCadastro as Company['statusCadastro'],
        statusAssinatura: r.statusAssinatura as Company['statusAssinatura'],
        ...(r.demoStartDate !== null ? { demoStartDate: r.demoStartDate } : {}),
        ...(r.demoEndDate !== null ? { demoEndDate: r.demoEndDate } : {}),
        ...(r.subscriptionStartDate !== null
          ? { subscriptionStartDate: r.subscriptionStartDate }
          : {}),
        ...(r.subscriptionEndDate !== null ? { subscriptionEndDate: r.subscriptionEndDate } : {}),
        limites: r.limites,
        createdAt: r.createdAt,
        updatedAt: r.updatedAt,
      };
    } catch (error) {
      console.error('[pgRepo.getCompanyById] Failed:', error);
      throw new Error('Falha ao consultar empresa.', { cause: error });
    }
  },

  async logAudit(entry: Omit<AuditLog, 'id' | 'timestamp'>): Promise<AuditLog> {
    try {
      const fullEntry: AuditLog = {
        id: crypto.randomUUID(),
        timestamp: new Date().toISOString(),
        ...entry,
      };
      await getPgDb().insert(schema.auditLogs).values({
        id: fullEntry.id,
        timestamp: fullEntry.timestamp,
        userId: fullEntry.userId,
        userEmail: fullEntry.userEmail,
        userName: fullEntry.userName,
        companyId: fullEntry.companyId ?? null,
        companyName: fullEntry.companyName ?? null,
        acao: fullEntry.acao,
        detalhes: fullEntry.detalhes,
        ip: fullEntry.ip ?? null,
      });
      return fullEntry;
    } catch (error) {
      console.error('[pgRepo.logAudit] Failed:', error);
      throw new Error('Falha ao gravar log de auditoria.', { cause: error });
    }
  },

  /**
   * Concurrency-safe commercial stock adjustment using PostgreSQL row locking (FOR UPDATE)
   * inside a serializable/read-committed transaction.
   */
  async adjustCommercialStockAtomic(params: {
    companyId: string;
    productId: string;
    delta: number;
    tipo: CommercialStockMovement['tipo'];
    motivo: string;
    usuarioId: string;
    usuarioNome: string;
    referenciaId?: string;
    allowNegative?: boolean;
  }): Promise<{ product: CommercialProduct; movement: CommercialStockMovement }> {
    return await getPgDb().transaction(async (tx) => {
      const rows = await tx
        .select()
        .from(schema.commercialProducts)
        .where(
          and(
            eq(schema.commercialProducts.id, params.productId),
            eq(schema.commercialProducts.companyId, params.companyId)
          )
        )
        .for('update');

      if (!rows[0]) {
        throw new Error('Produto comercial não encontrado para esta empresa.');
      }

      const product = rows[0].payload as CommercialProduct;
      const anterior = Number(product.estoqueAtual || 0);
      const novo = anterior + params.delta;

      if (!params.allowNegative && novo < 0) {
        throw new Error(
          `Estoque insuficiente para ${product.nome} (disponível: ${anterior}, solicitado: ${Math.abs(params.delta)}).`
        );
      }

      const updatedProduct: CommercialProduct = {
        ...product,
        estoqueAtual: novo,
        atualizadoEm: new Date().toISOString(),
      };

      const movement: CommercialStockMovement = {
        id: crypto.randomUUID(),
        companyId: params.companyId,
        productId: product.id,
        productNome: product.nome,
        modulo: product.modulo,
        tipo: params.tipo,
        quantidade: Math.abs(params.delta),
        quantidadeAnterior: anterior,
        quantidadeNova: novo,
        motivo: params.motivo,
        usuarioId: params.usuarioId,
        usuarioNome: params.usuarioNome,
        ...(params.referenciaId ? { referenciaId: params.referenciaId } : {}),
        criadoEm: new Date().toISOString(),
      };

      await upsertCollectionItemInTx(tx, 'commercialProducts', updatedProduct);
      await upsertCollectionItemInTx(tx, 'commercialStockMovements', movement);

      return { product: updatedProduct, movement };
    });
  },

  /**
   * Atomically updates passwordHash & salt exclusively for the original MASTER_OWNER user,
   * revokes all existing active sessions for that user only, and writes a sanitized audit log.
   */
  async recoverMasterOwnerPasswordAtomic(params: {
    masterId: string;
    expectedEmail: string;
    passwordHash: string;
    salt: string;
    auditIp?: string;
    auditDetalhes: string;
  }): Promise<Pick<User, 'id' | 'email' | 'name' | 'role' | 'active'>> {
    return await getPgDb().transaction(async (tx) => {
      const rows = await tx
        .select()
        .from(schema.users)
        .where(eq(schema.users.id, params.masterId))
        .for('update');

      const master = rows[0];
      if (!master) {
        const err = new Error('Conta original de Master Owner não localizada.') as Error & {
          statusCode?: number;
        };
        err.statusCode = 404;
        throw err;
      }

      if (
        master.role !== 'master_owner' ||
        master.email.trim().toLowerCase() !== params.expectedEmail.trim().toLowerCase()
      ) {
        const err = new Error('Registro incompatível com a conta original de Master Owner.') as Error & {
          statusCode?: number;
        };
        err.statusCode = 403;
        throw err;
      }

      if (!master.active) {
        const err = new Error('A conta Master Owner está inativa e não pode ser recuperada.') as Error & {
          statusCode?: number;
        };
        err.statusCode = 403;
        throw err;
      }

      await tx
        .update(schema.users)
        .set({
          passwordHash: params.passwordHash,
          salt: params.salt,
        })
        .where(
          and(
            eq(schema.users.id, master.id),
            eq(schema.users.role, 'master_owner')
          )
        );

      await tx
        .update(schema.sessions)
        .set({ revokedAt: Date.now() })
        .where(and(eq(schema.sessions.userId, master.id), isNull(schema.sessions.revokedAt)));

      await tx.insert(schema.auditLogs).values({
        id: crypto.randomUUID(),
        timestamp: new Date().toISOString(),
        userId: master.id,
        userEmail: master.email,
        userName: master.name,
        companyId: null,
        companyName: null,
        acao: 'RECUPERACAO_MASTER',
        detalhes: params.auditDetalhes,
        ip: params.auditIp ?? null,
      });

      return {
        id: master.id,
        email: master.email,
        name: master.name,
        role: master.role as User['role'],
        active: master.active,
      };
    });
  },
};

/**
 * Route-to-collections resolver so PostgreSQL requests load ONLY the tables
 * relevant to the endpoint (never loading unused collections unless required).
 */
export function resolveCollectionsForRoute(path: string): {
  keys: CollectionKey[];
  includeSystemConfig: boolean;
} {
  if (path.startsWith('/auth/')) {
    return {
      keys: ['users', 'companies', 'plans', 'auditLogs'],
      includeSystemConfig: true,
    };
  }
  if (path.startsWith('/master/') || path.startsWith('/subscription/') || path === '/plans') {
    return {
      keys: ['users', 'companies', 'plans', 'payments', 'auditLogs', 'notifications'],
      includeSystemConfig: true,
    };
  }
  if (path.startsWith('/logistics/')) {
    return {
      keys: ['logisticsReceipts', 'inventory', 'stockMovements', 'shipments', 'notifications', 'auditLogs', 'companies'],
      includeSystemConfig: false,
    };
  }
  if (path.startsWith('/condo/')) {
    return {
      keys: ['condoUnits', 'condoPackages', 'condoVisitors', 'notifications', 'auditLogs', 'companies'],
      includeSystemConfig: false,
    };
  }
  if (path.startsWith('/deliveries') || path.startsWith('/fleet/') || path.startsWith('/routes') || path.startsWith('/driver/')) {
    return {
      keys: ['deliveries', 'vehicles', 'routes', 'users', 'notifications', 'auditLogs', 'companies'],
      includeSystemConfig: false,
    };
  }
  if (path.startsWith('/fiscal/') || path.startsWith('/financial/')) {
    return {
      keys: ['fiscalConfigs', 'fiscalDocuments', 'financialRecords', 'deliveries', 'shipments', 'routes', 'vehicles', 'companies', 'notifications', 'auditLogs'],
      includeSystemConfig: false,
    };
  }
  if (path.startsWith('/commerce/')) {
    return {
      keys: [
        'commercialProducts',
        'commercialStockMovements',
        'commercialSales',
        'commercialCashSessions',
        'commercialSuppliers',
        'commercialPurchases',
        'pixCharges',
        'commercialTerminals',
        'commercialTerminalTransactions',
        'companies',
        'notifications',
        'auditLogs',
      ],
      includeSystemConfig: false,
    };
  }
  if (path.startsWith('/warehouses') || path.startsWith('/fulfillment')) {
    return {
      keys: [
        'warehouses',
        'warehouseTransfers',
        'warehouseAudits',
        'fulfillmentOrders',
        'pickingTasks',
        'packingTasks',
        'reverseLogistics',
        'shippingManifests',
        'inventory',
        'stockMovements',
        'carrierPartners',
        'b2bClients',
        'b2bCollections',
        'companies',
        'notifications',
        'auditLogs',
      ],
      includeSystemConfig: false,
    };
  }
  if (path.startsWith('/company/')) {
    return {
      keys: ['companies', 'users', 'plans', 'auditLogs'],
      includeSystemConfig: false,
    };
  }
  if (path.startsWith('/tracking/public')) {
    return {
      keys: ['deliveries', 'shipments', 'routes', 'fulfillmentOrders', 'condoPackages'],
      includeSystemConfig: false,
    };
  }
  if (path.startsWith('/notifications')) {
    return {
      keys: ['notifications'],
      includeSystemConfig: false,
    };
  }
  // /dashboard/metrics, /prevention/*, /seed-sample-data need broad operational visibility
  return {
    keys: [...ALL_COLLECTION_KEYS],
    includeSystemConfig: true,
  };
}

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import {
  flushPgContext,
  getActivePgContext,
  isPostgresActive,
  pgRepo,
} from './persistence/repository.ts';

const DATA_DIR = process.env.MOVILOG_DATA_DIR
  ? path.resolve(process.env.MOVILOG_DATA_DIR)
  : path.resolve(process.cwd(), 'data');
const DB_FILE = path.resolve(DATA_DIR, 'db.json');

// Ensure data directory exists when running in JSON mode
if (!isPostgresActive() && !fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

export interface User {
  id: string;
  email: string;
  name: string;
  passwordHash: string;
  salt: string;
  role: 'master_owner' | 'company_admin' | 'dispatcher' | 'driver' | 'operator' | 'concierge' | 'financial' | 'client' | 'viewer';
  companyId: string | null;
  phone?: string;
  active: boolean;
  createdAt: string;
}

export interface Company {
  id: string;
  razaoSocial: string;
  nomeFantasia: string;
  cnpj?: string;
  responsavel: string;
  email: string;
  telefone: string;
  endereco: string;
  segmento: string;
  quantidadeFuncionarios: number;
  tipoOperacao: 'logistica' | 'expedicao' | 'predial' | 'integrada';
  modulos: ('logistica' | 'roteirizacao' | 'frota' | 'predial')[];
  planoId: string;
  statusCadastro: 'ativo' | 'pendente' | 'suspenso' | 'encerrado';
  statusAssinatura: 'demo_ativa' | 'demo_expirada' | 'aguardando_pagamento' | 'pagamento_em_analise' | 'assinatura_ativa' | 'assinatura_vencida' | 'suspensa' | 'cancelada';
  demoStartDate?: string;
  demoEndDate?: string;
  subscriptionStartDate?: string;
  subscriptionEndDate?: string;
  limites: {
    maxUsuarios: number;
    maxUnidades: number;
    maxOperacoesMes: number;
  };
  createdAt: string;
  updatedAt: string;
}

export interface CommercialPlan {
  id: string;
  nome: string;
  tipo: 'demo' | 'essencial' | 'profissional' | 'empresarial' | 'personalizado';
  descricao: string;
  precoMensal: number;
  precoAnual: number;
  duracaoDias: number;
  modulosPermitidos: ('logistica' | 'predial')[];
  limites: {
    maxUsuarios: number;
    maxUnidades: number;
    maxOperacoesMes: number;
  };
  recursos: string[];
  destaque?: boolean;
  ativo: boolean;
}

export interface SystemConfig {
  nomePlataforma: string;
  whatsappComercial: string;
  mensagemWhatsappPadrao: string;
  diasDemonstracao: number;
  masterEmail: string;
  masterInitialized: boolean;
  modoManutencao: boolean;
}

export interface PaymentRequest {
  id: string;
  companyId: string;
  companyName: string;
  planoId: string;
  planoNome: string;
  valor: number;
  periodoMeses: number;
  metodoPagamento: string;
  comprovanteReferencia: string;
  comprovanteUrl?: string;
  status: 'pendente' | 'aprovado' | 'rejeitado';
  solicitadoEm: string;
  aprovadoEm?: string;
  aprovadoPor?: string;
  observacoes?: string;
}

export interface AuditLog {
  id: string;
  timestamp: string;
  userId: string;
  userEmail: string;
  userName: string;
  companyId?: string | null;
  companyName?: string;
  acao: string;
  detalhes: string;
  ip?: string;
}

// Logistics Models
export interface LogisticsReceipt {
  id: string;
  companyId: string;
  numeroRecebimento: string;
  fornecedor: string;
  remetente: string;
  transportadora: string;
  destinatarioSetor: string;
  numeroNota?: string;
  quantidadeVolumes: number;
  pesoKg: number;
  descricao: string;
  lote?: string;
  avariasRegistradas: boolean;
  detalhesAvarias?: string;
  conferenteNome: string;
  status: 'conferido' | 'divergencia' | 'armazenado';
  codigoRastreioQR: string;
  dataHora: string;
}

export interface InventoryItem {
  id: string;
  companyId: string;
  sku: string;
  nome: string;
  categoria: string;
  quantidade: number;
  estoqueMinimo: number;
  unidadeMedida: string;
  setor: string;
  corredor: string;
  posicao: string;
  valorUnitario: number;
  ultimaMovimentacao: string;
}

export interface StockMovement {
  id: string;
  companyId: string;
  itemId: string;
  itemNome: string;
  sku: string;
  tipo: 'entrada' | 'saida' | 'transferencia' | 'ajuste';
  quantidade: number;
  saldoAnterior: number;
  saldoAtual: number;
  motivo: string;
  origem?: string;
  destino?: string;
  responsavelNome: string;
  dataHora: string;
}

export interface ShipmentOrder {
  id: string;
  companyId: string;
  numeroExpedicao: string;
  destinatario: string;
  enderecoEntrega: string;
  cidade: string;
  transportadora: string;
  entregadorNome?: string;
  placaVeiculo?: string;
  volumes: number;
  pesoKg: number;
  status: 'separacao' | 'conferido' | 'despachado' | 'entregue' | 'ocorrencia';
  codigoRastreio: string;
  responsavelDespacho: string;
  dataCriacao: string;
  dataDespacho?: string;
  dataEntrega?: string;
  comprovanteEntrega?: string;
  ocorrenciaTexto?: string;
}

// Condo & Gatekeeper Models
export interface CondoUnit {
  id: string;
  companyId: string;
  bloco: string;
  andar: string;
  numeroUnidade: string; // Ex: Apto 101, Sala 402
  responsavelPrincipal: string;
  email: string;
  telefone: string;
  moradores: { nome: string; parentesco: string; telefone: string }[];
  observacoes?: string;
  ativo: boolean;
}

export interface CondoPackage {
  id: string;
  companyId: string;
  codigoPacote: string; // Ex: LP-7294
  unitId: string;
  unidadeIdentificacao: string; // Ex: Bloco A - Apto 302
  destinatarioNome: string;
  transportadora: string;
  nomeEntregador?: string;
  descricaoConteudo: string;
  codigoRetiradaPin: string; // PIN de 4 a 6 dígitos
  status: 'aguardando_retirada' | 'notificado' | 'retirado' | 'devolvido' | 'em_ocorrencia';
  recebidoPorPorteiro: string;
  recebidoEm: string;
  entreguePorPorteiro?: string;
  notificadoEm?: string;
  retiradoEm?: string;
  retiradoPor?: string;
  documentoRetirada?: string;
  fotoComprovante?: string;
  observacoes?: string;
}

export interface CondoVisitor {
  id: string;
  companyId: string;
  nomeCompleto: string;
  documento: string; // RG ou CPF
  tipo: 'visitante' | 'prestador_servico' | 'entregador' | 'corretor';
  empresa?: string;
  unidadeDestino: string;
  moradorAutorizador: string;
  porteiroEntrada: string;
  dataHoraEntrada: string;
  dataHoraSaida?: string;
  status: 'no_local' | 'finalizado';
  observacoes?: string;
}

export interface DeliveryItem {
  id: string;
  companyId: string;
  codigoRastreio: string; // Ex: DLV-2026-001
  destinatario: string;
  cliente?: string;
  telefone: string;
  email?: string;
  endereco: string;
  numero: string;
  complemento?: string;
  bairro: string;
  cidade: string;
  estado?: string;
  cep: string;
  referencia?: string;
  instrucoes?: string;
  volumes: number;
  pesoKg: number;
  valorMercadoria?: number;
  prioridade: 'baixa' | 'media' | 'alta' | 'urgente';
  prazoEntrega: string;
  janelaHorarioInicio?: string;
  janelaHorarioFim?: string;
  lat?: number;
  lng?: number;
  geocodificado: boolean;
  geocodificacaoStatus?: 'ok' | 'aproximado' | 'pendente' | 'falha';
  status: 'pendente' | 'planejada' | 'em_rota' | 'entregue' | 'tentativa_falha' | 'cancelada';
  routeId?: string;
  sequencia?: number;
  motoristaId?: string;
  motoristaNome?: string;
  veiculoId?: string;
  veiculoPlaca?: string;
  tentativas: number;
  motivoFalha?: string;
  recebedorNome?: string;
  recebedorDocumento?: string;
  comprovanteFoto?: string;
  entregueEm?: string;
  observacoes?: string;
  origemImportacao: 'manual' | 'planilha_csv' | 'planilha_excel' | 'expedicao_interna';
  criadoEm: string;
  atualizadoEm: string;
}

export interface Vehicle {
  id: string;
  companyId: string;
  placa: string;
  identificacao: string; // Ex: Fiorino Express 01
  categoria: 'moto' | 'fiorino' | 'van' | 'caminhao_leve' | 'caminhao_pesado' | 'utilitario';
  tipoPropriedade: 'proprio' | 'terceirizado' | 'agregado';
  capacidadeKg: number;
  capacidadeVolumes: number;
  motoristaVinculadoId?: string;
  motoristaVinculadoNome?: string;
  statusOperacional: 'disponivel' | 'em_rota' | 'manutencao' | 'inativo';
  tipoRastreamento: 'app_gps' | 'rastreador_externo' | 'manual';
  ultimaLocalizacao?: {
    lat: number;
    lng: number;
    velocidade?: number;
    precisao?: number;
    atualizadoEm: string;
    timestampDispositivo?: string;
    recebidoEm?: string;
    origem?: string;
    bateria?: number;
    status: 'online' | 'recente' | 'offline';
  };
  historicoViagensCount: number;
  criadoEm: string;
}

export interface RouteStop {
  ordem: number;
  deliveryId: string;
  codigoRastreio: string;
  destinatario: string;
  telefone: string;
  enderecoCompleto: string;
  bairro: string;
  cidade: string;
  cep: string;
  lat?: number;
  lng?: number;
  volumes: number;
  pesoKg: number;
  prioridade: string;
  janelaHorario?: string;
  instrucoes?: string;
  status: 'aguardando' | 'chegou' | 'entregue' | 'tentativa_falha' | 'pulada';
  horarioChegada?: string;
  horarioConclusao?: string;
  motivoFalha?: string;
  recebedorNome?: string;
  recebedorDocumento?: string;
  observacaoEntregador?: string;
}

export interface DeliveryRoute {
  id: string;
  companyId: string;
  codigoRota: string; // Ex: ROT-001
  titulo: string;
  versao: number;
  status: 'em_preparacao' | 'em_revisao' | 'publicada' | 'em_andamento' | 'concluida' | 'cancelada';
  veiculoId: string;
  veiculoPlaca: string;
  veiculoIdentificacao: string;
  motoristaId: string;
  motoristaNome: string;
  motoristaTelefone?: string;
  roteiristaId: string;
  roteiristaNome: string;
  totalParadas: number;
  totalVolumes: number;
  totalPesoKg: number;
  distanciaEstimadaKm: number;
  tempoEstimadoMinutos: number;
  distanciaRealKm?: number;
  tempoRealMinutos?: number;
  cidades: string[];
  bairros: string[];
  paradas: RouteStop[];
  criadaEm: string;
  publicadaEm?: string;
  iniciadaEm?: string;
  concluidaEm?: string;
  historicoAlteracoes: {
    versao: number;
    alteradoPor: string;
    dataHora: string;
    motivo: string;
  }[];
}

// Fiscal & Tax Models
export interface FiscalConfig {
  id: string;
  companyId: string;
  cnpj: string;
  razaoSocial: string;
  nomeFantasia: string;
  inscricaoEstadual: string;
  inscricaoMunicipal: string;
  regimeTributario: 'simples_nacional' | 'lucro_presumido' | 'lucro_real';
  cnaePrincipal?: string;
  enderecoFiscal: string;
  numero: string;
  bairro: string;
  cidade: string;
  uf: string;
  cep: string;
  ambiente: 'homologacao' | 'producao';
  serieNFe: number;
  proximoNumeroNFe: number;
  serieCTe: number;
  proximoNumeroCTe: number;
  serieMDFe: number;
  proximoNumeroMDFe: number;
  serieNFSe: number;
  proximoNumeroNFSe: number;
  certificadoStatus: 'valido' | 'pendente' | 'vencido';
  certificadoValidade?: string;
  provedorIntegracao: 'simulador_homologacao' | 'focus_nfe' | 'nuvem_fiscal' | 'sefaz_direta';
  apiKeyProvedor?: string;
  atualizadoEm: string;
}

export interface FiscalItem {
  itemNumero: number;
  descricao: string;
  ncm: string;
  cfop: string;
  quantidade: number;
  unidadeMedida: string;
  valorUnitario: number;
  valorTotal: number;
  aliquotaICMS: number;
  valorICMS: number;
}

export interface FiscalDocument {
  id: string;
  companyId: string;
  tipo: 'nfe' | 'nfce' | 'nfse' | 'cte' | 'mdfe';
  numero: number;
  serie: number;
  chaveAcesso: string; // 44 digits
  status: 'autorizado' | 'rejeitado' | 'cancelado' | 'contingencia' | 'processando';
  dataEmissao: string;
  protocoloAutorizacao: string;
  ambiente: 'homologacao' | 'producao';
  emitenteCNPJ: string;
  emitenteRazao: string;
  emitenteUF: string;
  destinatarioNome: string;
  destinatarioDocumento: string;
  destinatarioEndereco: string;
  destinatarioCidade: string;
  destinatarioUF: string;
  destinatarioCEP: string;
  naturezaOperacao: string;
  cfop: string;
  itens: FiscalItem[];
  valorTotalProdutos: number;
  valorFrete: number;
  valorSeguro: number;
  valorOutros: number;
  baseCalculoICMS: number;
  valorICMS: number;
  baseCalculoISS?: number;
  valorISS?: number;
  valorTotal: number;
  deliveryId?: string;
  shipmentId?: string;
  xmlConteudo: string;
  motivoCancelamento?: string;
  eventos: {
    id: string;
    tipo: 'autorizacao' | 'cancelamento' | 'carta_correcao';
    dataHora: string;
    protocolo: string;
    motivo: string;
    usuario: string;
  }[];
  criadoEm: string;
}

// Financial & Cost Analysis Models
export interface FinancialRecord {
  id: string;
  companyId: string;
  tipo: 'receita' | 'despesa';
  categoria: 'frete' | 'combustivel' | 'manutencao' | 'pedagio' | 'salario' | 'seguro' | 'aluguel_armazem' | 'outros';
  descricao: string;
  valor: number;
  dataCompetencia: string;
  status: 'pendente' | 'pago' | 'conciliado';
  routeId?: string;
  vehicleId?: string;
  deliveryId?: string;
  fiscalDocId?: string;
  comprovanteRef?: string;
  observacoes?: string;
  criadoEm: string;
}

// Global Operational Notifications
export interface NotificationItem {
  id: string;
  companyId?: string | null;
  tipo: 'entrega' | 'fiscal' | 'frota' | 'portaria' | 'sistema' | 'comercio';
  titulo: string;
  mensagem: string;
  lida: boolean;
  prioridade: 'baixa' | 'media' | 'alta' | 'urgente';
  link?: string;
  dataHora: string;
}

// ==========================================
// Adega & Tabacaria Commercial Models
// ==========================================

export interface CommercialProduct {
  id: string;
  companyId: string;
  modulo: 'adega' | 'tabacaria';
  sku: string;
  codigoBarras?: string;
  nome: string;
  categoria: string;
  classificacaoLegal?: 'sem_restricao' | 'bebida_alcoolica' | 'tabaco_derivados' | 'outro_restrito';
  descricao?: string;
  marca?: string;
  fornecedorId?: string;
  fornecedorNome?: string;
  precoCusto: number;
  precoVenda: number;
  estoqueAtual: number;
  estoqueMinimo: number;
  unidade: string;
  fotoUrl?: string;
  idadeMinima: number;
  ativo: boolean;
  criadoEm: string;
  atualizadoEm: string;
}

export interface CommercialStockMovement {
  id: string;
  companyId: string;
  productId: string;
  productNome: string;
  modulo: 'adega' | 'tabacaria';
  tipo: 'entrada_compra' | 'saida_venda' | 'ajuste_manual' | 'perda_avaria' | 'vencimento' | 'devolucao';
  quantidade: number;
  quantidadeAnterior: number;
  quantidadeNova: number;
  motivo: string;
  usuarioId: string;
  usuarioNome: string;
  referenciaId?: string;
  criadoEm: string;
}

export interface CommercialSaleItem {
  productId: string;
  sku: string;
  nome: string;
  categoria: string;
  quantidade: number;
  precoUnitario: number;
  precoCusto: number;
  subtotal: number;
  desconto: number;
  total: number;
}

export interface CommercialSale {
  id: string;
  codigoVenda: string;
  companyId: string;
  modulo: 'adega' | 'tabacaria' | 'misto';
  itens: CommercialSaleItem[];
  subtotal: number;
  descontoTotal: number;
  valorTotal: number;
  custoTotalEstimado: number;
  lucroBrutoEstimado: number;
  formaPagamento: 'dinheiro' | 'pix' | 'cartao_credito' | 'cartao_debito' | 'misto';
  valorPago?: number;
  troco?: number;
  caixaSessionId?: string;
  status: 'concluida' | 'cancelada';
  motivoCancelamento?: string;
  clienteNome?: string;
  clienteDocumento?: string;
  verificacaoMaioridade: boolean;
  operadorId: string;
  operadorNome: string;
  criadoEm: string;
  canceladoEm?: string;
  canceladoPor?: string;
  detalhesPagamento?: {
    forma: 'dinheiro' | 'pix' | 'cartao_credito' | 'cartao_debito' | 'misto';
    valorRecebido?: number;
    troco?: number;
    pixTxid?: string;
    pixCopiaECola?: string;
    pixConfirmadoEm?: string;
    pixProvedor?: string;
    metodoConfirmacao?: string;
    cartaoBandeira?: string;
    cartaoAutorizacao?: string;
    confirmacaoManual?: boolean;
    comprovanteReferencia?: string;
    nsu?: string;
    paymentIntentId?: string;
    transactionId?: string;
    terminalId?: string;
    terminalNome?: string;
    [key: string]: any;
  };
  idempotencyKey?: string;
}

export interface CashMovement {
  id: string;
  tipo: 'suprimento' | 'sangria';
  valor: number;
  motivo: string;
  autorizadoPor: string;
  dataHora: string;
}

export interface CommercialCashSession {
  id: string;
  codigoSessao: string;
  companyId: string;
  modulo: 'adega' | 'tabacaria' | 'geral';
  operadorId: string;
  operadorNome: string;
  status: 'aberto' | 'fechado';
  abertoEm: string;
  fechadoEm?: string;
  saldoInicial: number;
  suprimentos: number;
  sangrias: number;
  totalVendasDinheiro: number;
  totalVendasPix: number;
  totalVendasCartao: number;
  totalVendasCartaoDebito?: number;
  totalVendasCartaoCredito?: number;
  totalCancelamentosDinheiro?: number;
  totalVendasOutros: number;
  saldoEsperadoDinheiro: number;
  saldoContadoDinheiro?: number;
  diferenca?: number;
  observacoesFechamento?: string;
  fechadoPorId?: string;
  fechadoPorNome?: string;
  movimentacoesManuais: CashMovement[];
}

export interface PixCharge {
  id: string;
  companyId: string;
  modulo: 'adega' | 'tabacaria' | 'misto';
  txid: string;
  valor: number;
  chavePix: string;
  beneficiario: string;
  cidade: string;
  copiaECola: string;
  qrCodeDataUrl: string;
  qrCodePayload?: string;
  endToEndId?: string;
  status: 'aguardando_pagamento' | 'pago' | 'expirado' | 'cancelado' | 'falhou';
  provedor: 'bacen_estatico' | 'mercadopago' | 'efi' | 'manual';
  criadoEm: string;
  expiraEm: string;
  confirmadoEm?: string;
  confirmadoPor?: string;
  metodoConfirmacao?: 'webhook_provedor' | 'conferencia_manual_operador' | 'consulta_api';
  comprovanteReferencia?: string;
  idempotencyKey?: string;
}

export interface CommercialSupplier {
  id: string;
  companyId: string;
  razaoSocial: string;
  nomeFantasia: string;
  cnpjCpf: string;
  contatoNome: string;
  telefone: string;
  email: string;
  endereco?: string;
  segmento: 'adega' | 'tabacaria' | 'ambos';
  observacoes?: string;
  ativo: boolean;
  criadoEm: string;
}

export interface CommercialPurchaseItem {
  productId: string;
  nome: string;
  quantidade: number;
  custoUnitario: number;
  total: number;
}

export interface CommercialPurchase {
  id: string;
  companyId: string;
  fornecedorId: string;
  fornecedorNome: string;
  numeroNota?: string;
  dataCompra: string;
  dataRecebimento?: string;
  status: 'pendente' | 'recebido' | 'cancelado';
  itens: CommercialPurchaseItem[];
  valorTotal: number;
  formaPagamento?: string;
  observacoes?: string;
  criadoEm: string;
}

export type TerminalProvider = 'mercadopago_point' | 'stone_connect' | 'pagar_me' | 'smartpos_tef' | 'pos_manual';

export interface CommercialTerminalCredentials {
  mpAccessToken?: string;
  mpPublicKey?: string;
  stonePartnerKey?: string;
  stoneSecretKey?: string;
  stoneMerchantId?: string;
  tefHost?: string;
  tefPort?: number;
  tefApiKey?: string;
  webhookSecret?: string;
}

export interface CommercialTerminal {
  id: string;
  companyId: string;
  nome: string;
  provedor: TerminalProvider;
  modelo: string;
  tipoEquipamento: 'smart_pos' | 'pos_gprs' | 'tef_pinpad' | 'pos_manual';
  identificadorProvedor: string;
  serialNumber?: string;
  modulo: 'adega' | 'tabacaria' | 'ambos';
  caixaIdPadrao?: string;
  padrao: boolean;
  ativo: boolean;
  statusConexao: 'online' | 'offline' | 'desconhecido';
  ultimaSincronizacao?: string;
  bateriaNivel?: number;
  modoOperacao: 'cloud_api' | 'smart_pos_app' | 'tef_integrado' | 'manual_operador';
  credenciais?: CommercialTerminalCredentials;
  taxaDebitoPercentual?: number;
  taxaCreditoPercentual?: number;
  taxaPixPercentual?: number;
  criadoEm: string;
  atualizadoEm: string;
  ultimoTesteEm?: string;
  ultimoResultadoTeste?: {
    sucesso: boolean;
    mensagem: string;
    detalhes?: any;
    dataHora: string;
  };
}

export type TerminalTransactionStatus = 'pendente' | 'processando' | 'aprovado' | 'recusado' | 'cancelado' | 'estornado' | 'falha_comunicacao';

export interface CommercialTerminalTransaction {
  id: string;
  companyId: string;
  terminalId: string;
  terminalNome: string;
  provedor: TerminalProvider;
  modeloTerminal?: string;
  modulo: 'adega' | 'tabacaria' | 'misto';
  saleId?: string;
  codigoVenda?: string;
  caixaSessionId?: string;
  tipoOperacao: 'debito' | 'credito' | 'pix';
  bandeira?: string;
  ultimosDigitosCartao?: string;
  valorBruto: number;
  taxaPercentualAplicada: number;
  valorTaxaEstimada: number;
  valorLiquido: number;
  status: TerminalTransactionStatus;
  nsu?: string;
  codigoAutorizacao?: string;
  paymentIntentId?: string;
  externalReference?: string;
  mensagemProvedor?: string;
  detalhesTecnicos?: any;
  criadoEm: string;
  concluidoEm?: string;
  canceladoEm?: string;
  estornadoEm?: string;
  conciliado: boolean;
  conciliadoEm?: string;
  divergenciaConciliacao?: string;
  idempotencyKey?: string;
}

export interface PreventionResolvedAlert {
  id: string;
  companyId: string;
  tipo: string;
  referenciaId: string;
  motivoResolucao: string;
  resolvidoPorId: string;
  resolvidoPorNome: string;
  resolvidoEm: string;
}

// ============================================================================
// ENTERPRISE LOGISTICS ECOSYSTEM — WAREHOUSING, FULFILLMENT & CONTROL TOWER
// ============================================================================

export type WarehouseType = 'matriz' | 'filial' | 'cross_docking' | 'dark_store' | 'hub_urbano';
export type PositionStorageType = 'palete' | 'picking' | 'pulmao' | 'blocado' | 'refrigerado';

export interface WarehousePosition {
  id: string;
  codigo: string;
  rua: string;
  corredor: string;
  prateleira: string;
  nivel: string;
  tipoArmazenagem: PositionStorageType;
  capacidadeKg: number;
  capacidadeVolumes: number;
  ocupadoKg: number;
  ocupadoVolumes: number;
  qrCode: string;
  status: 'disponivel' | 'ocupado' | 'bloqueado' | 'manutencao';
  itemIdAlocado?: string;
  itemNomeAlocado?: string;
  skuAlocado?: string;
  quantidadeAlocada?: number;
  enderecoCompleto?: string;
}

export interface WarehouseCD {
  id: string;
  companyId: string;
  codigo: string;
  nome: string;
  tipo: WarehouseType;
  cnpj?: string;
  responsavelNome: string;
  responsavelTelefone: string;
  responsavelEmail: string;
  endereco: string;
  numero: string;
  complemento?: string;
  bairro: string;
  cidade: string;
  estado: string;
  cep: string;
  capacidadeTotalVolumes: number;
  capacidadeTotalKg: number;
  areaMetrosQuadrados?: number;
  totalPosicoesCadastradas: number;
  posicoesOcupadas: number;
  posicoes: WarehousePosition[];
  ativo: boolean;
  criadoEm: string;
  atualizadoEm: string;
}

export interface WarehouseTransferItem {
  itemId: string;
  sku: string;
  nome: string;
  quantidade: number;
  posicaoOrigem: string;
  posicaoDestino: string;
}

export interface WarehouseTransfer {
  id: string;
  companyId: string;
  codigoTransferencia: string;
  cdOrigemId: string;
  cdOrigemNome: string;
  cdDestinoId: string;
  cdDestinoNome: string;
  tipo: 'entre_galpoes' | 'interna_posicoes';
  status: 'solicitada' | 'em_separacao' | 'em_transito' | 'recebida_conferida' | 'cancelada';
  itens: WarehouseTransferItem[];
  totalVolumes: number;
  totalPesoKg: number;
  motoristaNome?: string;
  veiculoPlaca?: string;
  solicitadoPor: string;
  dataSolicitacao: string;
  despachadoEm?: string;
  recebidoPor?: string;
  dataRecebimento?: string;
  divergenciasAnotadas?: string;
}

export interface WarehouseInventoryAuditItem {
  itemId: string;
  sku: string;
  nome: string;
  posicaoCodigo: string;
  saldoSistema: number;
  saldoContado: number;
  divergencia: number;
  custoUnitario: number;
  impactoFinanceiro: number;
  ajusteAutorizado?: boolean;
}

export interface WarehouseInventoryAudit {
  id: string;
  companyId: string;
  codigoInventario: string;
  cdId: string;
  cdNome: string;
  tipoInventario: 'ciclico' | 'rotativo_curva_a' | 'geral_completo';
  status: 'aberto' | 'em_contagem' | 'em_analise_divergencia' | 'concluido_ajustado' | 'cancelado';
  responsavelAuditoria: string;
  itens: WarehouseInventoryAuditItem[];
  totalItensAvaliados: number;
  totalDivergenciasEncontradas: number;
  impactoTotalFinanceiroDivergencia: number;
  dataInicio: string;
  dataConclusao?: string;
  observacoes?: string;
}

export type FulfillmentStage = 
  | 'recebido'
  | 'conferencia'
  | 'picking'
  | 'packing'
  | 'expedicao'
  | 'transporte'
  | 'entregue'
  | 'devolvido'
  | 'cancelado';

export interface FulfillmentItem {
  id: string;
  sku: string;
  nome: string;
  quantidade: number;
  posicaoEnderecoCd: string;
  separado: boolean;
  embalado: boolean;
  precoUnitario: number;
}

export interface FulfillmentOrder {
  id: string;
  companyId: string;
  numeroPedido: string;
  origemCanal: 'ecommerce' | 'b2b_empresarial' | 'marketplace' | 'manual';
  clienteId?: string;
  clienteNome: string;
  clienteDocumento: string;
  clienteTelefone: string;
  clienteEmail?: string;
  enderecoEntrega: string;
  numero: string;
  complemento?: string;
  bairro: string;
  cidade: string;
  estado: string;
  cep: string;
  cdId: string;
  cdNome: string;
  itens: FulfillmentItem[];
  valorTotalItens: number;
  valorFrete: number;
  volumesTotal: number;
  pesoTotalKg: number;
  etapaAtual: FulfillmentStage;
  slaLimiteEnvio: string;
  slaLimiteEntrega: string;
  prazoCumprido?: boolean;
  transportadoraId?: string;
  transportadoraNome?: string;
  codigoRastreio?: string;
  etiquetaEnvioDataUrl?: string;
  chaveNFeVinculada?: string;
  responsavelEtapaAtual?: string;
  historicoEtapas: {
    etapa: FulfillmentStage;
    dataHora: string;
    responsavelNome: string;
    observacao?: string;
  }[];
  criadoEm: string;
  atualizadoEm: string;
}

export interface PickingTask {
  id: string;
  companyId: string;
  codigoOnda: string;
  cdId: string;
  tipo: 'single_order' | 'batch_wave';
  pedidosIds: string[];
  itensPendentes: {
    pedidoId: string;
    pedidoNumero: string;
    sku: string;
    nome: string;
    quantidade: number;
    posicaoEndereco: string;
    concluido: boolean;
  }[];
  operadorId?: string;
  operadorNome?: string;
  status: 'pendente' | 'em_andamento' | 'concluida' | 'cancelada';
  iniciadaEm?: string;
  concluidaEm?: string;
}

export interface PackingTask {
  id: string;
  companyId: string;
  pedidoId: string;
  pedidoNumero: string;
  cdId: string;
  tipoEmbalagem: 'caixa_pequena' | 'caixa_media' | 'caixa_grande' | 'envelope_seguranca' | 'pallet';
  pesoBalancaKg: number;
  lacreNumero?: string;
  conferido100Porcento: boolean;
  etiquetaGerada: boolean;
  embaladorNome: string;
  status: 'em_embalagem' | 'embalado_pronto_expedicao';
  concluidoEm: string;
}

export interface ShippingManifest {
  id: string;
  companyId: string;
  codigoManifesto: string;
  cdId: string;
  cdNome: string;
  transportadoraId?: string;
  transportadoraNome: string;
  motoristaNome?: string;
  veiculoPlaca?: string;
  pedidosIds: string[];
  totalPedidos: number;
  totalVolumes: number;
  totalPesoKg: number;
  valorTotalCarga: number;
  status: 'gerado' | 'despachado' | 'em_transito' | 'entregue';
  criadoEm: string;
  despachadoEm?: string;
  observacoes?: string;
}

export interface ReverseLogisticsTicket {
  id: string;
  companyId: string;
  codigoReversa: string;
  pedidoOriginalId: string;
  pedidoOriginalNumero: string;
  clienteNome: string;
  clienteTelefone: string;
  motivo: 'desistencia_arrependimento' | 'defeito_avaria' | 'produto_incorreto' | 'insucesso_entrega';
  status: 'solicitada' | 'coleta_agendada' | 'em_transito_devolucao' | 'recebido_no_cd' | 'triagem_concluida' | 'estorno_liberado';
  itens: {
    sku: string;
    nome: string;
    quantidade: number;
    condicaoAposTriagem?: 'perfeito_reestocar' | 'avariado_descarte' | 'reparo_necessario';
  }[];
  codigoAutorizacaoPostagem?: string;
  transportadoraNome?: string;
  destinacaoFinal?: string;
  laudoInspecao?: string;
  solicitadoEm: string;
  concluidoEm?: string;
}

export type CarrierModalType = 'urbano_last_mile' | 'rodoviario_fracionado' | 'aereo_expresso' | 'proprio_frota';

export interface CarrierPartner {
  id: string;
  companyId: string;
  codigo: string;
  nomeFantasia: string;
  razaoSocial: string;
  cnpj: string;
  modalidade: CarrierModalType;
  contatoNome: string;
  contatoTelefone: string;
  contatoEmail: string;
  regioesAtendidas: string[];
  slaMedioHoras: number;
  taxaEntregaSucessoPercentual: number;
  statusIntegracao: 'ativo' | 'em_teste' | 'inativo';
  apiKeyMock?: string;
  observacoes?: string;
  criadoEm: string;
}

export interface B2BEnterpriseClient {
  id: string;
  companyId: string;
  razaoSocial: string;
  nomeFantasia: string;
  cnpj: string;
  responsavelNome: string;
  responsavelEmail: string;
  responsavelTelefone: string;
  segmentoNegocio: string;
  limiteEstoqueItens: number;
  totalItensArmazenados: number;
  totalPedidosMes: number;
  statusContrato: 'ativo' | 'suspenso' | 'em_implantacao';
  criadoEm: string;
}

export interface B2BCollectionRequest {
  id: string;
  companyId: string;
  codigoSolicitacao: string;
  clienteEmpresarialId: string;
  clienteEmpresarialNome: string;
  enderecoColeta: string;
  numero: string;
  bairro: string;
  cidade: string;
  estado: string;
  cep: string;
  dataAgendada: string;
  periodo: 'manha' | 'tarde' | 'integral';
  quantidadeVolumesEstimada: number;
  pesoEstimadoKg: number;
  cdDestinoId: string;
  cdDestinoNome: string;
  status: 'agendada' | 'motorista_a_caminho' | 'coletada' | 'recebida_cd' | 'cancelada';
  motoristaNome?: string;
  veiculoPlaca?: string;
  observacoes?: string;
  criadoEm: string;
}

export interface AIOperationalInsight {
  id: string;
  companyId: string;
  timestamp: string;
  tipo: 'gargalo_operacional' | 'previsao_ruptura' | 'otimizacao_rota' | 'redistribuicao_cd' | 'reducao_custos';
  prioridade: 'baixa' | 'media' | 'alta' | 'critica';
  titulo: string;
  diagnostico: string;
  evidencias: string[];
  acaoRecomendada: string;
  impactoEstimado: string;
  requerAutorizacaoHumana: boolean;
  statusAprovacao: 'pendente_analise' | 'autorizado_executado' | 'descartado';
  autorizadoPor?: string;
  autorizadoEm?: string;
}

export interface DatabaseSchema {
  users: User[];
  companies: Company[];
  plans: CommercialPlan[];
  systemConfig: SystemConfig;
  payments: PaymentRequest[];
  auditLogs: AuditLog[];
  logisticsReceipts: LogisticsReceipt[];
  inventory: InventoryItem[];
  stockMovements: StockMovement[];
  shipments: ShipmentOrder[];
  deliveries: DeliveryItem[];
  vehicles: Vehicle[];
  routes: DeliveryRoute[];
  condoUnits: CondoUnit[];
  condoPackages: CondoPackage[];
  condoVisitors: CondoVisitor[];
  fiscalConfigs: FiscalConfig[];
  fiscalDocuments: FiscalDocument[];
  financialRecords: FinancialRecord[];
  notifications: NotificationItem[];
  // Adega & Tabacaria Commercial Collections
  commercialProducts: CommercialProduct[];
  commercialStockMovements: CommercialStockMovement[];
  commercialSales: CommercialSale[];
  commercialCashSessions: CommercialCashSession[];
  commercialSuppliers: CommercialSupplier[];
  commercialPurchases: CommercialPurchase[];
  pixCharges: PixCharge[];
  commercialTerminals: CommercialTerminal[];
  commercialTerminalTransactions: CommercialTerminalTransaction[];
  // MoviLog Inteligente — Central de Prevenção
  preventionDismissedAlerts: PreventionResolvedAlert[];
  // MoviLog Enterprise Logistics Ecosystem
  warehouses: WarehouseCD[];
  warehouseTransfers: WarehouseTransfer[];
  warehouseAudits: WarehouseInventoryAudit[];
  fulfillmentOrders: FulfillmentOrder[];
  pickingTasks: PickingTask[];
  packingTasks: PackingTask[];
  reverseLogistics: ReverseLogisticsTicket[];
  carrierPartners: CarrierPartner[];
  b2bClients: B2BEnterpriseClient[];
  b2bCollections: B2BCollectionRequest[];
  shippingManifests: ShippingManifest[];
  aiInsights: AIOperationalInsight[];
}

// Default Seed Data
const defaultPlans: CommercialPlan[] = [
  {
    id: 'plan_demo',
    nome: 'Plano Demonstração',
    tipo: 'demo',
    descricao: 'Acesso temporário para conhecer todas as funcionalidades da plataforma.',
    precoMensal: 0,
    precoAnual: 0,
    duracaoDias: 7,
    modulosPermitidos: ['logistica', 'predial'],
    limites: {
      maxUsuarios: 3,
      maxUnidades: 20,
      maxOperacoesMes: 50
    },
    recursos: [
      'Avaliação completa de 7 dias',
      'Módulo de Logística e Expedição',
      'Módulo de Portaria e Encomendas',
      'Cadastro de até 3 operadores',
      'Rastreamento com QR Code',
      'Suporte para implantação assistida'
    ],
    destaque: false,
    ativo: true
  },
  {
    id: 'plan_essencial',
    nome: 'Plano Essencial',
    tipo: 'essencial',
    descricao: 'Ideal para condomínios pequenos ou operações locais de logística.',
    precoMensal: 249,
    precoAnual: 2490,
    duracaoDias: 30,
    modulosPermitidos: ['logistica', 'predial'],
    limites: {
      maxUsuarios: 5,
      maxUnidades: 80,
      maxOperacoesMes: 300
    },
    recursos: [
      'Recebimento e conferência de volumes',
      'Controle de portaria e encomendas com PIN',
      'Histórico de movimentações',
      'Etiquetas e comprovantes em QR Code',
      'Até 5 usuários ativos',
      'Relatórios essenciais em PDF/CSV'
    ],
    destaque: false,
    ativo: true
  },
  {
    id: 'plan_profissional',
    nome: 'Plano Profissional',
    tipo: 'profissional',
    descricao: 'Para médias empresas de logística, centros de distribuição e condomínios médios/grandes.',
    precoMensal: 490,
    precoAnual: 4900,
    duracaoDias: 30,
    modulosPermitidos: ['logistica', 'predial'],
    limites: {
      maxUsuarios: 20,
      maxUnidades: 350,
      maxOperacoesMes: 2000
    },
    recursos: [
      'Tudo do Essencial com limites ampliados',
      'Controle avançado de estoque e posições',
      'Expedição e despacho com rastreamento',
      'Disparo de notificações diretas no WhatsApp',
      'Gestão de visitantes e prestadores',
      'Indicadores operacionais e produtividade'
    ],
    destaque: true,
    ativo: true
  },
  {
    id: 'plan_empresarial',
    nome: 'Plano Empresarial',
    tipo: 'empresarial',
    descricao: 'Operações de alta complexidade com múltiplas unidades e auditoria completa.',
    precoMensal: 980,
    precoAnual: 9800,
    duracaoDias: 30,
    modulosPermitidos: ['logistica', 'predial'],
    limites: {
      maxUsuarios: 100,
      maxUnidades: 2000,
      maxOperacoesMes: 15000
    },
    recursos: [
      'Tudo do Profissional com multiunidades',
      'Controle unificado de galpões e condomínios',
      'Logs de auditoria e conformidade LGPD',
      'Módulos integrados sem restrição',
      'Exportação e relatórios analíticos de custos',
      'Suporte técnico e comercial prioritário'
    ],
    destaque: false,
    ativo: true
  },
  {
    id: 'plan_personalizado',
    nome: 'Plano Personalizado',
    tipo: 'personalizado',
    descricao: 'Solução sob medida para transportadoras de grande porte e administradoras prediais.',
    precoMensal: 0,
    precoAnual: 0,
    duracaoDias: 30,
    modulosPermitidos: ['logistica', 'predial'],
    limites: {
      maxUsuarios: 9999,
      maxUnidades: 99999,
      maxOperacoesMes: 999999
    },
    recursos: [
      'Volume operacional customizado',
      'Integrações personalizadas com ERP',
      'Gestão dedicada de implantação',
      'SLA de atendimento contratual',
      'Condições e preços definidos pelo Master'
    ],
    destaque: false,
    ativo: true
  }
];

const defaultSystemConfig: SystemConfig = {
  nomePlataforma: 'MoviLog - Movimento Inteligente. Controle Total.',
  whatsappComercial: '5511999999999',
  mensagemWhatsappPadrao: 'Olá! Tenho interesse em contratar a plataforma MoviLog.\n\nEmpresa: [NOME DA EMPRESA]\nCNPJ: [CNPJ]\nPlano: [PLANO]\n\nGostaria de receber instruções para ativação imediata.',
  diasDemonstracao: 7,
  masterEmail: 'Alifermadeiro@hotmail.com',
  masterInitialized: false,
  modoManutencao: false
};

class Database {
  private data: DatabaseSchema;

  constructor() {
    if (isPostgresActive()) {
      // In PostgreSQL mode, JSON is NOT loaded as primary source; data is fetched per request from PostgreSQL.
      this.data = this.createEmptySchema();
    } else {
      this.data = this.load();
    }
  }

  private createEmptySchema(): DatabaseSchema {
    return {
      users: [],
      companies: [],
      plans: defaultPlans,
      systemConfig: defaultSystemConfig,
      payments: [],
      auditLogs: [],
      logisticsReceipts: [],
      inventory: [],
      stockMovements: [],
      shipments: [],
      deliveries: [],
      vehicles: [],
      routes: [],
      condoUnits: [],
      condoPackages: [],
      condoVisitors: [],
      fiscalConfigs: [],
      fiscalDocuments: [],
      financialRecords: [],
      notifications: [],
      commercialProducts: [],
      commercialStockMovements: [],
      commercialSales: [],
      commercialCashSessions: [],
      commercialSuppliers: [],
      commercialPurchases: [],
      pixCharges: [],
      commercialTerminals: [],
      commercialTerminalTransactions: [],
      preventionDismissedAlerts: [],
      warehouses: [],
      warehouseTransfers: [],
      warehouseAudits: [],
      fulfillmentOrders: [],
      pickingTasks: [],
      packingTasks: [],
      reverseLogistics: [],
      carrierPartners: [],
      b2bClients: [],
      b2bCollections: [],
      shippingManifests: [],
      aiInsights: []
    };
  }

  private get activeData(): DatabaseSchema {
    if (isPostgresActive()) {
      const ctx = getActivePgContext();
      if (!ctx) {
        throw new Error(
          '[PostgreSQL Persistence] Tentativa de acesso a db fora de um contexto transacional/HTTP PostgreSQL.'
        );
      }
      return ctx.data as DatabaseSchema;
    }
    return this.data;
  }

  private load(): DatabaseSchema {
    if (fs.existsSync(DB_FILE)) {
      try {
        const raw = fs.readFileSync(DB_FILE, 'utf-8');
        const parsed = JSON.parse(raw);
        // Ensure all collections exist
        return {
          users: parsed.users || [],
          companies: parsed.companies || [],
          plans: parsed.plans && parsed.plans.length > 0 ? parsed.plans : defaultPlans,
          systemConfig: parsed.systemConfig || defaultSystemConfig,
          payments: parsed.payments || [],
          auditLogs: parsed.auditLogs || [],
          logisticsReceipts: parsed.logisticsReceipts || [],
          inventory: parsed.inventory || [],
          stockMovements: parsed.stockMovements || [],
          shipments: parsed.shipments || [],
          deliveries: parsed.deliveries || [],
          vehicles: parsed.vehicles || [],
          routes: parsed.routes || [],
          condoUnits: parsed.condoUnits || [],
          condoPackages: parsed.condoPackages || [],
          condoVisitors: parsed.condoVisitors || [],
          fiscalConfigs: parsed.fiscalConfigs || [],
          fiscalDocuments: parsed.fiscalDocuments || [],
          financialRecords: parsed.financialRecords || [],
          notifications: parsed.notifications || [],
          commercialProducts: (parsed.commercialProducts || []).map((p: any) => {
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
            }
            return p;
          }),
          commercialStockMovements: parsed.commercialStockMovements || [],
          commercialSales: parsed.commercialSales || [],
          commercialCashSessions: parsed.commercialCashSessions || [],
          commercialSuppliers: parsed.commercialSuppliers || [],
          commercialPurchases: parsed.commercialPurchases || [],
          pixCharges: parsed.pixCharges || [],
          commercialTerminals: parsed.commercialTerminals || [],
          commercialTerminalTransactions: parsed.commercialTerminalTransactions || [],
          preventionDismissedAlerts: parsed.preventionDismissedAlerts || [],
          warehouses: parsed.warehouses || [],
          warehouseTransfers: parsed.warehouseTransfers || [],
          warehouseAudits: parsed.warehouseAudits || [],
          fulfillmentOrders: parsed.fulfillmentOrders || [],
          pickingTasks: parsed.pickingTasks || [],
          packingTasks: parsed.packingTasks || [],
          reverseLogistics: parsed.reverseLogistics || [],
          carrierPartners: parsed.carrierPartners || [],
          b2bClients: parsed.b2bClients || [],
          b2bCollections: parsed.b2bCollections || [],
          shippingManifests: parsed.shippingManifests || [],
          aiInsights: parsed.aiInsights || []
        };
      } catch (err) {
        console.error('Error loading db.json, attempting backup_db.json fallback:', err);
        const backupFile = path.resolve(DATA_DIR, 'backup_db.json');
        if (fs.existsSync(backupFile)) {
          try {
            const rawBackup = fs.readFileSync(backupFile, 'utf-8');
            const parsedBackup = JSON.parse(rawBackup);
            console.log('Dados restaurados com sucesso a partir da cópia de segurança (backup_db.json)');
            return {
              users: parsedBackup.users || [],
              companies: parsedBackup.companies || [],
              plans: parsedBackup.plans && parsedBackup.plans.length > 0 ? parsedBackup.plans : defaultPlans,
              systemConfig: parsedBackup.systemConfig || defaultSystemConfig,
              payments: parsedBackup.payments || [],
              auditLogs: parsedBackup.auditLogs || [],
              logisticsReceipts: parsedBackup.logisticsReceipts || [],
              inventory: parsedBackup.inventory || [],
              stockMovements: parsedBackup.stockMovements || [],
              shipments: parsedBackup.shipments || [],
              deliveries: parsedBackup.deliveries || [],
              vehicles: parsedBackup.vehicles || [],
              routes: parsedBackup.routes || [],
              condoUnits: parsedBackup.condoUnits || [],
              condoPackages: parsedBackup.condoPackages || [],
              condoVisitors: parsedBackup.condoVisitors || [],
              fiscalConfigs: parsedBackup.fiscalConfigs || [],
              fiscalDocuments: parsedBackup.fiscalDocuments || [],
              financialRecords: parsedBackup.financialRecords || [],
              notifications: parsedBackup.notifications || [],
              commercialProducts: parsedBackup.commercialProducts || [],
              commercialStockMovements: parsedBackup.commercialStockMovements || [],
              commercialSales: parsedBackup.commercialSales || [],
              commercialCashSessions: parsedBackup.commercialCashSessions || [],
              commercialSuppliers: parsedBackup.commercialSuppliers || [],
              commercialPurchases: parsedBackup.commercialPurchases || [],
              pixCharges: parsedBackup.pixCharges || [],
              commercialTerminals: parsedBackup.commercialTerminals || [],
              commercialTerminalTransactions: parsedBackup.commercialTerminalTransactions || [],
              preventionDismissedAlerts: parsedBackup.preventionDismissedAlerts || [],
              warehouses: parsedBackup.warehouses || [],
              warehouseTransfers: parsedBackup.warehouseTransfers || [],
              warehouseAudits: parsedBackup.warehouseAudits || [],
              fulfillmentOrders: parsedBackup.fulfillmentOrders || [],
              pickingTasks: parsedBackup.pickingTasks || [],
              packingTasks: parsedBackup.packingTasks || [],
              reverseLogistics: parsedBackup.reverseLogistics || [],
              carrierPartners: parsedBackup.carrierPartners || [],
              b2bClients: parsedBackup.b2bClients || [],
              b2bCollections: parsedBackup.b2bCollections || [],
              shippingManifests: parsedBackup.shippingManifests || [],
              aiInsights: parsedBackup.aiInsights || []
            };
          } catch (backupErr) {
            console.error('Falha ao carregar backup_db.json:', backupErr);
          }
        }
      }
    }

    const initial = this.createEmptySchema();
    this.saveData(initial);
    return initial;
  }

  private saveData(data: DatabaseSchema): void {
    const tempFile = `${DB_FILE}.tmp.${Date.now()}`;
    fs.writeFileSync(tempFile, JSON.stringify(data, null, 2), 'utf-8');
    fs.renameSync(tempFile, DB_FILE);

    // Maintain defensive persistent backup copy
    try {
      const backupFile = path.resolve(DATA_DIR, 'backup_db.json');
      fs.copyFileSync(DB_FILE, backupFile);
    } catch {
      // Ignore backup copy non-fatal errors
    }
  }

  public save(): Promise<void> | void {
    if (isPostgresActive()) {
      const ctx = getActivePgContext();
      const promise = flushPgContext();
      if (ctx) {
        ctx.pendingFlushes.push(promise);
      }
      return promise;
    }
    this.saveData(this.data);
  }

  public get users() { return this.activeData.users; }
  public get companies() { return this.activeData.companies; }
  public get plans() { return this.activeData.plans; }
  public get systemConfig() { return this.activeData.systemConfig; }
  public get payments() { return this.activeData.payments; }
  public get auditLogs() { return this.activeData.auditLogs; }
  public get logisticsReceipts() { return this.activeData.logisticsReceipts; }
  public get inventory() { return this.activeData.inventory; }
  public get stockMovements() { return this.activeData.stockMovements; }
  public get shipments() { return this.activeData.shipments; }
  public get deliveries() { return this.activeData.deliveries; }
  public get vehicles() { return this.activeData.vehicles; }
  public get routes() { return this.activeData.routes; }
  public get condoUnits() { return this.activeData.condoUnits; }
  public get condoPackages() { return this.activeData.condoPackages; }
  public get condoVisitors() { return this.activeData.condoVisitors; }
  public get fiscalConfigs() { return this.activeData.fiscalConfigs; }
  public get fiscalDocuments() { return this.activeData.fiscalDocuments; }
  public get financialRecords() { return this.activeData.financialRecords; }
  public get notifications() { return this.activeData.notifications; }
  public get commercialProducts() { return this.activeData.commercialProducts; }
  public get commercialStockMovements() { return this.activeData.commercialStockMovements; }
  public get commercialSales() { return this.activeData.commercialSales; }
  public get commercialCashSessions() { return this.activeData.commercialCashSessions; }
  public get commercialSuppliers() { return this.activeData.commercialSuppliers; }
  public get commercialPurchases() { return this.activeData.commercialPurchases; }
  public get pixCharges() { return this.activeData.pixCharges; }
  public get commercialTerminals() { return this.activeData.commercialTerminals; }
  public get commercialTerminalTransactions() { return this.activeData.commercialTerminalTransactions; }
  public get preventionDismissedAlerts() { return this.activeData.preventionDismissedAlerts || (this.activeData.preventionDismissedAlerts = []); }
  public get warehouses() { return this.activeData.warehouses || (this.activeData.warehouses = []); }
  public get warehouseTransfers() { return this.activeData.warehouseTransfers || (this.activeData.warehouseTransfers = []); }
  public get warehouseAudits() { return this.activeData.warehouseAudits || (this.activeData.warehouseAudits = []); }
  public get fulfillmentOrders() { return this.activeData.fulfillmentOrders || (this.activeData.fulfillmentOrders = []); }
  public get pickingTasks() { return this.activeData.pickingTasks || (this.activeData.pickingTasks = []); }
  public get packingTasks() { return this.activeData.packingTasks || (this.activeData.packingTasks = []); }
  public get reverseLogistics() { return this.activeData.reverseLogistics || (this.activeData.reverseLogistics = []); }
  public get carrierPartners() { return this.activeData.carrierPartners || (this.activeData.carrierPartners = []); }
  public get b2bClients() { return this.activeData.b2bClients || (this.activeData.b2bClients = []); }
  public get b2bCollections() { return this.activeData.b2bCollections || (this.activeData.b2bCollections = []); }
  public get shippingManifests() { return this.activeData.shippingManifests || (this.activeData.shippingManifests = []); }
  public get aiInsights() { return this.activeData.aiInsights || (this.activeData.aiInsights = []); }

  public logAudit(log: Omit<AuditLog, 'id' | 'timestamp'>): Promise<void> | void {
    if (isPostgresActive()) {
      const ctx = getActivePgContext();
      const promise = pgRepo.logAudit(log).then((entry) => {
        if (ctx && Array.isArray(ctx.data.auditLogs)) {
          ctx.data.auditLogs.unshift(entry);
          ctx.initialSnapshots.get('auditLogs')?.set(entry.id, JSON.stringify(entry));
        }
      });
      if (ctx) {
        ctx.pendingFlushes.push(promise);
      }
      return promise;
    }

    const entry: AuditLog = {
      id: crypto.randomUUID(),
      timestamp: new Date().toISOString(),
      ...log
    };
    this.data.auditLogs.unshift(entry);
    // Keep max 2000 logs
    if (this.data.auditLogs.length > 2000) {
      this.data.auditLogs = this.data.auditLogs.slice(0, 2000);
    }
    this.save();
  }
}

export const db = new Database();

// Password hashing helper using native crypto
export function hashPassword(password: string, salt?: string): { hash: string; salt: string } {
  const generatedSalt = salt || crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, generatedSalt, 64).toString('hex');
  return { hash, salt: generatedSalt };
}

export function verifyPassword(password: string, hash: string, salt: string): boolean {
  const calculatedHash = crypto.scryptSync(password, salt, 64).toString('hex');
  return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(calculatedHash, 'hex'));
}

// Persistent session token mapping to user ID
const SESSIONS_FILE = path.resolve(DATA_DIR, 'sessions.json');

function loadSessions(): Map<string, { userId: string; expiresAt: number }> {
  const map = new Map<string, { userId: string; expiresAt: number }>();
  if (fs.existsSync(SESSIONS_FILE)) {
    try {
      const raw = fs.readFileSync(SESSIONS_FILE, 'utf-8');
      const obj = JSON.parse(raw);
      for (const [k, v] of Object.entries(obj)) {
        map.set(k, v as { userId: string; expiresAt: number });
      }
    } catch (e) {
      // ignore
    }
  }
  return map;
}

function saveSessions(map: Map<string, { userId: string; expiresAt: number }>): void {
  try {
    const obj: Record<string, { userId: string; expiresAt: number }> = {};
    for (const [k, v] of map.entries()) {
      obj[k] = v;
    }
    const tempFile = `${SESSIONS_FILE}.tmp.${Date.now()}.${process.pid}`;
    fs.writeFileSync(tempFile, JSON.stringify(obj, null, 2), 'utf-8');
    fs.renameSync(tempFile, SESSIONS_FILE);
  } catch (e) {
    // ignore
  }
}

const sessions = isPostgresActive() ? new Map<string, { userId: string; expiresAt: number }>() : loadSessions();

export function createSession(userId: string): string {
  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = Date.now() + 7 * 24 * 60 * 60 * 1000; // 7 days
  sessions.set(token, { userId, expiresAt });
  saveSessions(sessions);
  return token;
}

export function getSessionUser(token: string): User | null {
  if (!token) return null;
  let session = sessions.get(token);
  if (!session) {
    const diskSessions = loadSessions();
    session = diskSessions.get(token);
    if (session) {
      sessions.set(token, session);
    }
  }
  if (!session) return null;
  if (Date.now() > session.expiresAt) {
    sessions.delete(token);
    saveSessions(sessions);
    return null;
  }
  const user = db.users.find(u => u.id === session.userId && u.active);
  return user || null;
}

export function destroySession(token: string): void {
  sessions.delete(token);
  saveSessions(sessions);
}

export async function createSessionAsync(userId: string): Promise<string> {
  if (isPostgresActive()) {
    return pgRepo.createSession(userId);
  }
  return createSession(userId);
}

export async function getSessionUserAsync(token: string): Promise<User | null> {
  if (isPostgresActive()) {
    return pgRepo.getSessionUser(token);
  }
  return getSessionUser(token);
}

export async function destroySessionAsync(token: string): Promise<void> {
  if (isPostgresActive()) {
    await pgRepo.destroySession(token);
    return;
  }
  destroySession(token);
}

export async function revokeAllUserSessionsAsync(userId: string): Promise<void> {
  if (isPostgresActive()) {
    await pgRepo.revokeAllUserSessions(userId);
    return;
  }
  const diskSessions = loadSessions();
  for (const [k, v] of diskSessions.entries()) {
    if (!sessions.has(k)) {
      sessions.set(k, v);
    }
  }
  let changed = false;
  for (const [k, v] of sessions.entries()) {
    if (v.userId === userId) {
      sessions.delete(k);
      changed = true;
    }
  }
  if (changed) saveSessions(sessions);
}

// Brazilian SEFAZ 44-digit Access Key Generator with Modulo 11 DV
export function generateChaveAcessoNFe(params: {
  cUF: string; // 2 digits (e.g., '35' for SP)
  anoMes: string; // 4 digits (e.g., '2610')
  cnpj: string; // 14 digits
  modelo: string; // 2 digits (55=NFe, 57=CTe, 58=MDFe, 65=NFCe)
  serie: number; // 1..999
  numero: number; // 1..999999999
  tpEmis?: string; // '1' = Normal
  codigoNumerico?: string; // 8 digits
}): string {
  const cUF = (params.cUF || '35').padStart(2, '0');
  const anoMes = (params.anoMes || new Date().toISOString().slice(2, 4) + (new Date().getMonth() + 1).toString().padStart(2, '0')).slice(0, 4);
  const cleanCnpj = (params.cnpj || '00000000000191').replace(/\D/g, '').padStart(14, '0');
  const mod = (params.modelo || '55').padStart(2, '0');
  const serie = String(params.serie || 1).padStart(3, '0');
  const nNF = String(params.numero || 1).padStart(9, '0');
  const tpEmis = params.tpEmis || '1';
  const cNF = params.codigoNumerico || String(Math.floor(10000000 + Math.random() * 90000000));
  
  const baseKey = `${cUF}${anoMes}${cleanCnpj}${mod}${serie}${nNF}${tpEmis}${cNF}`;
  
  // Modulo 11 check digit (multipliers 2 to 9, right to left)
  let sum = 0;
  let weight = 2;
  for (let i = baseKey.length - 1; i >= 0; i--) {
    sum += parseInt(baseKey[i], 10) * weight;
    weight = weight === 9 ? 2 : weight + 1;
  }
  const remainder = sum % 11;
  const dv = (remainder === 0 || remainder === 1) ? 0 : 11 - remainder;
  
  return `${baseKey}${dv}`;
}


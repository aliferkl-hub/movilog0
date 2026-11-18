export interface User {
  id: string;
  email: string;
  name: string;
  role: 'master_owner' | 'company_admin' | 'dispatcher' | 'driver' | 'operator' | 'concierge' | 'financial' | 'client' | 'viewer';
  companyId: string | null;
  phone?: string;
}

export interface CompanyLimits {
  maxUsuarios: number;
  maxUnidades: number;
  maxOperacoesMes: number;
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
  limites: CompanyLimits;
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
  limites: CompanyLimits;
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
  ocorrenciaTexto?: string;
}

export interface CondoUnit {
  id: string;
  companyId: string;
  bloco: string;
  andar: string;
  numeroUnidade: string;
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
  codigoPacote: string;
  unitId: string;
  unidadeIdentificacao: string;
  destinatarioNome: string;
  transportadora: string;
  nomeEntregador?: string;
  descricaoConteudo: string;
  codigoRetiradaPin: string;
  codigoRastreio?: string;
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
  documento: string;
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

export interface MasterStats {
  totalCompanies: number;
  demoActive: number;
  demoExpired: number;
  pendingPayments: number;
  activeSubs: number;
  totalVerifiedRevenue: number;
  totalUsers: number;
  totalReceipts: number;
  totalPackages: number;
  totalVisitors: number;
  totalDeliveries?: number;
  totalVehicles?: number;
  totalRoutes?: number;
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
  identificacao: string;
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
  codigoRota: string;
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

export interface TimelineDataPoint {
  date: string;
  label: string;
  current: number;
  previous: number;
}

export interface StatusBreakdownItem {
  status: string;
  label: string;
  count: number;
  color: string;
}

export interface DashboardMetrics {
  period: 'day' | 'week' | 'month';
  totalPeriod: number;
  previousPeriodTotal: number;
  percentageChange: number;
  awaitingPickup: number;
  delivered: number;
  pending: number;
  completionRate: number;
  avgPickupTimeFormatted: string;
  avgPickupMinutes: number;
  timelineData: TimelineDataPoint[];
  statusBreakdown: StatusBreakdownItem[];
  operationalPerformance: {
    totalProcessed: number;
    deliveredCount: number;
    completionPercentage: number;
    avgPickupTimeFormatted: string;
    awaitingPickupCount: number;
  };
  activityEvolution: {
    currentTotal: number;
    previousTotal: number;
    growthPercentage: number;
    trend: 'up' | 'down';
    timeline: TimelineDataPoint[];
  };
  totalDatabasePackages: number;
}

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
  chaveAcesso: string;
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
    forma?: 'dinheiro' | 'pix' | 'cartao_credito' | 'cartao_debito' | 'misto';
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
    txid?: string;
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

export interface CommercialDashboardMetrics {
  totalProdutos: number;
  valorEstoqueCusto: number;
  produtosEstoqueBaixoCount: number;
  vendasHojeValor: number;
  vendasHojeQtd: number;
  vendasMesValor: number;
  vendasMesQtd: number;
  lucroBrutoMesEstimado: number;
  topProdutosMaisVendidos: {
    productId: string;
    nome: string;
    quantidadeTotal: number;
    valorTotal: number;
  }[];
  produtosEstoqueBaixo: CommercialProduct[];
  produtosParados: CommercialProduct[];
  comparativoModulos: {
    adega: { totalProdutos: number; totalEstoqueValor: number; vendasMesValor: number };
    tabacaria: { totalProdutos: number; totalEstoqueValor: number; vendasMesValor: number };
  };
}

// ==========================================
// CENTRAL DE INTEGRAÇÃO DE MAQUININHAS (POS / TEF)
// ==========================================

export type TerminalProvider = 'mercadopago_point' | 'stone_connect' | 'pagar_me' | 'smartpos_tef' | 'pos_manual';

export interface CommercialTerminalCredentials {
  // Mercado Pago Point Cloud API
  mpAccessToken?: string;
  mpPublicKey?: string;
  // Stone Connect / Pagar.me
  stonePartnerKey?: string;
  stoneSecretKey?: string;
  stoneMerchantId?: string;
  // TEF / SmartPOS Web Integrator
  tefHost?: string;
  tefPort?: number;
  tefApiKey?: string;
  // Webhook Signature Key
  webhookSecret?: string;
}

export interface CommercialTerminal {
  id: string;
  companyId: string;
  nome: string;
  provedor: TerminalProvider;
  modelo: string;
  tipoEquipamento: 'smart_pos' | 'pos_gprs' | 'tef_pinpad' | 'pos_manual';
  identificadorProvedor: string; // device_id no MP, serial na Stone ou código terminal TEF
  serialNumber?: string;
  modulo: 'adega' | 'tabacaria' | 'ambos';
  caixaIdPadrao?: string;
  padrao: boolean;
  ativo: boolean;
  statusConexao: 'online' | 'offline' | 'desconhecido';
  ultimaSincronizacao?: string;
  bateriaNivel?: number;
  modoOperacao: 'cloud_api' | 'smart_pos_app' | 'tef_integrado' | 'manual_operador';
  // Credenciais (mascaradas nas respostas para o frontend)
  credenciais?: CommercialTerminalCredentials;
  hasCredentials?: boolean;
  maskedToken?: string;
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

export interface TerminalPaymentIntentRequest {
  terminalId: string;
  valor: number;
  tipoOperacao: 'debito' | 'credito' | 'pix';
  parcelas?: number;
  modulo: 'adega' | 'tabacaria' | 'misto';
  codigoVenda?: string;
  caixaSessionId?: string;
  idempotencyKey?: string;
}

export interface TerminalReconciliationReport {
  dataGeracao: string;
  companyId: string;
  resumo: {
    totalVendasMoviLogCartao: number;
    valorTotalVendasMoviLog: number;
    totalTransacoesMaquininha: number;
    valorTotalBrutoMaquininha: number;
    valorTotalTaxasMaquininha: number;
    valorTotalLiquidoMaquininha: number;
    transacoesAprovadasQtd: number;
    transacoesRecusadasQtd: number;
    transacoesCanceladasQtd: number;
    vendasSemTransacaoQtd: number;
    transacoesOrfasQtd: number;
    divergenciasValorQtd: number;
  };
  itens: {
    id: string;
    statusConciliacao: 'conciliado' | 'venda_sem_transacao' | 'transacao_sem_venda' | 'divergencia_valor' | 'transacao_cancelada_com_venda_ativa';
    venda?: {
      id: string;
      codigoVenda: string;
      valorTotal: number;
      formaPagamento: string;
      status: string;
      criadoEm: string;
      operadorNome: string;
    };
    transacao?: {
      id: string;
      nsu?: string;
      codigoAutorizacao?: string;
      terminalNome: string;
      provedor: string;
      valorBruto: number;
      valorTaxaEstimada: number;
      valorLiquido: number;
      status: string;
      bandeira?: string;
      criadoEm: string;
    };
    diferencaValor?: number;
    observacaoAuditoria?: string;
  }[];
}

// ==========================================
// MoviLog Inteligente — Central de Prevenção
// ==========================================

export type PreventionAlertType = 
  | 'atraso_entrega' 
  | 'tentativa_falha' 
  | 'encomenda_pendente' 
  | 'duplicidade_suspeita' 
  | 'rota_ocorrencia' 
  | 'estoque_critico';

export type PreventionCategory = 'logistica' | 'predial' | 'rotas' | 'comercial';
export type PreventionPriority = 'baixa' | 'media' | 'alta' | 'urgente';

export interface PreventionAlert {
  id: string;
  companyId: string;
  tipo: PreventionAlertType;
  categoria: PreventionCategory;
  titulo: string;
  motivo: string;
  prioridade: PreventionPriority;
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

export interface PreventionMetrics {
  totalAlertasAtivos: number;
  alertasUrgentes: number;
  alertasAltos: number;
  entregasAtrasadasCount: number;
  tentativasFalhasCount: number;
  encomendasRetidasCount: number;
  duplicidadesCount: number;
  rotasComProblemasCount: number;
  estoqueCriticoCount: number;
  taxaResolucaoPercentual: number;
  totalResolvidosHistorico: number;
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
  codigo: string; // Ex: CD1-R01-P02-N3
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
  codigo: string; // Ex: CD-SP-01
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
  codigoTransferencia: string; // Ex: TRF-2026-0001
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
  codigoInventario: string; // Ex: INV-2026-0001
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

// ----------------------------------------------------------------------------
// FULFILLMENT PIPELINE (Infracommerce Standard)
// ----------------------------------------------------------------------------

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
  numeroPedido: string; // Ex: PED-INFRA-10023
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
  slaLimiteEnvio: string; // Prazo limite de despacho
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
  codigoOnda: string; // Ex: ONDA-PICK-2026-01
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
  codigoManifesto: string; // Ex: MAN-EXP-2026-001
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
  codigoReversa: string; // Ex: REV-2026-0042
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

// ----------------------------------------------------------------------------
// CARRIERS & LAST MILE ECOSYSTEM
// ----------------------------------------------------------------------------

export type CarrierModalType = 'urbano_last_mile' | 'rodoviario_fracionado' | 'aereo_expresso' | 'proprio_frota';

export interface CarrierPartner {
  id: string;
  companyId: string;
  codigo: string; // Ex: TR-LOGGI, TR-TOTAL, TR-JADLOG
  nomeFantasia: string;
  razaoSocial: string;
  cnpj: string;
  modalidade: CarrierModalType;
  contatoNome: string;
  contatoTelefone: string;
  contatoEmail: string;
  regioesAtendidas: string[]; // ['SP Capital', 'Grande SP', 'Interior SP', 'Nacional']
  slaMedioHoras: number;
  taxaEntregaSucessoPercentual: number;
  statusIntegracao: 'ativo' | 'em_teste' | 'inativo';
  apiKeyMock?: string;
  observacoes?: string;
  criadoEm: string;
}

// ----------------------------------------------------------------------------
// B2B ENTERPRISE CLIENT PORTAL
// ----------------------------------------------------------------------------

export interface B2BEnterpriseClient {
  id: string;
  companyId: string;
  razaoSocial: string;
  nomeFantasia: string;
  cnpj: string;
  responsavelNome: string;
  responsavelEmail: string;
  responsavelTelefone: string;
  segmentoNegocio: string; // Ex: Moda & Vestuário, Cosméticos, Farmacêutico, Eletrônicos
  limiteEstoqueItens: number;
  totalItensArmazenados: number;
  totalPedidosMes: number;
  statusContrato: 'ativo' | 'suspenso' | 'em_implantacao';
  criadoEm: string;
}

export interface B2BCollectionRequest {
  id: string;
  companyId: string;
  codigoSolicitacao: string; // Ex: COL-2026-0001
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

// ----------------------------------------------------------------------------
// CONTROL TOWER & OPERATIONAL AI ASSISTANT
// ----------------------------------------------------------------------------

export interface ControlTowerMetrics {
  pedidosEmAndamento: number;
  pedidosConferidos: number;
  pedidosEmSeparacao: number;
  pedidosEmEmbalagem: number;
  pedidosExpedidos: number;
  entregasConcluidasHoje: number;
  entregasAtrasadasHoje: number;
  taxaOtifPercentual: number; // On-Time In-Full
  motoristasEmTransito: number;
  veiculosOperacionais: number;
  totalPosicoesCdOcupacaoPercentual: number;
  devolucoesEmProcessamento: number;
  custoMedioFretePorEntrega: number;
  tempoMedioCicloFulfillmentMinutos: number;
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

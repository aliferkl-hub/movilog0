import React, { useState, useEffect } from 'react';
import { useAuth } from '../../context/AuthContext';
import { api } from '../../lib/api';
import {
  FulfillmentOrder,
  FulfillmentStage,
  PickingTask,
  PackingTask,
  ShippingManifest,
  ReverseLogisticsTicket,
  WarehouseCD
} from '../../types';
import {
  Layers,
  Package,
  Boxes,
  Truck,
  CheckCircle2,
  Clock,
  AlertTriangle,
  QrCode,
  Search,
  Filter,
  Plus,
  ArrowRight,
  Scale,
  Barcode,
  RotateCcw,
  Sparkles,
  RefreshCw,
  X,
  FileText,
  Printer,
  ChevronRight,
  User,
  MapPin,
  ExternalLink,
  ShieldCheck,
  Building,
  CheckSquare
} from 'lucide-react';

interface FulfillmentPipelineViewProps {
  activeView?: string;
  onNavigate: (module: string, view?: string) => void;
}

export const FulfillmentPipelineView: React.FC<FulfillmentPipelineViewProps> = ({
  activeView = 'pipeline',
  onNavigate
}) => {
  const { user, company, isMaster } = useAuth();

  // Tab State
  const [tab, setTab] = useState<'pipeline' | 'waves' | 'packing' | 'manifests' | 'reverse'>('pipeline');

  // Loading & Data States
  const [loading, setLoading] = useState(true);
  const [metrics, setMetrics] = useState<any>(null);
  const [orders, setOrders] = useState<FulfillmentOrder[]>([]);
  const [waves, setWaves] = useState<PickingTask[]>([]);
  const [packingTasks, setPackingTasks] = useState<PackingTask[]>([]);
  const [manifests, setManifests] = useState<ShippingManifest[]>([]);
  const [reverseTickets, setReverseTickets] = useState<ReverseLogisticsTicket[]>([]);
  const [warehouses, setWarehouses] = useState<WarehouseCD[]>([]);

  // Filters
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedCanal, setSelectedCanal] = useState('all');
  const [selectedCdId, setSelectedCdId] = useState('all');

  // Modals
  const [showNewOrderModal, setShowNewOrderModal] = useState(false);
  const [showNewWaveModal, setShowNewWaveModal] = useState(false);
  const [showPackingModal, setShowPackingModal] = useState(false);
  const [showManifestModal, setShowManifestModal] = useState(false);
  const [showReverseModal, setShowReverseModal] = useState(false);
  const [showOrderDetailsModal, setShowOrderDetailsModal] = useState(false);
  const [selectedOrder, setSelectedOrder] = useState<FulfillmentOrder | null>(null);

  // Form States
  const [newOrderForm, setNewOrderForm] = useState({
    numeroPedido: '',
    origemCanal: 'ecommerce' as const,
    clienteNome: '',
    clienteDocumento: '',
    clienteTelefone: '',
    clienteEmail: '',
    enderecoEntrega: '',
    numero: '',
    bairro: '',
    cidade: '',
    estado: 'SP',
    cep: '',
    cdId: '',
    slaLimiteHoras: 4,
    valorFrete: 25.0,
    itens: [
      { sku: 'SKU-LOGI-001', nome: 'Vinho Tinto Reserva 750ml', quantidade: 2, precoUnitario: 89.9, posicaoEnderecoCd: 'R01-P01-N1' },
      { sku: 'SKU-LOGI-002', nome: 'Gelo Especial Filtrado 5kg', quantidade: 1, precoUnitario: 18.0, posicaoEnderecoCd: 'R01-P02-N1' }
    ]
  });

  const [selectedOrderIdsForWave, setSelectedOrderIdsForWave] = useState<string[]>([]);
  const [waveType, setWaveType] = useState<'batch_wave' | 'single_order'>('batch_wave');

  // Packing Station Form State
  const [packingTargetOrder, setPackingTargetOrder] = useState<FulfillmentOrder | null>(null);
  const [packingBoxType, setPackingBoxType] = useState<'caixa_pequena' | 'caixa_media' | 'caixa_grande' | 'envelope_seguranca' | 'pallet'>('caixa_media');
  const [packingScaleWeight, setPackingScaleWeight] = useState<number>(0);
  const [packingLacre, setPackingLacre] = useState<string>('');
  const [scaleVarianceWarning, setScaleVarianceWarning] = useState<string | null>(null);

  // Dispatch Manifest Form State
  const [selectedOrderIdsForManifest, setSelectedOrderIdsForManifest] = useState<string[]>([]);
  const [manifestCarrierName, setManifestCarrierName] = useState('MoviLog Express Transportes');
  const [manifestDriverName, setManifestDriverName] = useState('Carlos Eduardo');
  const [manifestVehiclePlate, setManifestVehiclePlate] = useState('MOV-2026');

  // Reverse Logistics Form State
  const [reverseTargetOrderId, setReverseTargetOrderId] = useState('');
  const [reverseReason, setReverseReason] = useState<'desistencia_arrependimento' | 'defeito_avaria' | 'produto_incorreto' | 'insucesso_entrega'>('desistencia_arrependimento');

  // Feedback Messages
  const [actionSuccess, setActionSuccess] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  // Fetch initial data
  const loadData = async () => {
    try {
      setLoading(true);
      const [
        metricsRes,
        ordersRes,
        wavesRes,
        packingRes,
        manifestsRes,
        reverseRes,
        warehousesRes
      ] = await Promise.all([
        api.getFulfillmentMetrics().catch(() => ({ success: false, metrics: null })),
        api.getFulfillmentOrders().catch(() => ({ success: false, orders: [] })),
        api.getWavePickingTasks().catch(() => ({ success: false, waves: [] })),
        api.getPackingTasks().catch(() => ({ success: false, tasks: [] })),
        api.getShippingManifests().catch(() => ({ success: false, manifests: [] })),
        api.getReverseLogistics().catch(() => ({ success: false, tickets: [] })),
        api.getWarehouses().catch(() => ({ success: false, warehouses: [] }))
      ]);

      if (metricsRes.success && metricsRes.metrics) setMetrics(metricsRes.metrics);
      if (ordersRes.success) setOrders(ordersRes.orders);
      if (wavesRes.success) setWaves(wavesRes.waves);
      if (packingRes.success) setPackingTasks(packingRes.tasks);
      if (manifestsRes.success) setManifests(manifestsRes.manifests);
      if (reverseRes.success) setReverseTickets(reverseRes.tickets);
      if (warehousesRes.success) setWarehouses(warehousesRes.warehouses);
    } catch (err: any) {
      console.error('Erro ao carregar dados de fulfillment:', err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadData();
  }, []);

  const handleCreateOrder = async (e: React.FormEvent) => {
    e.preventDefault();
    setActionError(null);
    setActionSuccess(null);

    try {
      const res = await api.createFulfillmentOrder(newOrderForm);
      if (res.success) {
        setActionSuccess(`Pedido ${res.order.numeroPedido} criado com sucesso no Fulfillment!`);
        setShowNewOrderModal(false);
        loadData();
      }
    } catch (err: any) {
      setActionError(err.message || 'Falha ao criar pedido.');
    }
  };

  const handleCreateWave = async () => {
    if (selectedOrderIdsForWave.length === 0) {
      setActionError('Selecione ao menos um pedido para criar a onda de separação.');
      return;
    }
    setActionError(null);

    try {
      const res = await api.createWavePickingTask({
        pedidosIds: selectedOrderIdsForWave,
        tipo: waveType,
        operadorNome: user?.name || 'Operador MoviLog'
      });
      if (res.success) {
        setActionSuccess(`Onda ${res.wave.codigoOnda} criada com sucesso!`);
        setShowNewWaveModal(false);
        setSelectedOrderIdsForWave([]);
        loadData();
      }
    } catch (err: any) {
      setActionError(err.message || 'Falha ao gerar onda de separação.');
    }
  };

  const handlePickItem = async (waveId: string, itemIndex?: number, marcarTodos?: boolean) => {
    try {
      const res = await api.pickWaveItem(waveId, { itemIndex, marcarTodos });
      if (res.success) {
        setActionSuccess(res.message);
        loadData();
      }
    } catch (err: any) {
      setActionError(err.message || 'Erro ao bipar item.');
    }
  };

  const openPackingModalForOrder = (order: FulfillmentOrder) => {
    setPackingTargetOrder(order);
    const expected = order.pesoTotalKg || (order.volumesTotal * 0.85);
    setPackingScaleWeight(Number(expected.toFixed(2)));
    setPackingLacre(`LACRE-${Date.now().toString().slice(-6)}`);
    setScaleVarianceWarning(null);
    setShowPackingModal(true);
  };

  const handleExecutePacking = async (ignoreVariance = false) => {
    if (!packingTargetOrder) return;
    setActionError(null);

    try {
      const res = await api.executePacking({
        pedidoId: packingTargetOrder.id,
        tipoEmbalagem: packingBoxType,
        pesoBalancaKg: packingScaleWeight,
        lacreNumero: packingLacre,
        embaladorNome: user?.name || 'Embalador MoviLog',
        ignorarDivergenciaPeso: ignoreVariance
      });

      if (res.success) {
        setActionSuccess(`Pedido ${packingTargetOrder.numeroPedido} conferido e embalado! Etiqueta: ${res.etiquetaCodigo}`);
        setShowPackingModal(false);
        setPackingTargetOrder(null);
        loadData();
      }
    } catch (err: any) {
      if (err.divergencia) {
        setScaleVarianceWarning(err.error);
      } else {
        setActionError(err.message || 'Falha ao concluir embalagem.');
      }
    }
  };

  const handleCreateManifest = async () => {
    if (selectedOrderIdsForManifest.length === 0) {
      setActionError('Selecione ao menos um pedido pronto para expedição.');
      return;
    }
    setActionError(null);

    try {
      const res = await api.createShippingManifest({
        pedidosIds: selectedOrderIdsForManifest,
        transportadoraNome: manifestCarrierName,
        motoristaNome: manifestDriverName,
        veiculoPlaca: manifestVehiclePlate,
        observacoes: 'Despacho realizado via Estação de Expedição MoviLog'
      });

      if (res.success) {
        setActionSuccess(`Manifesto ${res.manifest.codigoManifesto} expedido com baixa física realizada no WMS!`);
        setShowManifestModal(false);
        setSelectedOrderIdsForManifest([]);
        loadData();
      }
    } catch (err: any) {
      setActionError(err.message || 'Falha ao expedir manifesto.');
    }
  };

  const handleCreateReverseTicket = async () => {
    if (!reverseTargetOrderId) {
      setActionError('Selecione o pedido entregue para solicitar a reversa.');
      return;
    }
    setActionError(null);

    try {
      const res = await api.createReverseTicket({
        pedidoOriginalId: reverseTargetOrderId,
        motivo: reverseReason
      });

      if (res.success) {
        setActionSuccess(`Logística reversa ${res.ticket.codigoReversa} aberta com sucesso! Código de postagem: ${res.ticket.codigoAutorizacaoPostagem}`);
        setShowReverseModal(false);
        setReverseTargetOrderId('');
        loadData();
      }
    } catch (err: any) {
      setActionError(err.message || 'Falha ao solicitar logística reversa.');
    }
  };

  const handleTriageTicket = async (ticketId: string, condicao: 'perfeito_reestocar' | 'avariado_descarte') => {
    try {
      const res = await api.triageReverseTicket(ticketId, {
        condicaoAposTriagem: condicao,
        liberarEstorno: true
      });
      if (res.success) {
        setActionSuccess(`Triagem concluída: ${res.message}`);
        loadData();
      }
    } catch (err: any) {
      setActionError(err.message || 'Falha ao registrar triagem.');
    }
  };

  // Pipeline Stage columns
  const stageColumns: { stage: FulfillmentStage; label: string; color: string; desc: string }[] = [
    { stage: 'recebido', label: '1. Recebido', color: 'border-blue-500/50 bg-blue-500/10 text-blue-400', desc: 'Integração de canais' },
    { stage: 'conferencia', label: '2. Conferência', color: 'border-indigo-500/50 bg-indigo-500/10 text-indigo-400', desc: 'Validação de dados' },
    { stage: 'picking', label: '3. Picking (Onda)', color: 'border-purple-500/50 bg-purple-500/10 text-purple-400', desc: 'Separação de SKU nos bins' },
    { stage: 'packing', label: '4. Packing Station', color: 'border-amber-500/50 bg-amber-500/10 text-amber-400', desc: 'Embalagem e balança' },
    { stage: 'expedicao', label: '5. Expedição', color: 'border-emerald-500/50 bg-emerald-500/10 text-emerald-400', desc: 'Pronto para manifesto' },
    { stage: 'transporte', label: '6. Em Transporte', color: 'border-cyan-500/50 bg-cyan-500/10 text-cyan-400', desc: 'Last-mile / Rodoviário' },
    { stage: 'entregue', label: '7. Entregue', color: 'border-green-500/50 bg-green-500/10 text-green-400', desc: 'Concluído com SLA' }
  ];

  const filteredOrders = orders.filter(o => {
    if (selectedCanal !== 'all' && o.origemCanal !== selectedCanal) return false;
    if (selectedCdId !== 'all' && o.cdId !== selectedCdId) return false;
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      return (
        o.numeroPedido.toLowerCase().includes(q) ||
        o.clienteNome.toLowerCase().includes(q) ||
        o.clienteDocumento.toLowerCase().includes(q)
      );
    }
    return true;
  });

  return (
    <div className="min-h-screen bg-[#070811] text-slate-100 p-4 md:p-6 space-y-6">
      {/* Header Banner */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 border-b border-purple-900/30 pb-5">
        <div>
          <div className="flex items-center gap-2.5">
            <span className="p-2 rounded-lg bg-purple-600/20 text-purple-400 border border-purple-500/30">
              <Layers className="w-6 h-6" />
            </span>
            <div>
              <h1 className="text-2xl font-bold tracking-tight text-white flex items-center gap-2">
                Fulfillment & Expedição
                <span className="text-xs px-2 py-0.5 rounded-full bg-purple-500/20 text-purple-300 border border-purple-500/30 font-medium">
                  Infracommerce Standard
                </span>
              </h1>
              <p className="text-xs text-slate-400">
                Gestão integrada de pedidos, separação por ondas (Wave Picking), estação de conferência e balança, etiquetas e manifestos com baixa física no WMS.
              </p>
            </div>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2.5">
          <button
            onClick={() => loadData()}
            className="flex items-center gap-1.5 px-3 py-2 text-xs font-medium text-slate-300 bg-slate-800/80 hover:bg-slate-700/80 rounded-lg border border-slate-700 transition"
          >
            <RefreshCw className="w-3.5 h-3.5" />
            Atualizar
          </button>

          <button
            onClick={() => setShowReverseModal(true)}
            className="flex items-center gap-1.5 px-3 py-2 text-xs font-medium text-amber-300 bg-amber-500/10 hover:bg-amber-500/20 rounded-lg border border-amber-500/30 transition"
          >
            <RotateCcw className="w-3.5 h-3.5" />
            Logística Reversa
          </button>

          <button
            onClick={() => setShowNewWaveModal(true)}
            className="flex items-center gap-1.5 px-3 py-2 text-xs font-medium text-purple-300 bg-purple-600/20 hover:bg-purple-600/30 rounded-lg border border-purple-500/30 transition"
          >
            <CheckSquare className="w-3.5 h-3.5" />
            Gerar Onda Picking
          </button>

          <button
            onClick={() => setShowManifestModal(true)}
            className="flex items-center gap-1.5 px-3 py-2 text-xs font-medium text-emerald-300 bg-emerald-600/20 hover:bg-emerald-600/30 rounded-lg border border-emerald-500/30 transition"
          >
            <Truck className="w-3.5 h-3.5" />
            Expedir Manifesto
          </button>

          <button
            onClick={() => setShowNewOrderModal(true)}
            className="flex items-center gap-1.5 px-4 py-2 text-xs font-semibold text-white bg-gradient-to-r from-purple-600 to-indigo-600 hover:from-purple-500 hover:to-indigo-500 rounded-lg shadow-lg shadow-purple-900/30 transition"
          >
            <Plus className="w-4 h-4" />
            Novo Pedido
          </button>
        </div>
      </div>

      {/* Action Messages */}
      {actionSuccess && (
        <div className="flex items-center justify-between p-3.5 rounded-lg bg-emerald-500/10 border border-emerald-500/30 text-emerald-300 text-xs">
          <div className="flex items-center gap-2">
            <CheckCircle2 className="w-4 h-4 shrink-0" />
            <span>{actionSuccess}</span>
          </div>
          <button onClick={() => setActionSuccess(null)} className="text-emerald-400 hover:text-white">
            <X className="w-4 h-4" />
          </button>
        </div>
      )}

      {actionError && (
        <div className="flex items-center justify-between p-3.5 rounded-lg bg-rose-500/10 border border-rose-500/30 text-rose-300 text-xs">
          <div className="flex items-center gap-2">
            <AlertTriangle className="w-4 h-4 shrink-0" />
            <span>{actionError}</span>
          </div>
          <button onClick={() => setActionError(null)} className="text-rose-400 hover:text-white">
            <X className="w-4 h-4" />
          </button>
        </div>
      )}

      {/* KPI & Metrics Bar */}
      {metrics && (
        <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-7 gap-3">
          <div className="bg-[#0e101f] border border-slate-800 p-3 rounded-xl">
            <span className="text-[11px] text-slate-400 block font-medium">Total Pedidos</span>
            <span className="text-xl font-bold text-white mt-1 block">{metrics.totalPedidos}</span>
            <span className="text-[10px] text-slate-500">{metrics.pedidosEmAndamento} em andamento</span>
          </div>

          <div className="bg-[#0e101f] border border-blue-900/40 p-3 rounded-xl">
            <span className="text-[11px] text-blue-400 block font-medium">1. Novos / Recebidos</span>
            <span className="text-xl font-bold text-blue-300 mt-1 block">{metrics.pedidosRecebidos}</span>
            <span className="text-[10px] text-slate-400">Aguardando picking</span>
          </div>

          <div className="bg-[#0e101f] border border-purple-900/40 p-3 rounded-xl">
            <span className="text-[11px] text-purple-400 block font-medium">2. Em Picking</span>
            <span className="text-xl font-bold text-purple-300 mt-1 block">{metrics.pedidosEmSeparacao}</span>
            <span className="text-[10px] text-slate-400">{metrics.totalOndasAtivas} ondas ativas</span>
          </div>

          <div className="bg-[#0e101f] border border-amber-900/40 p-3 rounded-xl">
            <span className="text-[11px] text-amber-400 block font-medium">3. Packing & Balança</span>
            <span className="text-xl font-bold text-amber-300 mt-1 block">{metrics.pedidosEmEmbalagem}</span>
            <span className="text-[10px] text-slate-400">{metrics.totalEmbaladosHoje} conferidos</span>
          </div>

          <div className="bg-[#0e101f] border border-emerald-900/40 p-3 rounded-xl">
            <span className="text-[11px] text-emerald-400 block font-medium">4. Doca de Expedição</span>
            <span className="text-xl font-bold text-emerald-300 mt-1 block">{metrics.pedidosProntosExpedicao}</span>
            <span className="text-[10px] text-slate-400">{metrics.totalManifestosExpedidos} manifestos</span>
          </div>

          <div className="bg-[#0e101f] border border-cyan-900/40 p-3 rounded-xl">
            <span className="text-[11px] text-cyan-400 block font-medium">5. Em Transporte</span>
            <span className="text-xl font-bold text-cyan-300 mt-1 block">{metrics.pedidosEmTransito}</span>
            <span className="text-[10px] text-slate-400">Em rota last-mile</span>
          </div>

          <div className="bg-[#0e101f] border border-emerald-900/40 p-3 rounded-xl">
            <span className="text-[11px] text-emerald-400 block font-medium">Taxa OTIF (SLA)</span>
            <span className="text-xl font-bold text-emerald-300 mt-1 block">{metrics.taxaOtifPercentual}%</span>
            <span className="text-[10px] text-slate-400">{metrics.tempoMedioCicloMinutos}m ciclo médio</span>
          </div>
        </div>
      )}

      {/* SLA Risk Alert Banner */}
      {metrics?.alertasRiscoSla && metrics.alertasRiscoSla.length > 0 && (
        <div className="p-3.5 rounded-xl bg-amber-500/10 border border-amber-500/30 text-amber-300 flex items-start gap-3">
          <AlertTriangle className="w-5 h-5 shrink-0 text-amber-400 mt-0.5" />
          <div className="space-y-1 text-xs">
            <span className="font-semibold block text-amber-200">
              Atenção: {metrics.alertasRiscoSla.length} pedido(s) com risco ou estouro de prazo SLA de expedição:
            </span>
            <div className="flex flex-wrap gap-2 pt-1">
              {metrics.alertasRiscoSla.map((al: any) => (
                <span
                  key={al.pedidoId}
                  className="px-2 py-0.5 rounded bg-black/40 border border-amber-500/30 text-[11px] flex items-center gap-1.5"
                >
                  <span className="font-mono text-white">{al.numeroPedido}</span>
                  <span className="text-slate-400">({al.etapaAtual})</span>
                  <span className="text-amber-400 font-medium">{al.motivo}</span>
                </span>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* Navigation Tabs */}
      <div className="flex border-b border-slate-800 gap-1 overflow-x-auto pb-px">
        <button
          onClick={() => setTab('pipeline')}
          className={`flex items-center gap-2 px-4 py-2.5 text-xs font-medium border-b-2 transition ${
            tab === 'pipeline'
              ? 'border-purple-500 text-purple-400 bg-purple-500/10'
              : 'border-transparent text-slate-400 hover:text-slate-200'
          }`}
        >
          <Layers className="w-4 h-4" />
          Pipeline Operacional (Kanban)
        </button>

        <button
          onClick={() => setTab('waves')}
          className={`flex items-center gap-2 px-4 py-2.5 text-xs font-medium border-b-2 transition ${
            tab === 'waves'
              ? 'border-purple-500 text-purple-400 bg-purple-500/10'
              : 'border-transparent text-slate-400 hover:text-slate-200'
          }`}
        >
          <CheckSquare className="w-4 h-4" />
          Ondas de Separação (Wave Picking)
          <span className="px-1.5 py-0.2 rounded-full bg-slate-800 text-[10px] text-slate-300">
            {waves.length}
          </span>
        </button>

        <button
          onClick={() => setTab('packing')}
          className={`flex items-center gap-2 px-4 py-2.5 text-xs font-medium border-b-2 transition ${
            tab === 'packing'
              ? 'border-purple-500 text-purple-400 bg-purple-500/10'
              : 'border-transparent text-slate-400 hover:text-slate-200'
          }`}
        >
          <Scale className="w-4 h-4" />
          Estação de Embalagem & Balança
          <span className="px-1.5 py-0.2 rounded-full bg-slate-800 text-[10px] text-slate-300">
            {packingTasks.length}
          </span>
        </button>

        <button
          onClick={() => setTab('manifests')}
          className={`flex items-center gap-2 px-4 py-2.5 text-xs font-medium border-b-2 transition ${
            tab === 'manifests'
              ? 'border-purple-500 text-purple-400 bg-purple-500/10'
              : 'border-transparent text-slate-400 hover:text-slate-200'
          }`}
        >
          <Truck className="w-4 h-4" />
          Manifestos de Expedição
          <span className="px-1.5 py-0.2 rounded-full bg-slate-800 text-[10px] text-slate-300">
            {manifests.length}
          </span>
        </button>

        <button
          onClick={() => setTab('reverse')}
          className={`flex items-center gap-2 px-4 py-2.5 text-xs font-medium border-b-2 transition ${
            tab === 'reverse'
              ? 'border-purple-500 text-purple-400 bg-purple-500/10'
              : 'border-transparent text-slate-400 hover:text-slate-200'
          }`}
        >
          <RotateCcw className="w-4 h-4" />
          Logística Reversa (RMA)
          <span className="px-1.5 py-0.2 rounded-full bg-slate-800 text-[10px] text-slate-300">
            {reverseTickets.length}
          </span>
        </button>
      </div>

      {/* Filters Toolbar */}
      <div className="flex flex-col sm:flex-row items-center justify-between gap-3 bg-[#0d0f1e] p-3 rounded-xl border border-slate-800/80">
        <div className="relative w-full sm:w-72">
          <Search className="w-4 h-4 absolute left-3 top-2.5 text-slate-500" />
          <input
            type="text"
            value={searchQuery}
            onChange={e => setSearchQuery(e.target.value)}
            placeholder="Buscar por nº pedido, cliente, CPF..."
            className="w-full bg-[#14172b] border border-slate-700/80 rounded-lg pl-9 pr-3 py-1.5 text-xs text-white placeholder-slate-500 focus:outline-none focus:border-purple-500"
          />
        </div>

        <div className="flex items-center gap-2.5 w-full sm:w-auto overflow-x-auto">
          <select
            value={selectedCanal}
            onChange={e => setSelectedCanal(e.target.value)}
            className="bg-[#14172b] border border-slate-700/80 text-xs text-slate-300 rounded-lg px-2.5 py-1.5 focus:outline-none focus:border-purple-500"
          >
            <option value="all">Todos os Canais</option>
            <option value="ecommerce">E-commerce</option>
            <option value="marketplace">Marketplace</option>
            <option value="b2b_empresarial">B2B Corporativo</option>
            <option value="manual">Entrada Manual</option>
          </select>

          {warehouses.length > 0 && (
            <select
              value={selectedCdId}
              onChange={e => setSelectedCdId(e.target.value)}
              className="bg-[#14172b] border border-slate-700/80 text-xs text-slate-300 rounded-lg px-2.5 py-1.5 focus:outline-none focus:border-purple-500"
            >
              <option value="all">Todos os CDs</option>
              {warehouses.map(w => (
                <option key={w.id} value={w.id}>
                  {w.codigo} - {w.nome}
                </option>
              ))}
            </select>
          )}
        </div>
      </div>

      {/* TAB 1: PIPELINE OPERACIONAL KANBAN */}
      {tab === 'pipeline' && (
        <div className="overflow-x-auto pb-4">
          <div className="flex gap-4 min-w-[1400px]">
            {stageColumns.map(col => {
              const ordersInStage = filteredOrders.filter(o => o.etapaAtual === col.stage);

              return (
                <div
                  key={col.stage}
                  className="w-[280px] shrink-0 bg-[#0c0e1c] border border-slate-800/80 rounded-xl flex flex-col max-h-[750px]"
                >
                  {/* Column Header */}
                  <div className="p-3 border-b border-slate-800/80 flex items-center justify-between">
                    <div>
                      <span className={`text-xs font-semibold px-2 py-0.5 rounded-full border ${col.color}`}>
                        {col.label}
                      </span>
                      <p className="text-[10px] text-slate-500 mt-1">{col.desc}</p>
                    </div>
                    <span className="text-xs font-mono font-bold text-slate-300 bg-slate-800/80 px-2 py-0.5 rounded-md">
                      {ordersInStage.length}
                    </span>
                  </div>

                  {/* Cards List */}
                  <div className="p-2 space-y-2.5 overflow-y-auto flex-1">
                    {ordersInStage.length === 0 ? (
                      <div className="text-center py-8 text-slate-600 text-xs">
                        Nenhum pedido nesta etapa
                      </div>
                    ) : (
                      ordersInStage.map(order => {
                        const isSelected = selectedOrderIdsForWave.includes(order.id) || selectedOrderIdsForManifest.includes(order.id);

                        return (
                          <div
                            key={order.id}
                            className={`p-3 rounded-lg border transition cursor-pointer ${
                              isSelected
                                ? 'bg-purple-950/40 border-purple-500'
                                : 'bg-[#121528] border-slate-800 hover:border-slate-700'
                            }`}
                            onClick={() => {
                              setSelectedOrder(order);
                              setShowOrderDetailsModal(true);
                            }}
                          >
                            <div className="flex items-center justify-between mb-1.5">
                              <span className="font-mono text-xs font-bold text-purple-400">
                                {order.numeroPedido}
                              </span>
                              <span className="text-[10px] text-slate-400 capitalize px-1.5 py-0.2 rounded bg-slate-800">
                                {order.origemCanal}
                              </span>
                            </div>

                            <div className="text-xs font-medium text-white truncate">
                              {order.clienteNome}
                            </div>
                            <div className="text-[10px] text-slate-400 flex items-center gap-1 mt-0.5">
                              <MapPin className="w-3 h-3 text-slate-500" />
                              {order.cidade} - {order.estado}
                            </div>

                            <div className="mt-2 pt-2 border-t border-slate-800/80 flex items-center justify-between text-[11px] text-slate-400">
                              <span>{order.volumesTotal} volume(s) • {order.pesoTotalKg} kg</span>
                              <span className="font-semibold text-slate-200">
                                R$ {order.valorTotalItens.toFixed(2)}
                              </span>
                            </div>

                            {/* WMS Position Tag */}
                            {order.itens && order.itens.length > 0 && (
                              <div className="mt-1.5 flex flex-wrap gap-1">
                                {order.itens.slice(0, 2).map((it, idx) => (
                                  <span
                                    key={idx}
                                    className="text-[9px] px-1.5 py-0.5 rounded bg-purple-900/30 text-purple-300 font-mono border border-purple-800/30"
                                  >
                                    {it.posicaoEnderecoCd || 'R01-P01-N1'}
                                  </span>
                                ))}
                                {order.itens.length > 2 && (
                                  <span className="text-[9px] text-slate-500">+{order.itens.length - 2}</span>
                                )}
                              </div>
                            )}

                            {/* Action Buttons inside Card */}
                            <div className="mt-2.5 pt-2 border-t border-slate-800/80 flex items-center justify-between gap-1.5" onClick={e => e.stopPropagation()}>
                              {col.stage === 'recebido' && (
                                <button
                                  onClick={() => {
                                    api.updateFulfillmentOrderStage(order.id, { novaEtapa: 'conferencia' })
                                      .then(() => loadData());
                                  }}
                                  className="w-full py-1 text-[10px] font-medium text-center text-indigo-300 bg-indigo-500/10 hover:bg-indigo-500/20 rounded border border-indigo-500/30"
                                >
                                  Iniciar Conferência →
                                </button>
                              )}

                              {col.stage === 'conferencia' && (
                                <button
                                  onClick={() => {
                                    setSelectedOrderIdsForWave([order.id]);
                                    setShowNewWaveModal(true);
                                  }}
                                  className="w-full py-1 text-[10px] font-medium text-center text-purple-300 bg-purple-500/10 hover:bg-purple-500/20 rounded border border-purple-500/30"
                                >
                                  Gerar Onda Picking →
                                </button>
                              )}

                              {col.stage === 'picking' && (
                                <button
                                  onClick={() => openPackingModalForOrder(order)}
                                  className="w-full py-1 text-[10px] font-medium text-center text-amber-300 bg-amber-500/10 hover:bg-amber-500/20 rounded border border-amber-500/30 flex items-center justify-center gap-1"
                                >
                                  <Scale className="w-3 h-3" />
                                  Balança & Embalagem →
                                </button>
                              )}

                              {col.stage === 'packing' && (
                                <button
                                  onClick={() => openPackingModalForOrder(order)}
                                  className="w-full py-1 text-[10px] font-medium text-center text-amber-300 bg-amber-500/10 hover:bg-amber-500/20 rounded border border-amber-500/30"
                                >
                                  Conferir Pesagem →
                                </button>
                              )}

                              {col.stage === 'expedicao' && (
                                <button
                                  onClick={() => {
                                    setSelectedOrderIdsForManifest([order.id]);
                                    setShowManifestModal(true);
                                  }}
                                  className="w-full py-1 text-[10px] font-medium text-center text-emerald-300 bg-emerald-500/10 hover:bg-emerald-500/20 rounded border border-emerald-500/30 flex items-center justify-center gap-1"
                                >
                                  <Truck className="w-3 h-3" />
                                  Expedir / Manifesto →
                                </button>
                              )}

                              {col.stage === 'transporte' && (
                                <button
                                  onClick={() => {
                                    api.updateFulfillmentOrderStage(order.id, { novaEtapa: 'entregue' })
                                      .then(() => loadData());
                                  }}
                                  className="w-full py-1 text-[10px] font-medium text-center text-green-300 bg-green-500/10 hover:bg-green-500/20 rounded border border-green-500/30 flex items-center justify-center gap-1"
                                >
                                  <CheckCircle2 className="w-3 h-3" />
                                  Confirmar Entrega
                                </button>
                              )}
                            </div>
                          </div>
                        );
                      })
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* TAB 2: ONDAS DE SEPARAÇÃO (WAVE PICKING) */}
      {tab === 'waves' && (
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <h2 className="text-base font-semibold text-white">Ondas de Separação (Wave Picking)</h2>
              <p className="text-xs text-slate-400">
                Agrupamento inteligente de pedidos por rota ou lote para separação rápida por endereço de CD.
              </p>
            </div>
            <button
              onClick={() => setShowNewWaveModal(true)}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold text-white bg-purple-600 hover:bg-purple-500 rounded-lg transition"
            >
              <Plus className="w-4 h-4" />
              Criar Nova Onda
            </button>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {waves.length === 0 ? (
              <div className="col-span-full py-12 text-center text-slate-500 text-xs bg-[#0c0e1c] rounded-xl border border-slate-800">
                Nenhuma onda de separação em andamento no momento.
              </div>
            ) : (
              waves.map(wave => {
                const totalItens = wave.itensPendentes.length;
                const totalConcluidos = wave.itensPendentes.filter(it => it.concluido).length;
                const percentual = totalItens > 0 ? Math.round((totalConcluidos / totalItens) * 100) : 0;

                return (
                  <div
                    key={wave.id}
                    className="p-4 rounded-xl bg-[#0d0f1e] border border-slate-800 space-y-3"
                  >
                    <div className="flex items-center justify-between">
                      <span className="font-mono text-xs font-bold text-purple-400">
                        {wave.codigoOnda}
                      </span>
                      <span
                        className={`text-[10px] font-semibold px-2 py-0.5 rounded-full ${
                          wave.status === 'concluida'
                            ? 'bg-green-500/20 text-green-300 border border-green-500/30'
                            : 'bg-amber-500/20 text-amber-300 border border-amber-500/30'
                        }`}
                      >
                        {wave.status.toUpperCase()}
                      </span>
                    </div>

                    <div className="text-xs text-slate-300">
                      Operador: <span className="font-semibold text-white">{wave.operadorNome || 'Não atribuído'}</span>
                      <span className="mx-2 text-slate-600">•</span>
                      Pedidos: <span className="font-semibold text-white">{wave.pedidosIds.length}</span>
                    </div>

                    {/* Progress Bar */}
                    <div className="space-y-1">
                      <div className="flex justify-between text-[11px] text-slate-400">
                        <span>Progresso de Bipagem</span>
                        <span className="font-mono font-semibold text-white">{percentual}% ({totalConcluidos}/{totalItens})</span>
                      </div>
                      <div className="w-full bg-slate-800 h-2 rounded-full overflow-hidden">
                        <div
                          className="bg-purple-500 h-full transition-all"
                          style={{ width: `${percentual}%` }}
                        />
                      </div>
                    </div>

                    {/* Items checklist */}
                    <div className="space-y-1.5 max-h-48 overflow-y-auto pt-2 border-t border-slate-800/80">
                      {wave.itensPendentes.map((item, idx) => (
                        <div
                          key={idx}
                          className={`p-2 rounded flex items-center justify-between text-xs border ${
                            item.concluido
                              ? 'bg-green-950/20 border-green-900/30 text-green-300'
                              : 'bg-slate-900/50 border-slate-800 text-slate-300'
                          }`}
                        >
                          <div className="space-y-0.5">
                            <div className="font-medium truncate max-w-[180px]">{item.nome}</div>
                            <div className="text-[10px] font-mono text-purple-400">
                              Pos: {item.posicaoEndereco} • SKU: {item.sku}
                            </div>
                          </div>

                          <div className="flex items-center gap-2">
                            <span className="text-[11px] font-mono">{item.quantidade}x</span>
                            {!item.concluido && (
                              <button
                                onClick={() => handlePickItem(wave.id, idx)}
                                className="px-2 py-0.5 text-[10px] font-medium text-white bg-purple-600 hover:bg-purple-500 rounded border border-purple-500/50"
                              >
                                Bipar
                              </button>
                            )}
                            {item.concluido && <CheckCircle2 className="w-4 h-4 text-green-400" />}
                          </div>
                        </div>
                      ))}
                    </div>

                    {wave.status !== 'concluida' && (
                      <button
                        onClick={() => handlePickItem(wave.id, undefined, true)}
                        className="w-full py-1.5 text-xs font-semibold text-purple-300 bg-purple-600/20 hover:bg-purple-600/30 rounded-lg border border-purple-500/30 transition"
                      >
                        Concluir Todos os Itens da Onda
                      </button>
                    )}
                  </div>
                );
              })
            )}
          </div>
        </div>
      )}

      {/* TAB 3: PACKING STATION */}
      {tab === 'packing' && (
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <h2 className="text-base font-semibold text-white">Estação de Embalagem & Balança</h2>
              <p className="text-xs text-slate-400">
                Conferência física final com integração de balança de pesagem, tolerância de desvio e etiquetagem térmica.
              </p>
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {packingTasks.length === 0 ? (
              <div className="col-span-full py-12 text-center text-slate-500 text-xs bg-[#0c0e1c] rounded-xl border border-slate-800">
                Nenhum pedido embalado registrado nesta sessão.
              </div>
            ) : (
              packingTasks.map(task => (
                <div
                  key={task.id}
                  className="p-4 rounded-xl bg-[#0d0f1e] border border-slate-800 space-y-3"
                >
                  <div className="flex items-center justify-between">
                    <span className="font-mono text-xs font-bold text-amber-400">
                      {task.pedidoNumero}
                    </span>
                    <span className="text-[10px] font-semibold px-2 py-0.5 rounded-full bg-emerald-500/20 text-emerald-300 border border-emerald-500/30">
                      100% CONFERIDO
                    </span>
                  </div>

                  <div className="text-xs text-slate-300 space-y-1">
                    <div>Embalador: <span className="font-semibold text-white">{task.embaladorNome}</span></div>
                    <div>Embalagem: <span className="font-semibold text-white capitalize">{task.tipoEmbalagem.replace('_', ' ')}</span></div>
                    <div>Peso Balança: <span className="font-semibold text-amber-300">{task.pesoBalancaKg} kg</span></div>
                    <div>Lacre de Segurança: <span className="font-mono font-semibold text-white">{task.lacreNumero || 'N/A'}</span></div>
                  </div>

                  <div className="p-2.5 rounded bg-black/40 border border-slate-800 text-[11px] text-slate-400 flex items-center justify-between">
                    <span className="flex items-center gap-1.5">
                      <Barcode className="w-4 h-4 text-purple-400" />
                      Etiqueta Térmica Ativa
                    </span>
                    <span className="font-mono text-white text-[10px]">
                      ML-LBL-{task.pedidoNumero}
                    </span>
                  </div>
                </div>
              ))
            )}
          </div>
        </div>
      )}

      {/* TAB 4: MANIFESTOS DE EXPEDIÇÃO */}
      {tab === 'manifests' && (
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <h2 className="text-base font-semibold text-white">Manifestos de Carga & Expedição</h2>
              <p className="text-xs text-slate-400">
                Romaneios de despacho para transportadoras parceiras e frotas dedicadas com conciliação automática de estoque WMS.
              </p>
            </div>
            <button
              onClick={() => setShowManifestModal(true)}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold text-white bg-emerald-600 hover:bg-emerald-500 rounded-lg transition"
            >
              <Plus className="w-4 h-4" />
              Novo Manifesto
            </button>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {manifests.length === 0 ? (
              <div className="col-span-full py-12 text-center text-slate-500 text-xs bg-[#0c0e1c] rounded-xl border border-slate-800">
                Nenhum manifesto de carga emitido até o momento.
              </div>
            ) : (
              manifests.map(man => (
                <div
                  key={man.id}
                  className="p-4 rounded-xl bg-[#0d0f1e] border border-slate-800 space-y-3"
                >
                  <div className="flex items-center justify-between">
                    <span className="font-mono text-xs font-bold text-emerald-400">
                      {man.codigoManifesto}
                    </span>
                    <span className="text-[10px] font-semibold px-2 py-0.5 rounded-full bg-cyan-500/20 text-cyan-300 border border-cyan-500/30">
                      {man.status.toUpperCase()}
                    </span>
                  </div>

                  <div className="grid grid-cols-2 gap-2 text-xs text-slate-300">
                    <div>Transportadora: <span className="font-semibold text-white">{man.transportadoraNome}</span></div>
                    <div>Motorista: <span className="font-semibold text-white">{man.motoristaNome}</span></div>
                    <div>Placa Veículo: <span className="font-mono font-semibold text-purple-300">{man.veiculoPlaca}</span></div>
                    <div>Total Pedidos: <span className="font-semibold text-white">{man.totalPedidos}</span></div>
                    <div>Volumes: <span className="font-semibold text-white">{man.totalVolumes}</span></div>
                    <div>Peso Total: <span className="font-semibold text-white">{man.totalPesoKg} kg</span></div>
                  </div>

                  <div className="p-2.5 rounded bg-emerald-950/20 border border-emerald-900/30 text-[11px] text-emerald-300 flex items-center justify-between">
                    <span>Valor da Carga Despachada:</span>
                    <span className="font-bold text-white text-xs">R$ {man.valorTotalCarga.toFixed(2)}</span>
                  </div>
                </div>
              ))
            )}
          </div>
        </div>
      )}

      {/* TAB 5: LOGÍSTICA REVERSA */}
      {tab === 'reverse' && (
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <h2 className="text-base font-semibold text-white">Logística Reversa & RMA</h2>
              <p className="text-xs text-slate-400">
                Controle de devoluções, autorizações de postagem reversa e triagem técnica para reestocagem física no CD.
              </p>
            </div>
            <button
              onClick={() => setShowReverseModal(true)}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold text-white bg-amber-600 hover:bg-amber-500 rounded-lg transition"
            >
              <Plus className="w-4 h-4" />
              Abrir Ticket Reverso
            </button>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {reverseTickets.length === 0 ? (
              <div className="col-span-full py-12 text-center text-slate-500 text-xs bg-[#0c0e1c] rounded-xl border border-slate-800">
                Nenhum ticket de logística reversa registrado.
              </div>
            ) : (
              reverseTickets.map(ticket => (
                <div
                  key={ticket.id}
                  className="p-4 rounded-xl bg-[#0d0f1e] border border-slate-800 space-y-3"
                >
                  <div className="flex items-center justify-between">
                    <span className="font-mono text-xs font-bold text-amber-400">
                      {ticket.codigoReversa}
                    </span>
                    <span className="text-[10px] font-semibold px-2 py-0.5 rounded-full bg-amber-500/20 text-amber-300 border border-amber-500/30">
                      {ticket.status.toUpperCase()}
                    </span>
                  </div>

                  <div className="text-xs text-slate-300 space-y-1">
                    <div>Pedido Original: <span className="font-mono font-semibold text-white">{ticket.pedidoOriginalNumero}</span></div>
                    <div>Cliente: <span className="font-semibold text-white">{ticket.clienteNome}</span></div>
                    <div>Motivo: <span className="capitalize text-slate-400">{ticket.motivo.replace('_', ' ')}</span></div>
                    <div>Código Postagem: <span className="font-mono font-semibold text-purple-300">{ticket.codigoAutorizacaoPostagem}</span></div>
                  </div>

                  {ticket.destinacaoFinal && (
                    <div className="p-2 rounded bg-green-950/20 border border-green-900/30 text-[11px] text-green-300">
                      Destinação: {ticket.destinacaoFinal}
                    </div>
                  )}

                  {ticket.status === 'solicitada' && (
                    <div className="flex gap-2 pt-2 border-t border-slate-800/80">
                      <button
                        onClick={() => handleTriageTicket(ticket.id, 'perfeito_reestocar')}
                        className="flex-1 py-1 text-[11px] font-medium text-emerald-300 bg-emerald-600/20 hover:bg-emerald-600/30 rounded border border-emerald-500/30"
                      >
                        Reestocar no CD
                      </button>
                      <button
                        onClick={() => handleTriageTicket(ticket.id, 'avariado_descarte')}
                        className="flex-1 py-1 text-[11px] font-medium text-rose-300 bg-rose-600/20 hover:bg-rose-600/30 rounded border border-rose-500/30"
                      >
                        Descarte / Avaria
                      </button>
                    </div>
                  )}
                </div>
              ))
            )}
          </div>
        </div>
      )}

      {/* MODAL: NOVO PEDIDO */}
      {showNewOrderModal && (
        <div className="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="bg-[#0e1022] border border-slate-800 rounded-xl w-full max-w-xl max-h-[90vh] overflow-y-auto p-5 space-y-4">
            <div className="flex items-center justify-between border-b border-slate-800 pb-3">
              <h3 className="text-base font-bold text-white flex items-center gap-2">
                <Plus className="w-5 h-5 text-purple-400" />
                Criar Pedido de Fulfillment
              </h3>
              <button onClick={() => setShowNewOrderModal(false)} className="text-slate-400 hover:text-white">
                <X className="w-5 h-5" />
              </button>
            </div>

            <form onSubmit={handleCreateOrder} className="space-y-3.5">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-xs text-slate-400 block mb-1">Nº Pedido (Opcional)</label>
                  <input
                    type="text"
                    value={newOrderForm.numeroPedido}
                    onChange={e => setNewOrderForm({ ...newOrderForm, numeroPedido: e.target.value })}
                    placeholder="PED-FUL-XXXX"
                    className="w-full bg-[#14172b] border border-slate-700 rounded-lg px-3 py-1.5 text-xs text-white"
                  />
                </div>
                <div>
                  <label className="text-xs text-slate-400 block mb-1">Canal de Venda</label>
                  <select
                    value={newOrderForm.origemCanal}
                    onChange={e => setNewOrderForm({ ...newOrderForm, origemCanal: e.target.value as any })}
                    className="w-full bg-[#14172b] border border-slate-700 rounded-lg px-3 py-1.5 text-xs text-white"
                  >
                    <option value="ecommerce">E-commerce Próprio</option>
                    <option value="marketplace">Marketplace</option>
                    <option value="b2b_empresarial">B2B Corporativo</option>
                    <option value="manual">Entrada Manual Balcão</option>
                  </select>
                </div>
              </div>

              <div>
                <label className="text-xs text-slate-400 block mb-1">Nome do Cliente *</label>
                <input
                  type="text"
                  required
                  value={newOrderForm.clienteNome}
                  onChange={e => setNewOrderForm({ ...newOrderForm, clienteNome: e.target.value })}
                  placeholder="Nome completo ou Razão Social"
                  className="w-full bg-[#14172b] border border-slate-700 rounded-lg px-3 py-1.5 text-xs text-white"
                />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-xs text-slate-400 block mb-1">CPF / CNPJ</label>
                  <input
                    type="text"
                    value={newOrderForm.clienteDocumento}
                    onChange={e => setNewOrderForm({ ...newOrderForm, clienteDocumento: e.target.value })}
                    placeholder="000.000.000-00"
                    className="w-full bg-[#14172b] border border-slate-700 rounded-lg px-3 py-1.5 text-xs text-white"
                  />
                </div>
                <div>
                  <label className="text-xs text-slate-400 block mb-1">Telefone</label>
                  <input
                    type="text"
                    value={newOrderForm.clienteTelefone}
                    onChange={e => setNewOrderForm({ ...newOrderForm, clienteTelefone: e.target.value })}
                    placeholder="(11) 99999-9999"
                    className="w-full bg-[#14172b] border border-slate-700 rounded-lg px-3 py-1.5 text-xs text-white"
                  />
                </div>
              </div>

              <div className="grid grid-cols-3 gap-3">
                <div className="col-span-2">
                  <label className="text-xs text-slate-400 block mb-1">Endereço de Entrega</label>
                  <input
                    type="text"
                    value={newOrderForm.enderecoEntrega}
                    onChange={e => setNewOrderForm({ ...newOrderForm, enderecoEntrega: e.target.value })}
                    placeholder="Rua, Av, Alameda"
                    className="w-full bg-[#14172b] border border-slate-700 rounded-lg px-3 py-1.5 text-xs text-white"
                  />
                </div>
                <div>
                  <label className="text-xs text-slate-400 block mb-1">Número</label>
                  <input
                    type="text"
                    value={newOrderForm.numero}
                    onChange={e => setNewOrderForm({ ...newOrderForm, numero: e.target.value })}
                    placeholder="100"
                    className="w-full bg-[#14172b] border border-slate-700 rounded-lg px-3 py-1.5 text-xs text-white"
                  />
                </div>
              </div>

              <div className="grid grid-cols-3 gap-3">
                <div>
                  <label className="text-xs text-slate-400 block mb-1">Cidade</label>
                  <input
                    type="text"
                    value={newOrderForm.cidade}
                    onChange={e => setNewOrderForm({ ...newOrderForm, cidade: e.target.value })}
                    placeholder="São Paulo"
                    className="w-full bg-[#14172b] border border-slate-700 rounded-lg px-3 py-1.5 text-xs text-white"
                  />
                </div>
                <div>
                  <label className="text-xs text-slate-400 block mb-1">Estado</label>
                  <input
                    type="text"
                    value={newOrderForm.estado}
                    onChange={e => setNewOrderForm({ ...newOrderForm, estado: e.target.value })}
                    placeholder="SP"
                    className="w-full bg-[#14172b] border border-slate-700 rounded-lg px-3 py-1.5 text-xs text-white"
                  />
                </div>
                <div>
                  <label className="text-xs text-slate-400 block mb-1">SLA Limite (h)</label>
                  <input
                    type="number"
                    value={newOrderForm.slaLimiteHoras}
                    onChange={e => setNewOrderForm({ ...newOrderForm, slaLimiteHoras: Number(e.target.value) })}
                    className="w-full bg-[#14172b] border border-slate-700 rounded-lg px-3 py-1.5 text-xs text-white"
                  />
                </div>
              </div>

              <div className="pt-2">
                <button
                  type="submit"
                  className="w-full py-2.5 text-xs font-semibold text-white bg-gradient-to-r from-purple-600 to-indigo-600 hover:from-purple-500 hover:to-indigo-500 rounded-lg transition"
                >
                  Salvar e Iniciar Pipeline de Fulfillment
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* MODAL: ESTAÇÃO DE EMBALAGEM & BALANÇA */}
      {showPackingModal && packingTargetOrder && (
        <div className="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="bg-[#0e1022] border border-slate-800 rounded-xl w-full max-w-lg p-5 space-y-4">
            <div className="flex items-center justify-between border-b border-slate-800 pb-3">
              <h3 className="text-base font-bold text-white flex items-center gap-2">
                <Scale className="w-5 h-5 text-amber-400" />
                Estação de Embalagem & Balança
              </h3>
              <button onClick={() => setShowPackingModal(false)} className="text-slate-400 hover:text-white">
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="p-3 rounded-lg bg-black/40 border border-slate-800 text-xs space-y-1">
              <div>Pedido: <span className="font-mono font-bold text-purple-400">{packingTargetOrder.numeroPedido}</span></div>
              <div>Cliente: <span className="text-white font-medium">{packingTargetOrder.clienteNome}</span></div>
              <div>Volumes Totais: <span className="text-white font-medium">{packingTargetOrder.volumesTotal}</span></div>
              <div>Peso Estimado: <span className="text-slate-300 font-medium">{packingTargetOrder.pesoTotalKg} kg</span></div>
            </div>

            {scaleVarianceWarning && (
              <div className="p-3 rounded-lg bg-rose-500/10 border border-rose-500/30 text-rose-300 text-xs space-y-2">
                <div className="flex items-center gap-2 font-semibold">
                  <AlertTriangle className="w-4 h-4" />
                  {scaleVarianceWarning}
                </div>
                <button
                  onClick={() => handleExecutePacking(true)}
                  className="w-full py-1 text-xs font-semibold text-white bg-rose-600 hover:bg-rose-500 rounded transition"
                >
                  Autorizar com Justificativa e Continuar
                </button>
              </div>
            )}

            <div className="space-y-3">
              <div>
                <label className="text-xs text-slate-400 block mb-1">Tipo de Embalagem</label>
                <select
                  value={packingBoxType}
                  onChange={e => setPackingBoxType(e.target.value as any)}
                  className="w-full bg-[#14172b] border border-slate-700 rounded-lg px-3 py-1.5 text-xs text-white"
                >
                  <option value="caixa_pequena">Caixa Pequena (até 2 kg)</option>
                  <option value="caixa_media">Caixa Média (2 a 8 kg)</option>
                  <option value="caixa_grande">Caixa Grande (8 a 25 kg)</option>
                  <option value="envelope_seguranca">Envelope Bolha de Segurança</option>
                  <option value="pallet">Pallet de Madeira</option>
                </select>
              </div>

              <div>
                <label className="text-xs text-slate-400 block mb-1">Peso Aferido na Balança (kg) *</label>
                <div className="relative">
                  <Scale className="w-4 h-4 absolute left-3 top-2.5 text-amber-400" />
                  <input
                    type="number"
                    step="0.01"
                    value={packingScaleWeight}
                    onChange={e => setPackingScaleWeight(Number(e.target.value))}
                    className="w-full bg-[#14172b] border border-slate-700 rounded-lg pl-9 pr-3 py-1.5 text-xs text-white font-mono"
                  />
                </div>
              </div>

              <div>
                <label className="text-xs text-slate-400 block mb-1">Nº Lacre de Segurança</label>
                <input
                  type="text"
                  value={packingLacre}
                  onChange={e => setPackingLacre(e.target.value)}
                  className="w-full bg-[#14172b] border border-slate-700 rounded-lg px-3 py-1.5 text-xs text-white font-mono"
                />
              </div>

              <button
                onClick={() => handleExecutePacking(false)}
                className="w-full py-2.5 text-xs font-semibold text-white bg-gradient-to-r from-amber-600 to-orange-600 hover:from-amber-500 hover:to-orange-500 rounded-lg transition"
              >
                Concluir Embalagem & Gerar Etiqueta Térmica
              </button>
            </div>
          </div>
        </div>
      )}

      {/* MODAL: MANIFESTO DE EXPEDIÇÃO */}
      {showManifestModal && (
        <div className="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="bg-[#0e1022] border border-slate-800 rounded-xl w-full max-w-lg p-5 space-y-4">
            <div className="flex items-center justify-between border-b border-slate-800 pb-3">
              <h3 className="text-base font-bold text-white flex items-center gap-2">
                <Truck className="w-5 h-5 text-emerald-400" />
                Expedir Manifesto de Carga (Romaneio)
              </h3>
              <button onClick={() => setShowManifestModal(false)} className="text-slate-400 hover:text-white">
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="space-y-3">
              <div>
                <label className="text-xs text-slate-400 block mb-1">Transportadora Parceira</label>
                <input
                  type="text"
                  value={manifestCarrierName}
                  onChange={e => setManifestCarrierName(e.target.value)}
                  className="w-full bg-[#14172b] border border-slate-700 rounded-lg px-3 py-1.5 text-xs text-white"
                />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-xs text-slate-400 block mb-1">Motorista</label>
                  <input
                    type="text"
                    value={manifestDriverName}
                    onChange={e => setManifestDriverName(e.target.value)}
                    className="w-full bg-[#14172b] border border-slate-700 rounded-lg px-3 py-1.5 text-xs text-white"
                  />
                </div>
                <div>
                  <label className="text-xs text-slate-400 block mb-1">Placa Veículo</label>
                  <input
                    type="text"
                    value={manifestVehiclePlate}
                    onChange={e => setManifestVehiclePlate(e.target.value)}
                    className="w-full bg-[#14172b] border border-slate-700 rounded-lg px-3 py-1.5 text-xs text-white font-mono"
                  />
                </div>
              </div>

              <div>
                <label className="text-xs text-slate-400 block mb-1.5">
                  Selecione os Pedidos Prontos para Despacho ({selectedOrderIdsForManifest.length} selecionados):
                </label>
                <div className="max-h-40 overflow-y-auto space-y-1.5 p-2 rounded bg-black/40 border border-slate-800">
                  {orders.filter(o => o.etapaAtual === 'expedicao').length === 0 ? (
                    <div className="text-center py-4 text-slate-500 text-xs">
                      Nenhum pedido na etapa de expedição.
                    </div>
                  ) : (
                    orders
                      .filter(o => o.etapaAtual === 'expedicao')
                      .map(o => {
                        const checked = selectedOrderIdsForManifest.includes(o.id);
                        return (
                          <div
                            key={o.id}
                            onClick={() => {
                              if (checked) {
                                setSelectedOrderIdsForManifest(selectedOrderIdsForManifest.filter(id => id !== o.id));
                              } else {
                                setSelectedOrderIdsForManifest([...selectedOrderIdsForManifest, o.id]);
                              }
                            }}
                            className={`p-2 rounded flex items-center justify-between text-xs cursor-pointer border ${
                              checked
                                ? 'bg-emerald-950/30 border-emerald-500/50 text-white'
                                : 'bg-slate-900/40 border-slate-800 text-slate-400'
                            }`}
                          >
                            <span className="font-mono font-semibold text-purple-400">{o.numeroPedido}</span>
                            <span>{o.clienteNome}</span>
                            <span className="font-mono">{o.volumesTotal} vol</span>
                          </div>
                        );
                      })
                  )}
                </div>
              </div>

              <div className="p-3 rounded bg-blue-950/20 border border-blue-900/30 text-[11px] text-blue-300">
                Aviso: Ao despachar o manifesto, o MoviLog realizará a baixa física imediata dos SKUs nas posições tridimensionais do CD (WMS).
              </div>

              <button
                onClick={handleCreateManifest}
                className="w-full py-2.5 text-xs font-semibold text-white bg-gradient-to-r from-emerald-600 to-teal-600 hover:from-emerald-500 hover:to-teal-500 rounded-lg transition"
              >
                Despachar Manifesto & Efetuar Baixa no WMS
              </button>
            </div>
          </div>
        </div>
      )}

      {/* MODAL: LOGÍSTICA REVERSA */}
      {showReverseModal && (
        <div className="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="bg-[#0e1022] border border-slate-800 rounded-xl w-full max-w-lg p-5 space-y-4">
            <div className="flex items-center justify-between border-b border-slate-800 pb-3">
              <h3 className="text-base font-bold text-white flex items-center gap-2">
                <RotateCcw className="w-5 h-5 text-amber-400" />
                Abertura de Logística Reversa (RMA)
              </h3>
              <button onClick={() => setShowReverseModal(false)} className="text-slate-400 hover:text-white">
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="space-y-3">
              <div>
                <label className="text-xs text-slate-400 block mb-1">Selecione o Pedido:</label>
                <select
                  value={reverseTargetOrderId}
                  onChange={e => setReverseTargetOrderId(e.target.value)}
                  className="w-full bg-[#14172b] border border-slate-700 rounded-lg px-3 py-1.5 text-xs text-white"
                >
                  <option value="">Selecione um pedido entregue ou em rota...</option>
                  {orders.map(o => (
                    <option key={o.id} value={o.id}>
                      {o.numeroPedido} - {o.clienteNome} ({o.etapaAtual})
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label className="text-xs text-slate-400 block mb-1">Motivo da Devolução:</label>
                <select
                  value={reverseReason}
                  onChange={e => setReverseReason(e.target.value as any)}
                  className="w-full bg-[#14172b] border border-slate-700 rounded-lg px-3 py-1.5 text-xs text-white"
                >
                  <option value="desistencia_arrependimento">Arrependimento / Desistência (7 dias)</option>
                  <option value="defeito_avaria">Defeito Técnico / Avaria no Transporte</option>
                  <option value="produto_incorreto">Item Incorreto / Divergência de Pedido</option>
                  <option value="insucesso_entrega">Insucesso de Entrega (Destinatário Ausente)</option>
                </select>
              </div>

              <button
                onClick={handleCreateReverseTicket}
                className="w-full py-2.5 text-xs font-semibold text-white bg-gradient-to-r from-amber-600 to-orange-600 hover:from-amber-500 hover:to-orange-500 rounded-lg transition"
              >
                Gerar Autorização de Postagem Reversa
              </button>
            </div>
          </div>
        </div>
      )}

      {/* MODAL: NOVA ONDA DE SEPARAÇÃO */}
      {showNewWaveModal && (
        <div className="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="bg-[#0e1022] border border-slate-800 rounded-xl w-full max-w-lg p-5 space-y-4">
            <div className="flex items-center justify-between border-b border-slate-800 pb-3">
              <h3 className="text-base font-bold text-white flex items-center gap-2">
                <CheckSquare className="w-5 h-5 text-purple-400" />
                Criar Onda de Separação (Wave Picking)
              </h3>
              <button onClick={() => setShowNewWaveModal(false)} className="text-slate-400 hover:text-white">
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="space-y-3">
              <div>
                <label className="text-xs text-slate-400 block mb-1">Tipo de Onda</label>
                <div className="grid grid-cols-2 gap-2">
                  <button
                    type="button"
                    onClick={() => setWaveType('batch_wave')}
                    className={`p-2.5 rounded-lg border text-xs text-center font-medium transition ${
                      waveType === 'batch_wave'
                        ? 'bg-purple-600/20 border-purple-500 text-purple-300'
                        : 'bg-slate-900/40 border-slate-800 text-slate-400'
                    }`}
                  >
                    Onda em Lote (Batch Wave)
                  </button>
                  <button
                    type="button"
                    onClick={() => setWaveType('single_order')}
                    className={`p-2.5 rounded-lg border text-xs text-center font-medium transition ${
                      waveType === 'single_order'
                        ? 'bg-purple-600/20 border-purple-500 text-purple-300'
                        : 'bg-slate-900/40 border-slate-800 text-slate-400'
                    }`}
                  >
                    Pedido Individual (Single Order)
                  </button>
                </div>
              </div>

              <div>
                <label className="text-xs text-slate-400 block mb-1.5">
                  Selecione os Pedidos para a Onda ({selectedOrderIdsForWave.length} selecionados):
                </label>
                <div className="max-h-48 overflow-y-auto space-y-1.5 p-2 rounded bg-black/40 border border-slate-800">
                  {orders.filter(o => ['recebido', 'conferencia', 'picking'].includes(o.etapaAtual)).length === 0 ? (
                    <div className="text-center py-4 text-slate-500 text-xs">
                      Nenhum pedido pendente de picking.
                    </div>
                  ) : (
                    orders
                      .filter(o => ['recebido', 'conferencia', 'picking'].includes(o.etapaAtual))
                      .map(o => {
                        const checked = selectedOrderIdsForWave.includes(o.id);
                        return (
                          <div
                            key={o.id}
                            onClick={() => {
                              if (checked) {
                                setSelectedOrderIdsForWave(selectedOrderIdsForWave.filter(id => id !== o.id));
                              } else {
                                setSelectedOrderIdsForWave([...selectedOrderIdsForWave, o.id]);
                              }
                            }}
                            className={`p-2 rounded flex items-center justify-between text-xs cursor-pointer border ${
                              checked
                                ? 'bg-purple-950/40 border-purple-500/50 text-white'
                                : 'bg-slate-900/40 border-slate-800 text-slate-400'
                            }`}
                          >
                            <span className="font-mono font-semibold text-purple-400">{o.numeroPedido}</span>
                            <span>{o.clienteNome}</span>
                            <span className="font-mono">{o.volumesTotal} vol</span>
                          </div>
                        );
                      })
                  )}
                </div>
              </div>

              <button
                onClick={handleCreateWave}
                className="w-full py-2.5 text-xs font-semibold text-white bg-gradient-to-r from-purple-600 to-indigo-600 hover:from-purple-500 hover:to-indigo-500 rounded-lg transition"
              >
                Gerar Rota Ótima de Separação
              </button>
            </div>
          </div>
        </div>
      )}

      {/* MODAL: DETALHES DO PEDIDO */}
      {showOrderDetailsModal && selectedOrder && (
        <div className="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="bg-[#0e1022] border border-slate-800 rounded-xl w-full max-w-xl max-h-[90vh] overflow-y-auto p-5 space-y-4">
            <div className="flex items-center justify-between border-b border-slate-800 pb-3">
              <div>
                <h3 className="text-base font-bold text-white flex items-center gap-2">
                  Pedido {selectedOrder.numeroPedido}
                </h3>
                <span className="text-xs text-slate-400">{selectedOrder.clienteNome}</span>
              </div>
              <button onClick={() => setShowOrderDetailsModal(false)} className="text-slate-400 hover:text-white">
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="space-y-3">
              <div className="grid grid-cols-2 gap-2 text-xs p-3 rounded-lg bg-black/40 border border-slate-800">
                <div>Etapa Atual: <span className="font-bold text-purple-400 uppercase">{selectedOrder.etapaAtual}</span></div>
                <div>Canal: <span className="font-medium text-white capitalize">{selectedOrder.origemCanal}</span></div>
                <div>Volumes: <span className="font-medium text-white">{selectedOrder.volumesTotal}</span></div>
                <div>Peso Total: <span className="font-medium text-white">{selectedOrder.pesoTotalKg} kg</span></div>
                <div>Valor Total: <span className="font-bold text-emerald-400">R$ {selectedOrder.valorTotalItens.toFixed(2)}</span></div>
                <div>Rastreio: <span className="font-mono text-cyan-300">{selectedOrder.codigoRastreio || 'Pendente'}</span></div>
              </div>

              <div>
                <h4 className="text-xs font-semibold text-slate-300 mb-1.5">Itens do Pedido & Endereço WMS:</h4>
                <div className="space-y-1.5 max-h-40 overflow-y-auto">
                  {selectedOrder.itens.map((it, idx) => (
                    <div key={idx} className="p-2 rounded bg-slate-900/50 border border-slate-800 text-xs flex justify-between items-center">
                      <div>
                        <div className="font-medium text-white">{it.nome}</div>
                        <div className="text-[10px] text-purple-400 font-mono">Posição CD: {it.posicaoEnderecoCd} • SKU: {it.sku}</div>
                      </div>
                      <div className="text-right font-mono">
                        <div>{it.quantidade}x</div>
                        <div className="text-slate-400 text-[10px]">R$ {it.precoUnitario.toFixed(2)}</div>
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              <div>
                <h4 className="text-xs font-semibold text-slate-300 mb-1.5">Histórico do Ciclo de Fulfillment:</h4>
                <div className="space-y-1.5 max-h-40 overflow-y-auto">
                  {selectedOrder.historicoEtapas.map((st, idx) => (
                    <div key={idx} className="p-2 rounded bg-black/30 border border-slate-800/80 text-[11px] space-y-0.5">
                      <div className="flex justify-between font-medium">
                        <span className="text-purple-300 uppercase">{st.etapa}</span>
                        <span className="text-slate-500">{new Date(st.dataHora).toLocaleString('pt-BR')}</span>
                      </div>
                      <div className="text-slate-400">{st.observacao}</div>
                      <div className="text-[10px] text-slate-500">Resp: {st.responsavelNome}</div>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

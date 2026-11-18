import React, { useState, useEffect } from 'react';
import { useAuth } from '../../context/AuthContext';
import { api } from '../../lib/api';
import { WarehouseCD, WarehousePosition, WarehouseTransfer, WarehouseInventoryAudit } from '../../types';
import {
  Warehouse,
  Boxes,
  ArrowLeftRight,
  ClipboardCheck,
  Plus,
  Search,
  Filter,
  CheckCircle2,
  AlertTriangle,
  QrCode,
  Building,
  MapPin,
  Truck,
  RotateCcw,
  Sparkles,
  ChevronRight,
  TrendingUp,
  Package,
  Layers,
  BarChart3,
  RefreshCw,
  X,
  ExternalLink,
  ShieldAlert
} from 'lucide-react';

interface WarehouseManagerViewProps {
  activeView?: string;
  onNavigate: (module: string, view?: string) => void;
}

export const WarehouseManagerView: React.FC<WarehouseManagerViewProps> = ({
  activeView = 'overview',
  onNavigate
}) => {
  const { user, company, isMaster } = useAuth();

  // Active Tab
  const [tab, setTab] = useState<'overview' | 'warehouses' | 'positions' | 'transfers' | 'audits'>('overview');

  // Data States
  const [loading, setLoading] = useState(true);
  const [metrics, setMetrics] = useState<any>(null);
  const [warehouses, setWarehouses] = useState<WarehouseCD[]>([]);
  const [transfers, setTransfers] = useState<WarehouseTransfer[]>([]);
  const [audits, setAudits] = useState<WarehouseInventoryAudit[]>([]);

  // Selected filters
  const [selectedCdId, setSelectedCdId] = useState<string>('');
  const [searchQuery, setSearchQuery] = useState('');
  const [positionFilterStatus, setPositionFilterStatus] = useState<string>('all');
  const [positionFilterStorage, setPositionFilterStorage] = useState<string>('all');

  // Modals
  const [showNewCdModal, setShowNewCdModal] = useState(false);
  const [showMatrixModal, setShowMatrixModal] = useState(false);
  const [showAllocateModal, setShowAllocateModal] = useState(false);
  const [showQrModal, setShowQrModal] = useState(false);
  const [showNewTransferModal, setShowNewTransferModal] = useState(false);
  const [showNewAuditModal, setShowNewAuditModal] = useState(false);
  const [showAuditCountsModal, setShowAuditCountsModal] = useState(false);

  // Selected entities for modals
  const [activePosition, setActivePosition] = useState<WarehousePosition | null>(null);
  const [activeAudit, setActiveAudit] = useState<WarehouseInventoryAudit | null>(null);

  // Notifications / feedback
  const [toastMessage, setToastMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  const showToast = (text: string, type: 'success' | 'error' = 'success') => {
    setToastMessage({ type, text });
    setTimeout(() => setToastMessage(null), 4500);
  };

  const loadData = async () => {
    setLoading(true);
    try {
      const [mRes, wRes, tRes, aRes] = await Promise.all([
        api.getWarehousesMetrics(),
        api.getWarehouses(),
        api.getWarehouseTransfers(),
        api.getWarehouseAudits()
      ]);

      if (mRes.success) setMetrics(mRes.metrics);
      if (wRes.success) {
        setWarehouses(wRes.warehouses);
        if (wRes.warehouses.length > 0 && !selectedCdId) {
          setSelectedCdId(wRes.warehouses[0].id);
        }
      }
      if (tRes.success) setTransfers(tRes.transfers);
      if (aRes.success) setAudits(aRes.audits);
    } catch (err: any) {
      console.error('Erro ao carregar dados de Centros de Distribuição:', err);
      showToast('Falha ao sincronizar dados com o servidor.', 'error');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadData();
  }, []);

  const activeCd = warehouses.find(w => w.id === selectedCdId) || warehouses[0] || null;

  // Filtered positions for active CD
  const filteredPositions = (activeCd?.posicoes || []).filter(pos => {
    const matchesSearch =
      pos.codigo.toLowerCase().includes(searchQuery.toLowerCase()) ||
      (pos.itemNomeAlocado && pos.itemNomeAlocado.toLowerCase().includes(searchQuery.toLowerCase())) ||
      (pos.skuAlocado && pos.skuAlocado.toLowerCase().includes(searchQuery.toLowerCase()));

    const matchesStatus = positionFilterStatus === 'all' || pos.status === positionFilterStatus;
    const matchesStorage = positionFilterStorage === 'all' || pos.tipoArmazenagem === positionFilterStorage;

    return matchesSearch && matchesStatus && matchesStorage;
  });

  // Handle CD Creation Form
  const handleCreateCd = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);

    try {
      const payload = {
        codigo: fd.get('codigo') as string,
        nome: fd.get('nome') as string,
        tipo: fd.get('tipo') as any,
        cnpj: fd.get('cnpj') as string,
        responsavelNome: fd.get('responsavelNome') as string,
        responsavelTelefone: fd.get('responsavelTelefone') as string,
        responsavelEmail: fd.get('responsavelEmail') as string,
        endereco: fd.get('endereco') as string,
        numero: fd.get('numero') as string,
        bairro: fd.get('bairro') as string,
        cidade: fd.get('cidade') as string,
        estado: fd.get('estado') as string,
        cep: fd.get('cep') as string,
        capacidadeTotalVolumes: Number(fd.get('capacidadeTotalVolumes')) || 5000,
        capacidadeTotalKg: Number(fd.get('capacidadeTotalKg')) || 50000,
        areaMetrosQuadrados: Number(fd.get('areaMetrosQuadrados')) || 1200,
        criarEstruturaInicial: fd.get('criarEstruturaInicial') === 'true'
      };

      const res = await api.createWarehouse(payload);
      if (res.success) {
        showToast(`Centro de Distribuição ${res.warehouse.nome} cadastrado com sucesso!`);
        setShowNewCdModal(false);
        loadData();
        setSelectedCdId(res.warehouse.id);
      }
    } catch (err: any) {
      showToast(err.message || 'Erro ao cadastrar Centro de Distribuição.', 'error');
    }
  };

  // Handle Matrix Generation
  const handleGenerateMatrix = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!activeCd) return;

    const fd = new FormData(e.currentTarget);
    const ruasStr = (fd.get('ruas') as string) || 'R01, R02, R03';
    const ruas = ruasStr.split(',').map(s => s.trim().toUpperCase()).filter(Boolean);

    try {
      const payload = {
        ruas,
        corredorPadrao: (fd.get('corredorPadrao') as string) || 'C01',
        prateleirasQtd: Number(fd.get('prateleirasQtd')) || 4,
        niveisQtd: Number(fd.get('niveisQtd')) || 3,
        tipoArmazenagem: (fd.get('tipoArmazenagem') as string) || 'palete',
        capacidadeKg: Number(fd.get('capacidadeKg')) || 1000,
        capacidadeVolumes: Number(fd.get('capacidadeVolumes')) || 50
      };

      const res = await api.generateWarehouseMatrix(activeCd.id, payload);
      if (res.success) {
        showToast(res.message);
        setShowMatrixModal(false);
        loadData();
      }
    } catch (err: any) {
      showToast(err.message || 'Erro ao gerar posições em lote.', 'error');
    }
  };

  // Handle Item Allocation
  const handleAllocate = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!activeCd || !activePosition) return;

    const fd = new FormData(e.currentTarget);
    try {
      const payload = {
        sku: fd.get('sku') as string,
        nome: fd.get('nome') as string,
        quantidade: Number(fd.get('quantidade')),
        pesoKg: Number(fd.get('pesoKg')) || 0,
        volumes: Number(fd.get('volumes')) || Number(fd.get('quantidade'))
      };

      const res = await api.allocateWarehousePosition(activeCd.id, activePosition.id, payload);
      if (res.success) {
        showToast(res.message);
        setShowAllocateModal(false);
        setActivePosition(null);
        loadData();
      }
    } catch (err: any) {
      showToast(err.message || 'Erro ao alocar mercadoria.', 'error');
    }
  };

  // Handle Deallocation / Desocupar
  const handleDeallocate = async (position: WarehousePosition) => {
    if (!activeCd) return;
    if (!confirm(`Deseja desocupar a posição ${position.codigo} (${position.itemNomeAlocado})?`)) return;

    try {
      const res = await api.deallocateWarehousePosition(activeCd.id, position.id, {
        motivo: 'Baixa efetuada pelo operador'
      });
      if (res.success) {
        showToast(res.message);
        loadData();
      }
    } catch (err: any) {
      showToast(err.message || 'Erro ao desocupar posição.', 'error');
    }
  };

  // Handle Position Status Toggle (Bloquear/Desbloquear)
  const handleTogglePositionStatus = async (position: WarehousePosition) => {
    if (!activeCd) return;
    const nextStatus = position.status === 'bloqueado' ? 'disponivel' : 'bloqueado';

    try {
      const res = await api.patchWarehousePosition(activeCd.id, position.id, { status: nextStatus });
      if (res.success) {
        showToast(`Posição ${position.codigo} alterada para ${nextStatus}.`);
        loadData();
      }
    } catch (err: any) {
      showToast(err.message || 'Erro ao atualizar status da posição.', 'error');
    }
  };

  // Handle New Transfer
  const handleCreateTransfer = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);

    const cdOrigemId = fd.get('cdOrigemId') as string;
    const cdDestinoId = fd.get('cdDestinoId') as string;
    const sku = fd.get('sku') as string;
    const nome = fd.get('nome') as string;
    const quantidade = Number(fd.get('quantidade')) || 1;
    const posicaoOrigem = fd.get('posicaoOrigem') as string;
    const posicaoDestino = fd.get('posicaoDestino') as string;

    try {
      const payload = {
        cdOrigemId,
        cdDestinoId,
        tipo: cdOrigemId === cdDestinoId ? ('interna_posicoes' as const) : ('entre_galpoes' as const),
        itens: [{ sku, nome, quantidade, posicaoOrigem, posicaoDestino }],
        motoristaNome: fd.get('motoristaNome') as string,
        veiculoPlaca: fd.get('veiculoPlaca') as string,
        observacoes: fd.get('observacoes') as string
      };

      const res = await api.createWarehouseTransfer(payload);
      if (res.success) {
        showToast(res.message);
        setShowNewTransferModal(false);
        loadData();
      }
    } catch (err: any) {
      showToast(err.message || 'Erro ao registrar solicitação de transferência.', 'error');
    }
  };

  // Handle Transfer Status Update
  const handleUpdateTransferStatus = async (transferId: string, nextStatus: string) => {
    try {
      const res = await api.updateWarehouseTransferStatus(transferId, { status: nextStatus });
      if (res.success) {
        showToast(res.message);
        loadData();
      }
    } catch (err: any) {
      showToast(err.message || 'Erro ao atualizar transferência.', 'error');
    }
  };

  // Handle New Audit Session
  const handleCreateAudit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);

    try {
      const payload = {
        cdId: fd.get('cdId') as string,
        tipoInventario: fd.get('tipoInventario') as any,
        responsavelAuditoria: fd.get('responsavelAuditoria') as string,
        observacoes: fd.get('observacoes') as string
      };

      const res = await api.createWarehouseAudit(payload);
      if (res.success) {
        showToast(res.message);
        setShowNewAuditModal(false);
        loadData();
      }
    } catch (err: any) {
      showToast(err.message || 'Erro ao abrir inventário.', 'error');
    }
  };

  // Handle Counts Submission
  const handleSaveAuditCounts = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!activeAudit) return;

    const form = e.currentTarget;
    const inputs = form.querySelectorAll<HTMLInputElement>('input[data-item-pos]');
    const counts: Array<{ posicaoCodigo: string; saldoContado: number; custoUnitario?: number }> = [];

    inputs.forEach(input => {
      const pos = input.getAttribute('data-item-pos');
      const val = Number(input.value) || 0;
      if (pos) {
        counts.push({ posicaoCodigo: pos, saldoContado: val });
      }
    });

    try {
      const res = await api.saveWarehouseAuditCounts(activeAudit.id, { counts });
      if (res.success) {
        showToast('Contagens físicas salvas com sucesso.');
        setShowAuditCountsModal(false);
        setActiveAudit(null);
        loadData();
      }
    } catch (err: any) {
      showToast(err.message || 'Erro ao salvar contagens.', 'error');
    }
  };

  // Handle Audit Finalize
  const handleFinalizeAudit = async (auditId: string, aplicarAjustes: boolean) => {
    if (!confirm(aplicarAjustes ? 'Confirma a finalização com ajuste e atualização dos saldos no galpão?' : 'Finalizar sem alterar os saldos físicos?')) return;

    try {
      const res = await api.finalizeWarehouseAudit(auditId, {
        aplicarAjustesNoEstoque: aplicarAjustes,
        observacoesFinais: 'Auditoria homologada pelo gestor de logística.'
      });
      if (res.success) {
        showToast(res.message);
        loadData();
      }
    } catch (err: any) {
      showToast(err.message || 'Erro ao finalizar inventário.', 'error');
    }
  };

  return (
    <div className="space-y-6 pb-20">
      {/* Toast Notification */}
      {toastMessage && (
        <div
          className={`fixed bottom-6 right-6 z-50 px-5 py-3 rounded-xl shadow-2xl flex items-center gap-3 text-xs font-semibold border transition transform animate-in fade-in slide-in-from-bottom-3 ${
            toastMessage.type === 'success'
              ? 'bg-emerald-950 text-emerald-200 border-emerald-500/40'
              : 'bg-rose-950 text-rose-200 border-rose-500/40'
          }`}
        >
          {toastMessage.type === 'success' ? (
            <CheckCircle2 className="w-4 h-4 text-emerald-400" />
          ) : (
            <AlertTriangle className="w-4 h-4 text-rose-400" />
          )}
          <span>{toastMessage.text}</span>
        </div>
      )}

      {/* Header com Navegação Integrada do Módulo */}
      <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4 pb-4 border-b border-white/5">
        <div className="space-y-1">
          <div className="flex items-center gap-2 text-xs font-bold uppercase tracking-wider text-[#A78BFA]">
            <span>MoviLog WMS</span>
            <span>·</span>
            <span>Fase 2: Gestão de CDs & Estoque</span>
          </div>
          <h1 className="text-2xl font-black text-white flex items-center gap-2.5">
            <Warehouse className="w-7 h-7 text-[#8B5CF6]" />
            Centros de Distribuição & Armazenagem
          </h1>
          <p className="text-xs text-[#AAA6B5]">
            Controle físico tridimensional de posições (ruas, prateleiras, níveis), transferências e acuracidade de inventário.
          </p>
        </div>

        {/* Botões de Ação Rápida */}
        <div className="flex items-center gap-2 flex-wrap">
          <button
            onClick={() => setShowNewCdModal(true)}
            className="px-4 py-2 rounded-xl bg-[#8B5CF6] hover:bg-[#7C3AED] text-white font-semibold text-xs transition flex items-center gap-1.5 shadow-lg shadow-[#8B5CF6]/20"
          >
            <Plus className="w-4 h-4" />
            Novo Galpão / CD
          </button>
          <button
            onClick={() => setShowNewTransferModal(true)}
            className="px-4 py-2 rounded-xl bg-white/5 hover:bg-white/10 text-white font-medium text-xs border border-white/10 transition flex items-center gap-1.5"
          >
            <ArrowLeftRight className="w-4 h-4 text-[#A78BFA]" />
            Nova Transferência
          </button>
          <button
            onClick={() => setShowNewAuditModal(true)}
            className="px-4 py-2 rounded-xl bg-white/5 hover:bg-white/10 text-white font-medium text-xs border border-white/10 transition flex items-center gap-1.5"
          >
            <ClipboardCheck className="w-4 h-4 text-emerald-400" />
            Iniciar Inventário
          </button>
          <button
            onClick={loadData}
            title="Atualizar dados"
            className="p-2 rounded-xl bg-white/5 hover:bg-white/10 text-slate-300 transition border border-white/10"
          >
            <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin text-[#8B5CF6]' : ''}`} />
          </button>
        </div>
      </div>

      {/* Tabs Sub-Navigation */}
      <div className="flex items-center gap-2 overflow-x-auto pb-1 border-b border-white/5 text-xs font-semibold">
        <button
          onClick={() => setTab('overview')}
          className={`px-4 py-2.5 rounded-lg transition flex items-center gap-2 whitespace-nowrap ${
            tab === 'overview'
              ? 'bg-[#8B5CF6]/20 text-white border border-[#8B5CF6]/40'
              : 'text-[#AAA6B5] hover:text-white hover:bg-white/5'
          }`}
        >
          <BarChart3 className="w-4 h-4 text-[#8B5CF6]" />
          Visão Geral & Indicadores
        </button>

        <button
          onClick={() => setTab('warehouses')}
          className={`px-4 py-2.5 rounded-lg transition flex items-center gap-2 whitespace-nowrap ${
            tab === 'warehouses'
              ? 'bg-[#8B5CF6]/20 text-white border border-[#8B5CF6]/40'
              : 'text-[#AAA6B5] hover:text-white hover:bg-white/5'
          }`}
        >
          <Warehouse className="w-4 h-4 text-[#8B5CF6]" />
          Galpões Cadastrados ({warehouses.length})
        </button>

        <button
          onClick={() => setTab('positions')}
          className={`px-4 py-2.5 rounded-lg transition flex items-center gap-2 whitespace-nowrap ${
            tab === 'positions'
              ? 'bg-[#8B5CF6]/20 text-white border border-[#8B5CF6]/40'
              : 'text-[#AAA6B5] hover:text-white hover:bg-white/5'
          }`}
        >
          <Boxes className="w-4 h-4 text-[#8B5CF6]" />
          Endereçamento & Posições ({activeCd?.posicoes?.length || 0})
        </button>

        <button
          onClick={() => setTab('transfers')}
          className={`px-4 py-2.5 rounded-lg transition flex items-center gap-2 whitespace-nowrap ${
            tab === 'transfers'
              ? 'bg-[#8B5CF6]/20 text-white border border-[#8B5CF6]/40'
              : 'text-[#AAA6B5] hover:text-white hover:bg-white/5'
          }`}
        >
          <ArrowLeftRight className="w-4 h-4 text-[#8B5CF6]" />
          Transferências ({transfers.length})
        </button>

        <button
          onClick={() => setTab('audits')}
          className={`px-4 py-2.5 rounded-lg transition flex items-center gap-2 whitespace-nowrap ${
            tab === 'audits'
              ? 'bg-[#8B5CF6]/20 text-white border border-[#8B5CF6]/40'
              : 'text-[#AAA6B5] hover:text-white hover:bg-white/5'
          }`}
        >
          <ClipboardCheck className="w-4 h-4 text-[#8B5CF6]" />
          Inventários & Auditorias ({audits.length})
        </button>
      </div>

      {/* ==================================================================== */}
      {/* TAB 1: VISÃO GERAL & INDICADORES                                     */}
      {/* ==================================================================== */}
      {tab === 'overview' && (
        <div className="space-y-6">
          {/* Top KPI Cards */}
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
            <div className="p-5 rounded-2xl bg-[#0D0E1A] border border-white/5 space-y-2">
              <div className="flex items-center justify-between text-xs text-[#AAA6B5]">
                <span className="font-semibold uppercase tracking-wider text-[10px]">Centros de Distribuição</span>
                <Building className="w-4 h-4 text-[#8B5CF6]" />
              </div>
              <div className="text-2xl font-black text-white">{metrics?.totalCdsAtivos || warehouses.length} Ativos</div>
              <div className="text-[11px] text-[#AAA6B5] flex items-center gap-1.5">
                <span className="w-1.5 h-1.5 rounded-full bg-emerald-400" />
                {metrics?.capacidadeTotalVolumes?.toLocaleString() || 0} volumes de capacidade total
              </div>
            </div>

            <div className="p-5 rounded-2xl bg-[#0D0E1A] border border-white/5 space-y-2">
              <div className="flex items-center justify-between text-xs text-[#AAA6B5]">
                <span className="font-semibold uppercase tracking-wider text-[10px]">Ocupação Global</span>
                <TrendingUp className="w-4 h-4 text-[#8B5CF6]" />
              </div>
              <div className="text-2xl font-black text-white">
                {metrics?.taxaOcupacaoMediaPercentual || 0}%
              </div>
              <div className="text-[11px] text-[#AAA6B5]">
                {metrics?.posicoesOcupadas || 0} de {metrics?.totalPosicoes || 0} posições ocupadas
              </div>
            </div>

            <div className="p-5 rounded-2xl bg-[#0D0E1A] border border-white/5 space-y-2">
              <div className="flex items-center justify-between text-xs text-[#AAA6B5]">
                <span className="font-semibold uppercase tracking-wider text-[10px]">Transferências em Trânsito</span>
                <Truck className="w-4 h-4 text-amber-400" />
              </div>
              <div className="text-2xl font-black text-amber-300">
                {metrics?.transferenciasEmTransito || 0}
              </div>
              <div className="text-[11px] text-[#AAA6B5]">
                Movimentação inter-galpões ativa
              </div>
            </div>

            <div className="p-5 rounded-2xl bg-[#0D0E1A] border border-white/5 space-y-2">
              <div className="flex items-center justify-between text-xs text-[#AAA6B5]">
                <span className="font-semibold uppercase tracking-wider text-[10px]">Inventários Pendentes</span>
                <ClipboardCheck className="w-4 h-4 text-emerald-400" />
              </div>
              <div className="text-2xl font-black text-emerald-300">
                {metrics?.inventariosPendentes || 0}
              </div>
              <div className="text-[11px] text-[#AAA6B5]">
                Auditorias rotativas em andamento
              </div>
            </div>
          </div>

          {/* Alertas Críticos de Armazenagem */}
          {metrics?.alertasCriticos && metrics.alertasCriticos.length > 0 && (
            <div className="p-5 rounded-2xl bg-amber-950/20 border border-amber-500/30 space-y-3">
              <div className="flex items-center gap-2 text-xs font-bold uppercase tracking-wider text-amber-400">
                <AlertTriangle className="w-4 h-4" />
                Alertas de Superlotação e Capacidade
              </div>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-2 text-xs">
                {metrics.alertasCriticos.map((alerta: any, idx: number) => (
                  <div key={idx} className="p-3 rounded-xl bg-black/40 border border-amber-500/20 text-slate-300">
                    <span className="font-bold text-amber-300">{alerta.posicaoCodigo} ({alerta.cdNome}):</span>{' '}
                    {alerta.mensagem}
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* CDs Resumo Rápido */}
          <div className="p-6 rounded-2xl bg-[#0D0E1A] border border-white/5 space-y-4">
            <div className="flex items-center justify-between pb-3 border-b border-white/5">
              <h2 className="text-base font-bold text-white flex items-center gap-2">
                <Warehouse className="w-4 h-4 text-[#8B5CF6]" />
                Visão Rápida dos Centros de Distribuição
              </h2>
              <button
                onClick={() => setTab('warehouses')}
                className="text-xs text-[#A78BFA] hover:text-white transition flex items-center gap-1"
              >
                Ver todos <ChevronRight className="w-3.5 h-3.5" />
              </button>
            </div>

            {warehouses.length === 0 ? (
              <div className="py-12 text-center text-xs text-[#AAA6B5] space-y-3">
                <Warehouse className="w-8 h-8 text-slate-600 mx-auto" />
                <p>Nenhum Centro de Distribuição cadastrado ainda.</p>
                <button
                  onClick={() => setShowNewCdModal(true)}
                  className="px-4 py-2 rounded-xl bg-[#8B5CF6] text-white font-semibold text-xs"
                >
                  Cadastrar Primeiro CD
                </button>
              </div>
            ) : (
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                {warehouses.map(w => {
                  const total = w.posicoes?.length || 0;
                  const ocupadas = w.posicoes?.filter(p => p.status === 'ocupado').length || 0;
                  const taxa = total > 0 ? Math.round((ocupadas / total) * 100) : 0;

                  return (
                    <div
                      key={w.id}
                      onClick={() => {
                        setSelectedCdId(w.id);
                        setTab('positions');
                      }}
                      className="p-4 rounded-xl bg-[#080914] border border-white/5 hover:border-[#8B5CF6]/50 cursor-pointer transition space-y-3 group"
                    >
                      <div className="flex items-center justify-between">
                        <span className="text-xs font-black text-[#8B5CF6]">{w.codigo}</span>
                        <span className="text-[10px] font-bold px-2 py-0.5 rounded bg-white/5 text-slate-300 uppercase">
                          {w.tipo}
                        </span>
                      </div>

                      <div>
                        <h3 className="text-sm font-bold text-white group-hover:text-[#A78BFA] transition">
                          {w.nome}
                        </h3>
                        <p className="text-[11px] text-[#AAA6B5] flex items-center gap-1 mt-0.5">
                          <MapPin className="w-3 h-3 text-slate-500" />
                          {w.cidade} - {w.estado}
                        </p>
                      </div>

                      <div className="space-y-1.5 pt-2 border-t border-white/5">
                        <div className="flex items-center justify-between text-[11px]">
                          <span className="text-[#AAA6B5]">Ocupação de Posições</span>
                          <span className="font-bold text-white">{taxa}% ({ocupadas}/{total})</span>
                        </div>
                        <div className="w-full h-1.5 rounded-full bg-white/5 overflow-hidden">
                          <div
                            className={`h-full rounded-full transition-all ${
                              taxa > 85 ? 'bg-rose-500' : taxa > 60 ? 'bg-amber-400' : 'bg-[#8B5CF6]'
                            }`}
                            style={{ width: `${Math.min(100, taxa)}%` }}
                          />
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      )}

      {/* ==================================================================== */}
      {/* TAB 2: GALPÕES CADASTRADOS                                           */}
      {/* ==================================================================== */}
      {tab === 'warehouses' && (
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <h2 className="text-base font-bold text-white">Rede de Galpões e Armazéns</h2>
              <p className="text-xs text-[#AAA6B5]">
                Gerenciamento multi-unidades, depósitos e polos de cross-docking.
              </p>
            </div>
            <button
              onClick={() => setShowNewCdModal(true)}
              className="px-3 py-1.5 rounded-lg bg-[#8B5CF6] hover:bg-[#7C3AED] text-white font-semibold text-xs transition flex items-center gap-1.5"
            >
              <Plus className="w-3.5 h-3.5" />
              Novo Galpão
            </button>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {warehouses.map(w => {
              const total = w.posicoes?.length || 0;
              const ocupadas = w.posicoes?.filter(p => p.status === 'ocupado').length || 0;
              const taxa = total > 0 ? Math.round((ocupadas / total) * 100) : 0;

              return (
                <div key={w.id} className="p-5 rounded-2xl bg-[#0D0E1A] border border-white/5 space-y-4">
                  <div className="flex items-start justify-between gap-2">
                    <div>
                      <div className="flex items-center gap-2">
                        <span className="text-xs font-black text-[#8B5CF6] px-2 py-0.5 rounded bg-[#8B5CF6]/10">
                          {w.codigo}
                        </span>
                        <span className="text-[10px] uppercase font-semibold text-slate-400">
                          Tipo: {w.tipo}
                        </span>
                      </div>
                      <h3 className="text-base font-bold text-white mt-1.5">{w.nome}</h3>
                      <p className="text-xs text-[#AAA6B5] flex items-center gap-1 mt-0.5">
                        <MapPin className="w-3.5 h-3.5 text-slate-500" />
                        {w.endereco}, {w.numero} - {w.bairro}, {w.cidade}/{w.estado}
                      </p>
                    </div>

                    <span
                      className={`text-[10px] font-bold px-2 py-1 rounded ${
                        w.ativo ? 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/20' : 'bg-rose-500/10 text-rose-400'
                      }`}
                    >
                      {w.ativo ? 'Ativo' : 'Inativo'}
                    </span>
                  </div>

                  <div className="grid grid-cols-3 gap-2 py-3 border-y border-white/5 text-center">
                    <div>
                      <span className="text-[10px] uppercase text-[#AAA6B5]">Capacidade Vol.</span>
                      <p className="text-sm font-black text-white">{w.capacidadeTotalVolumes?.toLocaleString()}</p>
                    </div>
                    <div>
                      <span className="text-[10px] uppercase text-[#AAA6B5]">Capacidade Carga</span>
                      <p className="text-sm font-black text-white">{w.capacidadeTotalKg?.toLocaleString()} kg</p>
                    </div>
                    <div>
                      <span className="text-[10px] uppercase text-[#AAA6B5]">Área Galpão</span>
                      <p className="text-sm font-black text-white">{w.areaMetrosQuadrados || 1200} m²</p>
                    </div>
                  </div>

                  <div className="space-y-1.5">
                    <div className="flex items-center justify-between text-xs">
                      <span className="text-[#AAA6B5]">Taxa de Ocupação de Posições</span>
                      <span className="font-bold text-white">{taxa}% ({ocupadas} / {total})</span>
                    </div>
                    <div className="w-full h-2 rounded-full bg-white/5 overflow-hidden">
                      <div
                        className={`h-full rounded-full ${
                          taxa > 85 ? 'bg-rose-500' : taxa > 60 ? 'bg-amber-400' : 'bg-[#8B5CF6]'
                        }`}
                        style={{ width: `${Math.min(100, taxa)}%` }}
                      />
                    </div>
                  </div>

                  <div className="flex items-center justify-between pt-2">
                    <span className="text-[11px] text-[#AAA6B5]">
                      Resp: <strong className="text-slate-300">{w.responsavelNome}</strong> ({w.responsavelTelefone || 'Sem tel'})
                    </span>
                    <button
                      onClick={() => {
                        setSelectedCdId(w.id);
                        setTab('positions');
                      }}
                      className="px-3 py-1.5 rounded-lg bg-white/5 hover:bg-white/10 text-[#A78BFA] font-medium text-xs transition flex items-center gap-1 border border-white/10"
                    >
                      Gerenciar Endereços <ChevronRight className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* ==================================================================== */}
      {/* TAB 3: ENDEREÇAMENTO & POSIÇÕES (WMS GRID)                           */}
      {/* ==================================================================== */}
      {tab === 'positions' && (
        <div className="space-y-5">
          {/* Top Controls & CD Picker */}
          <div className="p-4 rounded-2xl bg-[#0D0E1A] border border-white/5 flex flex-col md:flex-row md:items-center justify-between gap-4">
            <div className="flex items-center gap-3">
              <span className="text-xs font-semibold text-[#AAA6B5]">Selecionar Galpão:</span>
              <select
                value={selectedCdId}
                onChange={e => setSelectedCdId(e.target.value)}
                className="bg-[#080914] border border-white/10 rounded-xl px-3 py-2 text-xs text-white focus:outline-none focus:border-[#8B5CF6]"
              >
                {warehouses.map(w => (
                  <option key={w.id} value={w.id}>
                    {w.codigo} — {w.nome} ({w.posicoes?.length || 0} posições)
                  </option>
                ))}
              </select>
            </div>

            <div className="flex items-center gap-2 flex-wrap">
              <button
                onClick={() => setShowMatrixModal(true)}
                className="px-3 py-2 rounded-xl bg-[#8B5CF6] hover:bg-[#7C3AED] text-white font-semibold text-xs transition flex items-center gap-1.5"
              >
                <Layers className="w-3.5 h-3.5" />
                Gerador de Matriz (Ruas x Níveis)
              </button>
            </div>
          </div>

          {/* Search & Filter Bar */}
          <div className="flex flex-col sm:flex-row items-stretch sm:items-center justify-between gap-3 text-xs">
            <div className="relative flex-1 max-w-md">
              <Search className="w-4 h-4 absolute left-3 top-2.5 text-slate-500" />
              <input
                type="text"
                placeholder="Buscar por código de posição, mercadoria ou SKU..."
                value={searchQuery}
                onChange={e => setSearchQuery(e.target.value)}
                className="w-full bg-[#0D0E1A] border border-white/10 rounded-xl pl-9 pr-3 py-2 text-xs text-white placeholder-slate-500 focus:outline-none focus:border-[#8B5CF6]"
              />
            </div>

            <div className="flex items-center gap-2">
              <select
                value={positionFilterStatus}
                onChange={e => setPositionFilterStatus(e.target.value)}
                className="bg-[#0D0E1A] border border-white/10 rounded-xl px-3 py-2 text-white focus:outline-none focus:border-[#8B5CF6]"
              >
                <option value="all">Todos os Status</option>
                <option value="disponivel">Disponível</option>
                <option value="ocupado">Ocupado</option>
                <option value="bloqueado">Bloqueado</option>
                <option value="manutencao">Em Manutenção</option>
              </select>

              <select
                value={positionFilterStorage}
                onChange={e => setPositionFilterStorage(e.target.value)}
                className="bg-[#0D0E1A] border border-white/10 rounded-xl px-3 py-2 text-white focus:outline-none focus:border-[#8B5CF6]"
              >
                <option value="all">Todos os Tipos</option>
                <option value="picking">Picking</option>
                <option value="palete">Palete Padrão</option>
                <option value="pulmao">Pulmão de Carga</option>
                <option value="refrigerado">Refrigerado</option>
                <option value="blocado">Blocado</option>
              </select>
            </div>
          </div>

          {/* Grid de Posições */}
          {filteredPositions.length === 0 ? (
            <div className="p-12 text-center rounded-2xl bg-[#0D0E1A] border border-white/5 space-y-3">
              <Boxes className="w-10 h-10 text-slate-600 mx-auto" />
              <p className="text-xs text-[#AAA6B5]">Nenhuma posição encontrada com os filtros selecionados.</p>
              <button
                onClick={() => setShowMatrixModal(true)}
                className="px-4 py-2 rounded-xl bg-[#8B5CF6] text-white font-semibold text-xs"
              >
                Gerar Posições no Galpão
              </button>
            </div>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-3.5">
              {filteredPositions.map(pos => {
                const isOccupied = pos.status === 'ocupado';
                const isBlocked = pos.status === 'bloqueado' || pos.status === 'manutencao';

                return (
                  <div
                    key={pos.id}
                    className={`p-4 rounded-xl border transition flex flex-col justify-between space-y-3 ${
                      isOccupied
                        ? 'bg-[#120F2B] border-[#8B5CF6]/40 shadow-sm'
                        : isBlocked
                        ? 'bg-rose-950/20 border-rose-500/30'
                        : 'bg-[#0D0E1A] border-white/5 hover:border-white/20'
                    }`}
                  >
                    <div className="space-y-2">
                      <div className="flex items-center justify-between">
                        <span className="text-xs font-black tracking-tight text-white">{pos.codigo}</span>
                        <span
                          className={`text-[9px] font-bold uppercase px-1.5 py-0.5 rounded ${
                            isOccupied
                              ? 'bg-[#8B5CF6]/20 text-[#A78BFA]'
                              : isBlocked
                              ? 'bg-rose-500/20 text-rose-300'
                              : 'bg-emerald-500/10 text-emerald-400'
                          }`}
                        >
                          {pos.status}
                        </span>
                      </div>

                      <div className="flex items-center gap-2 text-[10px] text-[#AAA6B5]">
                        <span>Rua {pos.rua}</span>
                        <span>·</span>
                        <span>Prat. {pos.prateleira}</span>
                        <span>·</span>
                        <span>Nível {pos.nivel}</span>
                      </div>

                      {/* Conteúdo Alocado */}
                      {isOccupied ? (
                        <div className="p-2.5 rounded-lg bg-black/40 border border-[#8B5CF6]/20 space-y-1">
                          <span className="text-[10px] font-bold text-[#A78BFA] uppercase">SKU: {pos.skuAlocado}</span>
                          <p className="text-xs font-bold text-white truncate">{pos.itemNomeAlocado}</p>
                          <div className="flex items-center justify-between text-[11px] text-slate-300 pt-1">
                            <span>Qtd: <strong>{pos.quantidadeAlocada} un</strong></span>
                            <span>Peso: {pos.ocupadoKg} kg</span>
                          </div>
                        </div>
                      ) : (
                        <div className="py-2 text-center text-[11px] text-slate-500 border border-dashed border-white/5 rounded-lg">
                          Posição Livre ({pos.tipoArmazenagem})
                        </div>
                      )}
                    </div>

                    {/* Actions */}
                    <div className="pt-2 border-t border-white/5 flex items-center justify-between gap-1 text-[11px]">
                      <button
                        onClick={() => {
                          setActivePosition(pos);
                          setShowQrModal(true);
                        }}
                        title="Ver QR Code do Endereço"
                        className="p-1.5 rounded-lg bg-white/5 hover:bg-white/10 text-slate-300 transition"
                      >
                        <QrCode className="w-3.5 h-3.5" />
                      </button>

                      {isOccupied ? (
                        <button
                          onClick={() => handleDeallocate(pos)}
                          className="px-2.5 py-1 rounded-lg bg-rose-500/10 hover:bg-rose-500/20 text-rose-300 font-semibold text-[10px] border border-rose-500/20 transition"
                        >
                          Desocupar
                        </button>
                      ) : (
                        <button
                          onClick={() => {
                            setActivePosition(pos);
                            setShowAllocateModal(true);
                          }}
                          disabled={isBlocked}
                          className="px-2.5 py-1 rounded-lg bg-[#8B5CF6]/20 hover:bg-[#8B5CF6]/30 text-[#A78BFA] font-semibold text-[10px] border border-[#8B5CF6]/30 transition disabled:opacity-40"
                        >
                          Alocar Mercadoria
                        </button>
                      )}

                      <button
                        onClick={() => handleTogglePositionStatus(pos)}
                        title={pos.status === 'bloqueado' ? 'Desbloquear' : 'Bloquear'}
                        className="p-1.5 rounded-lg bg-white/5 hover:bg-white/10 text-slate-400 transition"
                      >
                        <ShieldAlert className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* ==================================================================== */}
      {/* TAB 4: TRANSFERÊNCIAS                                                */}
      {/* ==================================================================== */}
      {tab === 'transfers' && (
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <h2 className="text-base font-bold text-white">Transferências de Mercadorias</h2>
              <p className="text-xs text-[#AAA6B5]">
                Remessas entre centros de distribuição e balanceamento de posições internas.
              </p>
            </div>
            <button
              onClick={() => setShowNewTransferModal(true)}
              className="px-3 py-1.5 rounded-lg bg-[#8B5CF6] hover:bg-[#7C3AED] text-white font-semibold text-xs transition flex items-center gap-1.5"
            >
              <Plus className="w-3.5 h-3.5" />
              Nova Transferência
            </button>
          </div>

          {transfers.length === 0 ? (
            <div className="p-12 text-center rounded-2xl bg-[#0D0E1A] border border-white/5 space-y-3">
              <ArrowLeftRight className="w-10 h-10 text-slate-600 mx-auto" />
              <p className="text-xs text-[#AAA6B5]">Nenhuma transferência registrada até o momento.</p>
              <button
                onClick={() => setShowNewTransferModal(true)}
                className="px-4 py-2 rounded-xl bg-[#8B5CF6] text-white font-semibold text-xs"
              >
                Criar Primeira Transferência
              </button>
            </div>
          ) : (
            <div className="space-y-3">
              {transfers.map(trf => (
                <div key={trf.id} className="p-5 rounded-2xl bg-[#0D0E1A] border border-white/5 space-y-3">
                  <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
                    <div className="flex items-center gap-2">
                      <span className="text-xs font-black text-[#8B5CF6]">{trf.codigoTransferencia}</span>
                      <span className="text-[10px] font-bold uppercase px-2 py-0.5 rounded bg-white/5 text-slate-300">
                        {trf.tipo === 'entre_galpoes' ? 'Inter-CDs' : 'Interna'}
                      </span>
                    </div>

                    <div className="flex items-center gap-2">
                      <span
                        className={`text-[10px] font-bold uppercase px-2 py-0.5 rounded ${
                          trf.status === 'recebida_conferida'
                            ? 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/20'
                            : trf.status === 'em_transito'
                            ? 'bg-amber-500/10 text-amber-300 border border-amber-500/20'
                            : 'bg-[#8B5CF6]/15 text-[#A78BFA]'
                        }`}
                      >
                        {trf.status}
                      </span>
                    </div>
                  </div>

                  <div className="grid grid-cols-1 md:grid-cols-3 gap-3 text-xs py-2 border-y border-white/5">
                    <div>
                      <span className="text-[10px] uppercase text-[#AAA6B5]">Origem</span>
                      <p className="font-bold text-white">{trf.cdOrigemNome}</p>
                    </div>
                    <div>
                      <span className="text-[10px] uppercase text-[#AAA6B5]">Destino</span>
                      <p className="font-bold text-white">{trf.cdDestinoNome}</p>
                    </div>
                    <div>
                      <span className="text-[10px] uppercase text-[#AAA6B5]">Volumes / Peso</span>
                      <p className="font-bold text-white">{trf.totalVolumes} volumes · {trf.totalPesoKg} kg</p>
                    </div>
                  </div>

                  {/* Itens da Transferência */}
                  <div className="space-y-1.5">
                    <span className="text-[10px] uppercase font-bold text-slate-400">Itens em trânsito:</span>
                    <div className="flex flex-wrap gap-2">
                      {trf.itens.map((it, idx) => (
                        <div key={idx} className="px-2.5 py-1 rounded-lg bg-black/40 border border-white/5 text-[11px] text-slate-300">
                          <strong className="text-white">{it.nome}</strong> ({it.sku}) — {it.quantidade} un
                          <span className="text-[10px] text-slate-500 ml-1">({it.posicaoOrigem} → {it.posicaoDestino})</span>
                        </div>
                      ))}
                    </div>
                  </div>

                  {/* Fluxo de Status */}
                  <div className="flex items-center justify-between pt-2">
                    <span className="text-[11px] text-[#AAA6B5]">
                      Solicitante: <strong className="text-slate-300">{trf.solicitadoPor}</strong> em {new Date(trf.dataSolicitacao).toLocaleDateString()}
                    </span>

                    <div className="flex items-center gap-2">
                      {trf.status === 'solicitada' && (
                        <button
                          onClick={() => handleUpdateTransferStatus(trf.id, 'em_transito')}
                          className="px-3 py-1 rounded-lg bg-amber-500/20 hover:bg-amber-500/30 text-amber-300 font-semibold text-xs transition"
                        >
                          Despachar Carga
                        </button>
                      )}

                      {trf.status === 'em_transito' && (
                        <button
                          onClick={() => handleUpdateTransferStatus(trf.id, 'recebida_conferida')}
                          className="px-3 py-1 rounded-lg bg-emerald-500/20 hover:bg-emerald-500/30 text-emerald-300 font-semibold text-xs transition"
                        >
                          Conferir & Receber no Destino
                        </button>
                      )}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* ==================================================================== */}
      {/* TAB 5: INVENTÁRIOS & AUDITORIAS                                      */}
      {/* ==================================================================== */}
      {tab === 'audits' && (
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <h2 className="text-base font-bold text-white">Auditorias & Acuracidade de Estoque</h2>
              <p className="text-xs text-[#AAA6B5]">
                Inventários rotativos, contagem física cega e conciliação financeira de divergências.
              </p>
            </div>
            <button
              onClick={() => setShowNewAuditModal(true)}
              className="px-3 py-1.5 rounded-lg bg-[#8B5CF6] hover:bg-[#7C3AED] text-white font-semibold text-xs transition flex items-center gap-1.5"
            >
              <Plus className="w-3.5 h-3.5" />
              Iniciar Inventário
            </button>
          </div>

          {audits.length === 0 ? (
            <div className="p-12 text-center rounded-2xl bg-[#0D0E1A] border border-white/5 space-y-3">
              <ClipboardCheck className="w-10 h-10 text-slate-600 mx-auto" />
              <p className="text-xs text-[#AAA6B5]">Nenhuma sessão de inventário aberta até o momento.</p>
              <button
                onClick={() => setShowNewAuditModal(true)}
                className="px-4 py-2 rounded-xl bg-[#8B5CF6] text-white font-semibold text-xs"
              >
                Abrir Primeiro Inventário
              </button>
            </div>
          ) : (
            <div className="space-y-3">
              {audits.map(aud => (
                <div key={aud.id} className="p-5 rounded-2xl bg-[#0D0E1A] border border-white/5 space-y-3">
                  <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
                    <div className="flex items-center gap-2">
                      <span className="text-xs font-black text-[#8B5CF6]">{aud.codigoInventario}</span>
                      <span className="text-[10px] font-bold uppercase px-2 py-0.5 rounded bg-white/5 text-slate-300">
                        {aud.tipoInventario}
                      </span>
                      <span className="text-xs text-slate-400">· {aud.cdNome}</span>
                    </div>

                    <span
                      className={`text-[10px] font-bold uppercase px-2 py-0.5 rounded ${
                        aud.status === 'concluido_ajustado'
                          ? 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/20'
                          : 'bg-amber-500/10 text-amber-300 border border-amber-500/20'
                      }`}
                    >
                      {aud.status}
                    </span>
                  </div>

                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-xs py-2 border-y border-white/5 text-center">
                    <div>
                      <span className="text-[10px] uppercase text-[#AAA6B5]">Itens Mapeados</span>
                      <p className="font-bold text-white">{aud.totalItensAvaliados}</p>
                    </div>
                    <div>
                      <span className="text-[10px] uppercase text-[#AAA6B5]">Divergências</span>
                      <p className={`font-bold ${aud.totalDivergenciasEncontradas > 0 ? 'text-amber-400' : 'text-emerald-400'}`}>
                        {aud.totalDivergenciasEncontradas}
                      </p>
                    </div>
                    <div>
                      <span className="text-[10px] uppercase text-[#AAA6B5]">Impacto Estimado</span>
                      <p className="font-bold text-white">R$ {Math.abs(aud.impactoTotalFinanceiroDivergencia || 0).toFixed(2)}</p>
                    </div>
                    <div>
                      <span className="text-[10px] uppercase text-[#AAA6B5]">Responsável</span>
                      <p className="font-bold text-white truncate">{aud.responsavelAuditoria}</p>
                    </div>
                  </div>

                  {/* Actions */}
                  <div className="flex items-center justify-between pt-2">
                    <span className="text-[11px] text-[#AAA6B5]">
                      Iniciado em {new Date(aud.dataInicio).toLocaleDateString()}
                    </span>

                    <div className="flex items-center gap-2">
                      {aud.status !== 'concluido_ajustado' && (
                        <>
                          <button
                            onClick={() => {
                              setActiveAudit(aud);
                              setShowAuditCountsModal(true);
                            }}
                            className="px-3 py-1 rounded-lg bg-[#8B5CF6]/20 hover:bg-[#8B5CF6]/30 text-[#A78BFA] font-semibold text-xs transition"
                          >
                            Digitar Contagens Físicas
                          </button>
                          <button
                            onClick={() => handleFinalizeAudit(aud.id, true)}
                            className="px-3 py-1 rounded-lg bg-emerald-500/20 hover:bg-emerald-500/30 text-emerald-300 font-semibold text-xs transition"
                          >
                            Finalizar com Ajuste
                          </button>
                        </>
                      )}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* ==================================================================== */}
      {/* MODAL: NOVO CENTRO DE DISTRIBUIÇÃO                                  */}
      {/* ==================================================================== */}
      {showNewCdModal && (
        <div className="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm flex items-center justify-center p-4 overflow-y-auto">
          <div className="bg-[#0D0E1A] border border-white/10 rounded-2xl max-w-xl w-full p-6 space-y-4">
            <div className="flex items-center justify-between pb-3 border-b border-white/5">
              <h3 className="text-base font-bold text-white flex items-center gap-2">
                <Warehouse className="w-5 h-5 text-[#8B5CF6]" />
                Cadastrar Novo Centro de Distribuição
              </h3>
              <button onClick={() => setShowNewCdModal(false)} className="text-slate-400 hover:text-white">
                <X className="w-5 h-5" />
              </button>
            </div>

            <form onSubmit={handleCreateCd} className="space-y-4 text-xs">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-[#AAA6B5] mb-1">Código Único (ex: CD-SP-01)*</label>
                  <input
                    name="codigo"
                    required
                    placeholder="CD-SP-01"
                    className="w-full bg-[#080914] border border-white/10 rounded-xl px-3 py-2 text-white uppercase focus:outline-none focus:border-[#8B5CF6]"
                  />
                </div>
                <div>
                  <label className="block text-[#AAA6B5] mb-1">Tipo de Operação*</label>
                  <select
                    name="tipo"
                    className="w-full bg-[#080914] border border-white/10 rounded-xl px-3 py-2 text-white focus:outline-none focus:border-[#8B5CF6]"
                  >
                    <option value="matriz">Matriz / Hub Central</option>
                    <option value="filial">Filial Regional</option>
                    <option value="cross_docking">Cross-Docking</option>
                    <option value="dark_store">Dark Store Urbana</option>
                    <option value="hub_urbano">Hub Urbano Last-Mile</option>
                  </select>
                </div>
              </div>

              <div>
                <label className="block text-[#AAA6B5] mb-1">Nome Fantasia / Identificação*</label>
                <input
                  name="nome"
                  required
                  placeholder="CD Barueri Logística Integrada"
                  className="w-full bg-[#080914] border border-white/10 rounded-xl px-3 py-2 text-white focus:outline-none focus:border-[#8B5CF6]"
                />
              </div>

              <div className="grid grid-cols-3 gap-3">
                <div className="col-span-2">
                  <label className="block text-[#AAA6B5] mb-1">Endereço Completo</label>
                  <input
                    name="endereco"
                    placeholder="Av. dos Galpões Logísticos"
                    className="w-full bg-[#080914] border border-white/10 rounded-xl px-3 py-2 text-white focus:outline-none focus:border-[#8B5CF6]"
                  />
                </div>
                <div>
                  <label className="block text-[#AAA6B5] mb-1">Número</label>
                  <input
                    name="numero"
                    placeholder="1500"
                    className="w-full bg-[#080914] border border-white/10 rounded-xl px-3 py-2 text-white focus:outline-none focus:border-[#8B5CF6]"
                  />
                </div>
              </div>

              <div className="grid grid-cols-3 gap-3">
                <div>
                  <label className="block text-[#AAA6B5] mb-1">Bairro</label>
                  <input
                    name="bairro"
                    placeholder="Tamboré"
                    className="w-full bg-[#080914] border border-white/10 rounded-xl px-3 py-2 text-white focus:outline-none focus:border-[#8B5CF6]"
                  />
                </div>
                <div>
                  <label className="block text-[#AAA6B5] mb-1">Cidade</label>
                  <input
                    name="cidade"
                    defaultValue="Barueri"
                    className="w-full bg-[#080914] border border-white/10 rounded-xl px-3 py-2 text-white focus:outline-none focus:border-[#8B5CF6]"
                  />
                </div>
                <div>
                  <label className="block text-[#AAA6B5] mb-1">Estado</label>
                  <input
                    name="estado"
                    defaultValue="SP"
                    maxLength={2}
                    className="w-full bg-[#080914] border border-white/10 rounded-xl px-3 py-2 text-white uppercase focus:outline-none focus:border-[#8B5CF6]"
                  />
                </div>
              </div>

              <div className="grid grid-cols-3 gap-3">
                <div>
                  <label className="block text-[#AAA6B5] mb-1">Capacidade Volumes</label>
                  <input
                    name="capacidadeTotalVolumes"
                    type="number"
                    defaultValue={10000}
                    className="w-full bg-[#080914] border border-white/10 rounded-xl px-3 py-2 text-white focus:outline-none focus:border-[#8B5CF6]"
                  />
                </div>
                <div>
                  <label className="block text-[#AAA6B5] mb-1">Capacidade Carga (kg)</label>
                  <input
                    name="capacidadeTotalKg"
                    type="number"
                    defaultValue={100000}
                    className="w-full bg-[#080914] border border-white/10 rounded-xl px-3 py-2 text-white focus:outline-none focus:border-[#8B5CF6]"
                  />
                </div>
                <div>
                  <label className="block text-[#AAA6B5] mb-1">Área (m²)</label>
                  <input
                    name="areaMetrosQuadrados"
                    type="number"
                    defaultValue={2500}
                    className="w-full bg-[#080914] border border-white/10 rounded-xl px-3 py-2 text-white focus:outline-none focus:border-[#8B5CF6]"
                  />
                </div>
              </div>

              <div className="p-3 rounded-xl bg-purple-950/20 border border-purple-500/20 flex items-center gap-2">
                <input
                  type="checkbox"
                  name="criarEstruturaInicial"
                  value="true"
                  defaultChecked
                  id="chk-estrutura"
                  className="rounded text-[#8B5CF6]"
                />
                <label htmlFor="chk-estrutura" className="text-purple-200 cursor-pointer">
                  Gerar automaticamente posições iniciais (2 Ruas, 3 Prateleiras, 3 Níveis)
                </label>
              </div>

              <div className="flex items-center justify-end gap-2 pt-2">
                <button
                  type="button"
                  onClick={() => setShowNewCdModal(false)}
                  className="px-4 py-2 rounded-xl bg-white/5 hover:bg-white/10 text-white font-medium"
                >
                  Cancelar
                </button>
                <button
                  type="submit"
                  className="px-5 py-2 rounded-xl bg-[#8B5CF6] hover:bg-[#7C3AED] text-white font-semibold shadow-lg shadow-[#8B5CF6]/25"
                >
                  Cadastrar Galpão
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* ==================================================================== */}
      {/* MODAL: GERADOR DE MATRIZ DE ENDEREÇOS                                */}
      {/* ==================================================================== */}
      {showMatrixModal && activeCd && (
        <div className="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="bg-[#0D0E1A] border border-white/10 rounded-2xl max-w-lg w-full p-6 space-y-4">
            <div className="flex items-center justify-between pb-3 border-b border-white/5">
              <h3 className="text-base font-bold text-white flex items-center gap-2">
                <Layers className="w-5 h-5 text-[#8B5CF6]" />
                Gerador de Posições — {activeCd.codigo}
              </h3>
              <button onClick={() => setShowMatrixModal(false)} className="text-slate-400 hover:text-white">
                <X className="w-5 h-5" />
              </button>
            </div>

            <form onSubmit={handleGenerateMatrix} className="space-y-4 text-xs">
              <div>
                <label className="block text-[#AAA6B5] mb-1">Ruas / Corredores (separados por vírgula)</label>
                <input
                  name="ruas"
                  defaultValue="R01, R02, R03"
                  className="w-full bg-[#080914] border border-white/10 rounded-xl px-3 py-2 text-white uppercase focus:outline-none focus:border-[#8B5CF6]"
                />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-[#AAA6B5] mb-1">Prateleiras por Rua</label>
                  <input
                    name="prateleirasQtd"
                    type="number"
                    min={1}
                    max={20}
                    defaultValue={5}
                    className="w-full bg-[#080914] border border-white/10 rounded-xl px-3 py-2 text-white focus:outline-none focus:border-[#8B5CF6]"
                  />
                </div>
                <div>
                  <label className="block text-[#AAA6B5] mb-1">Níveis por Prateleira</label>
                  <input
                    name="niveisQtd"
                    type="number"
                    min={1}
                    max={10}
                    defaultValue={3}
                    className="w-full bg-[#080914] border border-white/10 rounded-xl px-3 py-2 text-white focus:outline-none focus:border-[#8B5CF6]"
                  />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-[#AAA6B5] mb-1">Capacidade Carga (kg)</label>
                  <input
                    name="capacidadeKg"
                    type="number"
                    defaultValue={1000}
                    className="w-full bg-[#080914] border border-white/10 rounded-xl px-3 py-2 text-white focus:outline-none focus:border-[#8B5CF6]"
                  />
                </div>
                <div>
                  <label className="block text-[#AAA6B5] mb-1">Capacidade Volumes</label>
                  <input
                    name="capacidadeVolumes"
                    type="number"
                    defaultValue={60}
                    className="w-full bg-[#080914] border border-white/10 rounded-xl px-3 py-2 text-white focus:outline-none focus:border-[#8B5CF6]"
                  />
                </div>
              </div>

              <div>
                <label className="block text-[#AAA6B5] mb-1">Tipo de Armazenagem Padrão</label>
                <select
                  name="tipoArmazenagem"
                  className="w-full bg-[#080914] border border-white/10 rounded-xl px-3 py-2 text-white focus:outline-none focus:border-[#8B5CF6]"
                >
                  <option value="palete">Palete Standard</option>
                  <option value="picking">Picking (Separação Rápida)</option>
                  <option value="pulmao">Pulmão de Sobra</option>
                  <option value="refrigerado">Câmara Fria / Refrigerado</option>
                  <option value="blocado">Blocado no Chão</option>
                </select>
              </div>

              <div className="flex items-center justify-end gap-2 pt-2">
                <button
                  type="button"
                  onClick={() => setShowMatrixModal(false)}
                  className="px-4 py-2 rounded-xl bg-white/5 hover:bg-white/10 text-white font-medium"
                >
                  Cancelar
                </button>
                <button
                  type="submit"
                  className="px-5 py-2 rounded-xl bg-[#8B5CF6] hover:bg-[#7C3AED] text-white font-semibold"
                >
                  Gerar Posições
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* ==================================================================== */}
      {/* MODAL: ALOCAR MERCADORIA NA POSIÇÃO                                 */}
      {/* ==================================================================== */}
      {showAllocateModal && activePosition && (
        <div className="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="bg-[#0D0E1A] border border-white/10 rounded-2xl max-w-md w-full p-6 space-y-4">
            <div className="flex items-center justify-between pb-3 border-b border-white/5">
              <h3 className="text-base font-bold text-white flex items-center gap-2">
                <Package className="w-5 h-5 text-[#8B5CF6]" />
                Alocar Mercadoria em {activePosition.codigo}
              </h3>
              <button onClick={() => setShowAllocateModal(false)} className="text-slate-400 hover:text-white">
                <X className="w-5 h-5" />
              </button>
            </div>

            <form onSubmit={handleAllocate} className="space-y-4 text-xs">
              <div>
                <label className="block text-[#AAA6B5] mb-1">Código SKU da Mercadoria*</label>
                <input
                  name="sku"
                  required
                  placeholder="EX: BEB-HEIN-350, SKU-TAB-001"
                  className="w-full bg-[#080914] border border-white/10 rounded-xl px-3 py-2 text-white uppercase focus:outline-none focus:border-[#8B5CF6]"
                />
              </div>

              <div>
                <label className="block text-[#AAA6B5] mb-1">Nome / Descrição do Produto*</label>
                <input
                  name="nome"
                  required
                  placeholder="Cerveja Heineken Lata 350ml Caixa c/ 12"
                  className="w-full bg-[#080914] border border-white/10 rounded-xl px-3 py-2 text-white focus:outline-none focus:border-[#8B5CF6]"
                />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-[#AAA6B5] mb-1">Quantidade (unidades)*</label>
                  <input
                    name="quantidade"
                    type="number"
                    min={1}
                    required
                    defaultValue={10}
                    className="w-full bg-[#080914] border border-white/10 rounded-xl px-3 py-2 text-white focus:outline-none focus:border-[#8B5CF6]"
                  />
                </div>
                <div>
                  <label className="block text-[#AAA6B5] mb-1">Peso Total (kg)</label>
                  <input
                    name="pesoKg"
                    type="number"
                    defaultValue={15}
                    className="w-full bg-[#080914] border border-white/10 rounded-xl px-3 py-2 text-white focus:outline-none focus:border-[#8B5CF6]"
                  />
                </div>
              </div>

              <div className="flex items-center justify-end gap-2 pt-2">
                <button
                  type="button"
                  onClick={() => setShowAllocateModal(false)}
                  className="px-4 py-2 rounded-xl bg-white/5 hover:bg-white/10 text-white font-medium"
                >
                  Cancelar
                </button>
                <button
                  type="submit"
                  className="px-5 py-2 rounded-xl bg-[#8B5CF6] hover:bg-[#7C3AED] text-white font-semibold"
                >
                  Confirmar Alocação
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* ==================================================================== */}
      {/* MODAL: QR CODE DO ENDEREÇO                                           */}
      {/* ==================================================================== */}
      {showQrModal && activePosition && (
        <div className="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="bg-[#0D0E1A] border border-white/10 rounded-2xl max-w-sm w-full p-6 text-center space-y-4">
            <div className="flex items-center justify-between pb-2 border-b border-white/5">
              <span className="text-xs font-bold text-white">Etiqueta de Endereçamento</span>
              <button onClick={() => setShowQrModal(false)} className="text-slate-400 hover:text-white">
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="p-4 bg-white rounded-xl inline-block shadow-xl">
              {/* Fallback QR representation */}
              <div className="w-48 h-48 bg-slate-900 flex flex-col items-center justify-center p-3 rounded text-white space-y-2">
                <QrCode className="w-24 h-24 text-white" />
                <span className="text-[10px] font-mono font-bold tracking-tight text-center break-all text-purple-300">
                  {activePosition.qrCode}
                </span>
              </div>
            </div>

            <div className="space-y-1">
              <h4 className="text-sm font-black text-white">{activePosition.codigo}</h4>
              <p className="text-xs text-[#AAA6B5]">
                Tipo: {activePosition.tipoArmazenagem.toUpperCase()} · Limite: {activePosition.capacidadeKg}kg
              </p>
            </div>

            <button
              onClick={() => {
                window.print();
              }}
              className="w-full py-2 rounded-xl bg-[#8B5CF6] text-white font-semibold text-xs"
            >
              Imprimir Etiqueta de Posição
            </button>
          </div>
        </div>
      )}

      {/* ==================================================================== */}
      {/* MODAL: NOVA TRANSFERÊNCIA                                            */}
      {/* ==================================================================== */}
      {showNewTransferModal && (
        <div className="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="bg-[#0D0E1A] border border-white/10 rounded-2xl max-w-lg w-full p-6 space-y-4">
            <div className="flex items-center justify-between pb-3 border-b border-white/5">
              <h3 className="text-base font-bold text-white flex items-center gap-2">
                <ArrowLeftRight className="w-5 h-5 text-[#8B5CF6]" />
                Registrar Transferência de Estoque
              </h3>
              <button onClick={() => setShowNewTransferModal(false)} className="text-slate-400 hover:text-white">
                <X className="w-5 h-5" />
              </button>
            </div>

            <form onSubmit={handleCreateTransfer} className="space-y-4 text-xs">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-[#AAA6B5] mb-1">CD Origem*</label>
                  <select
                    name="cdOrigemId"
                    className="w-full bg-[#080914] border border-white/10 rounded-xl px-3 py-2 text-white focus:outline-none focus:border-[#8B5CF6]"
                  >
                    {warehouses.map(w => (
                      <option key={w.id} value={w.id}>
                        {w.codigo} — {w.nome}
                      </option>
                    ))}
                  </select>
                </div>

                <div>
                  <label className="block text-[#AAA6B5] mb-1">CD Destino*</label>
                  <select
                    name="cdDestinoId"
                    className="w-full bg-[#080914] border border-white/10 rounded-xl px-3 py-2 text-white focus:outline-none focus:border-[#8B5CF6]"
                  >
                    {warehouses.map(w => (
                      <option key={w.id} value={w.id}>
                        {w.codigo} — {w.nome}
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              <div className="grid grid-cols-3 gap-3">
                <div>
                  <label className="block text-[#AAA6B5] mb-1">SKU do Item*</label>
                  <input
                    name="sku"
                    required
                    placeholder="SKU-PROD-01"
                    className="w-full bg-[#080914] border border-white/10 rounded-xl px-3 py-2 text-white uppercase focus:outline-none focus:border-[#8B5CF6]"
                  />
                </div>
                <div className="col-span-2">
                  <label className="block text-[#AAA6B5] mb-1">Nome do Item*</label>
                  <input
                    name="nome"
                    required
                    placeholder="Descrição da mercadoria"
                    className="w-full bg-[#080914] border border-white/10 rounded-xl px-3 py-2 text-white focus:outline-none focus:border-[#8B5CF6]"
                  />
                </div>
              </div>

              <div className="grid grid-cols-3 gap-3">
                <div>
                  <label className="block text-[#AAA6B5] mb-1">Quantidade*</label>
                  <input
                    name="quantidade"
                    type="number"
                    min={1}
                    required
                    defaultValue={10}
                    className="w-full bg-[#080914] border border-white/10 rounded-xl px-3 py-2 text-white focus:outline-none focus:border-[#8B5CF6]"
                  />
                </div>
                <div>
                  <label className="block text-[#AAA6B5] mb-1">Posição Origem</label>
                  <input
                    name="posicaoOrigem"
                    placeholder="Ex: CD1-R01-P01-N1"
                    className="w-full bg-[#080914] border border-white/10 rounded-xl px-3 py-2 text-white uppercase focus:outline-none focus:border-[#8B5CF6]"
                  />
                </div>
                <div>
                  <label className="block text-[#AAA6B5] mb-1">Posição Destino</label>
                  <input
                    name="posicaoDestino"
                    placeholder="Ex: CD2-R01-P01-N1"
                    className="w-full bg-[#080914] border border-white/10 rounded-xl px-3 py-2 text-white uppercase focus:outline-none focus:border-[#8B5CF6]"
                  />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-[#AAA6B5] mb-1">Motorista</label>
                  <input
                    name="motoristaNome"
                    placeholder="Nome do motorista responsável"
                    className="w-full bg-[#080914] border border-white/10 rounded-xl px-3 py-2 text-white focus:outline-none focus:border-[#8B5CF6]"
                  />
                </div>
                <div>
                  <label className="block text-[#AAA6B5] mb-1">Placa do Veículo</label>
                  <input
                    name="veiculoPlaca"
                    placeholder="BRA-2E19"
                    className="w-full bg-[#080914] border border-white/10 rounded-xl px-3 py-2 text-white uppercase focus:outline-none focus:border-[#8B5CF6]"
                  />
                </div>
              </div>

              <div className="flex items-center justify-end gap-2 pt-2">
                <button
                  type="button"
                  onClick={() => setShowNewTransferModal(false)}
                  className="px-4 py-2 rounded-xl bg-white/5 hover:bg-white/10 text-white font-medium"
                >
                  Cancelar
                </button>
                <button
                  type="submit"
                  className="px-5 py-2 rounded-xl bg-[#8B5CF6] hover:bg-[#7C3AED] text-white font-semibold"
                >
                  Emitir Transferência
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* ==================================================================== */}
      {/* MODAL: NOVO INVENTÁRIO / AUDITORIA                                   */}
      {/* ==================================================================== */}
      {showNewAuditModal && (
        <div className="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="bg-[#0D0E1A] border border-white/10 rounded-2xl max-w-md w-full p-6 space-y-4">
            <div className="flex items-center justify-between pb-3 border-b border-white/5">
              <h3 className="text-base font-bold text-white flex items-center gap-2">
                <ClipboardCheck className="w-5 h-5 text-[#8B5CF6]" />
                Abrir Nova Sessão de Inventário
              </h3>
              <button onClick={() => setShowNewAuditModal(false)} className="text-slate-400 hover:text-white">
                <X className="w-5 h-5" />
              </button>
            </div>

            <form onSubmit={handleCreateAudit} className="space-y-4 text-xs">
              <div>
                <label className="block text-[#AAA6B5] mb-1">Centro de Distribuição Alvo*</label>
                <select
                  name="cdId"
                  className="w-full bg-[#080914] border border-white/10 rounded-xl px-3 py-2 text-white focus:outline-none focus:border-[#8B5CF6]"
                >
                  {warehouses.map(w => (
                    <option key={w.id} value={w.id}>
                      {w.codigo} — {w.nome} ({w.posicoes?.length || 0} posições)
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label className="block text-[#AAA6B5] mb-1">Tipo de Inventário*</label>
                <select
                  name="tipoInventario"
                  className="w-full bg-[#080914] border border-white/10 rounded-xl px-3 py-2 text-white focus:outline-none focus:border-[#8B5CF6]"
                >
                  <option value="ciclico">Inventário Cíclico Periódico</option>
                  <option value="rotativo_curva_a">Rotativo (Curva A de Alto Valor)</option>
                  <option value="geral_completo">Inventário Geral Completo</option>
                </select>
              </div>

              <div>
                <label className="block text-[#AAA6B5] mb-1">Responsável pela Contagem</label>
                <input
                  name="responsavelAuditoria"
                  defaultValue={user?.name || 'Auditor Logístico'}
                  className="w-full bg-[#080914] border border-white/10 rounded-xl px-3 py-2 text-white focus:outline-none focus:border-[#8B5CF6]"
                />
              </div>

              <div className="flex items-center justify-end gap-2 pt-2">
                <button
                  type="button"
                  onClick={() => setShowNewAuditModal(false)}
                  className="px-4 py-2 rounded-xl bg-white/5 hover:bg-white/10 text-white font-medium"
                >
                  Cancelar
                </button>
                <button
                  type="submit"
                  className="px-5 py-2 rounded-xl bg-[#8B5CF6] hover:bg-[#7C3AED] text-white font-semibold"
                >
                  Abrir Inventário
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* ==================================================================== */}
      {/* MODAL: DIGITAÇÃO DE CONTAGENS FÍSICAS                                 */}
      {/* ==================================================================== */}
      {showAuditCountsModal && activeAudit && (
        <div className="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="bg-[#0D0E1A] border border-white/10 rounded-2xl max-w-2xl w-full p-6 space-y-4 max-h-[90vh] flex flex-col">
            <div className="flex items-center justify-between pb-3 border-b border-white/5">
              <h3 className="text-base font-bold text-white flex items-center gap-2">
                <ClipboardCheck className="w-5 h-5 text-[#8B5CF6]" />
                Digitar Contagens — {activeAudit.codigoInventario}
              </h3>
              <button onClick={() => setShowAuditCountsModal(false)} className="text-slate-400 hover:text-white">
                <X className="w-5 h-5" />
              </button>
            </div>

            <form onSubmit={handleSaveAuditCounts} className="space-y-4 text-xs overflow-y-auto flex-1 pr-1">
              {activeAudit.itens.length === 0 ? (
                <div className="py-8 text-center text-slate-500">
                  Nenhuma posição ocupada cadastrada neste galpão no momento da abertura do inventário.
                </div>
              ) : (
                <div className="space-y-2">
                  {activeAudit.itens.map((it, idx) => (
                    <div
                      key={idx}
                      className="p-3 rounded-xl bg-black/30 border border-white/5 flex items-center justify-between gap-3"
                    >
                      <div>
                        <span className="text-[10px] font-bold text-[#A78BFA]">{it.posicaoCodigo}</span>
                        <h4 className="text-xs font-bold text-white truncate max-w-xs">{it.nome}</h4>
                        <span className="text-[10px] text-slate-400">Saldo no Sistema: {it.saldoSistema} un</span>
                      </div>

                      <div className="flex items-center gap-2">
                        <label className="text-[10px] text-slate-300">Físico:</label>
                        <input
                          type="number"
                          data-item-pos={it.posicaoCodigo}
                          defaultValue={it.saldoContado || it.saldoSistema}
                          min={0}
                          className="w-20 bg-[#080914] border border-white/10 rounded-lg px-2 py-1 text-center text-xs text-white font-bold focus:outline-none focus:border-[#8B5CF6]"
                        />
                      </div>
                    </div>
                  ))}
                </div>
              )}

              <div className="flex items-center justify-end gap-2 pt-2 border-t border-white/5">
                <button
                  type="button"
                  onClick={() => setShowAuditCountsModal(false)}
                  className="px-4 py-2 rounded-xl bg-white/5 hover:bg-white/10 text-white font-medium"
                >
                  Fechar
                </button>
                <button
                  type="submit"
                  className="px-5 py-2 rounded-xl bg-[#8B5CF6] hover:bg-[#7C3AED] text-white font-semibold"
                >
                  Salvar Contagens Físicas
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
};

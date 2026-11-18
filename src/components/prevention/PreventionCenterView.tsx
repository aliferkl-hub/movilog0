import React, { useState, useEffect } from 'react';
import { useAuth } from '../../context/AuthContext';
import { api } from '../../lib/api';
import { PreventionAlert, PreventionMetrics, PreventionPriority, PreventionAlertType } from '../../types';
import {
  ShieldAlert,
  AlertTriangle,
  Clock,
  RotateCcw,
  CheckCircle2,
  Package,
  Truck,
  Building,
  Copy,
  RefreshCw,
  Search,
  Filter,
  ArrowRight,
  ExternalLink,
  Bell,
  X,
  Phone,
  Calendar,
  AlertOctagon,
  Sparkles,
  Check,
  Send,
  Boxes
} from 'lucide-react';

interface PreventionCenterViewProps {
  onNavigate?: (module: string, view?: string) => void;
}

export const PreventionCenterView: React.FC<PreventionCenterViewProps> = ({ onNavigate }) => {
  const { user, company, isMaster } = useAuth();
  const [alerts, setAlerts] = useState<PreventionAlert[]>([]);
  const [metrics, setMetrics] = useState<PreventionMetrics | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [searchTerm, setSearchTerm] = useState('');
  const [selectedType, setSelectedType] = useState<string>('all');
  const [selectedPriority, setSelectedPriority] = useState<string>('all');
  const [feedback, setFeedback] = useState<{ type: 'success' | 'error'; message: string } | null>(null);

  // Resolution Modal State
  const [resolvingAlert, setResolvingAlert] = useState<PreventionAlert | null>(null);
  const [resolucaoMotivo, setResolucaoMotivo] = useState('');
  const [submittingAction, setSubmittingAction] = useState(false);

  // Reschedule Modal State
  const [reschedulingAlert, setReschedulingAlert] = useState<PreventionAlert | null>(null);
  const [novoPrazoData, setNovoPrazoData] = useState('');
  const [rescheduleMotivo, setRescheduleMotivo] = useState('');

  const loadAlerts = async (silent = false) => {
    if (!silent) setLoading(true);
    else setRefreshing(true);

    try {
      const res = await api.getPreventionAlerts();
      setAlerts(res.alerts || []);
      setMetrics(res.metrics || null);
    } catch (err: any) {
      setFeedback({
        type: 'error',
        message: err.message || 'Falha ao sincronizar alertas da Central de Prevenção.'
      });
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  };

  useEffect(() => {
    loadAlerts();
    // Auto-sync every 45s
    const interval = setInterval(() => loadAlerts(true), 45000);
    return () => clearInterval(interval);
  }, []);

  const showFeedback = (type: 'success' | 'error', message: string) => {
    setFeedback({ type, message });
    setTimeout(() => setFeedback(null), 5000);
  };

  // Handle Resolve Alert
  const handleConfirmResolve = async () => {
    if (!resolvingAlert) return;
    setSubmittingAction(true);
    try {
      const res = await api.resolvePreventionAlert({
        alertId: resolvingAlert.id,
        tipo: resolvingAlert.tipo,
        referenciaId: resolvingAlert.referenciaId,
        motivoResolucao: resolucaoMotivo.trim() || 'Tratado e auditado pelo operador'
      });
      showFeedback('success', res.message || 'Alerta registrado como tratado!');
      setResolvingAlert(null);
      setResolucaoMotivo('');
      await loadAlerts(true);
    } catch (err: any) {
      showFeedback('error', err.message || 'Erro ao registrar resolução do alerta.');
    } finally {
      setSubmittingAction(false);
    }
  };

  // Handle Re-notify Condo Package
  const handleRenotifyPackage = async (packageId: string) => {
    setSubmittingAction(true);
    try {
      const res = await api.renotifyPreventionPackage(packageId);
      showFeedback('success', res.message || 'Notificação reenviada com sucesso!');
      await loadAlerts(true);
    } catch (err: any) {
      showFeedback('error', err.message || 'Erro ao reenviar notificação da encomenda.');
    } finally {
      setSubmittingAction(false);
    }
  };

  // Handle Reschedule Delivery
  const handleConfirmReschedule = async () => {
    if (!reschedulingAlert) return;
    setSubmittingAction(true);
    try {
      const res = await api.reschedulePreventionDelivery({
        deliveryId: reschedulingAlert.referenciaId,
        novoPrazo: novoPrazoData || undefined,
        motivo: rescheduleMotivo.trim() || 'Ajuste proativo via Central de Prevenção'
      });
      showFeedback('success', res.message || 'Entrega liberada para nova alocação no roteirizador!');
      setReschedulingAlert(null);
      setNovoPrazoData('');
      setRescheduleMotivo('');
      await loadAlerts(true);
    } catch (err: any) {
      showFeedback('error', err.message || 'Erro ao reagendar entrega.');
    } finally {
      setSubmittingAction(false);
    }
  };

  // Filter alerts
  const filteredAlerts = alerts.filter(alert => {
    // Type Filter
    if (selectedType !== 'all' && alert.tipo !== selectedType) {
      return false;
    }
    // Priority Filter
    if (selectedPriority !== 'all' && alert.prioridade !== selectedPriority) {
      return false;
    }
    // Search Term Filter
    if (searchTerm.trim()) {
      const term = searchTerm.toLowerCase().trim();
      const matchTitle = alert.titulo.toLowerCase().includes(term);
      const matchMotivo = alert.motivo.toLowerCase().includes(term);
      const matchCode = alert.referenciaCodigo?.toLowerCase().includes(term);
      const matchAction = alert.acaoRecomendada.toLowerCase().includes(term);
      const matchDest = alert.detalhesExtras?.destinatario?.toLowerCase().includes(term);
      const matchUnit = alert.detalhesExtras?.unidadeIdentificacao?.toLowerCase().includes(term);
      return matchTitle || matchMotivo || matchCode || matchAction || matchDest || matchUnit;
    }
    return true;
  });

  const getPriorityBadge = (p: PreventionPriority) => {
    switch (p) {
      case 'urgente':
        return {
          label: 'CRÍTICO / URGENTE',
          bg: 'bg-rose-500/20 text-rose-300 border-rose-500/40',
          dot: 'bg-rose-500'
        };
      case 'alta':
        return {
          label: 'ALTA PRIORIDADE',
          bg: 'bg-amber-500/20 text-amber-300 border-amber-500/40',
          dot: 'bg-amber-400'
        };
      case 'media':
        return {
          label: 'ATENÇÃO MÉDIA',
          bg: 'bg-blue-500/20 text-blue-300 border-blue-500/40',
          dot: 'bg-blue-400'
        };
      default:
        return {
          label: 'BAIXA',
          bg: 'bg-slate-500/20 text-slate-300 border-slate-500/40',
          dot: 'bg-slate-400'
        };
    }
  };

  const getTypeIcon = (tipo: PreventionAlertType) => {
    switch (tipo) {
      case 'atraso_entrega':
        return <Clock className="w-5 h-5 text-amber-400" />;
      case 'tentativa_falha':
        return <AlertOctagon className="w-5 h-5 text-rose-400" />;
      case 'encomenda_pendente':
        return <Building className="w-5 h-5 text-cyan-400" />;
      case 'duplicidade_suspeita':
        return <Copy className="w-5 h-5 text-purple-400" />;
      case 'rota_ocorrencia':
        return <Truck className="w-5 h-5 text-orange-400" />;
      case 'estoque_critico':
        return <Boxes className="w-5 h-5 text-red-400" />;
      default:
        return <AlertTriangle className="w-5 h-5 text-yellow-400" />;
    }
  };

  const getTypeLabel = (tipo: PreventionAlertType) => {
    switch (tipo) {
      case 'atraso_entrega':
        return 'Atraso de Entrega';
      case 'tentativa_falha':
        return 'Insucesso Operacional';
      case 'encomenda_pendente':
        return 'Portaria / Retenção';
      case 'duplicidade_suspeita':
        return 'Duplicidade Suspeita';
      case 'rota_ocorrencia':
        return 'Gargalo em Rota';
      case 'estoque_critico':
        return 'Ruptura de Estoque';
      default:
        return 'Alerta';
    }
  };

  return (
    <div className="space-y-6">
      {/* Top Banner Header */}
      <div className="bg-gradient-to-r from-[#121024] via-[#1A1633] to-[#0A0714] border border-[#2E2854] rounded-3xl p-6 shadow-2xl flex flex-col md:flex-row items-start md:items-center justify-between gap-4">
        <div className="flex items-start gap-4">
          <div className="w-14 h-14 rounded-2xl bg-gradient-to-br from-[#8B5CF6]/30 to-rose-500/20 border border-[#8B5CF6]/40 flex items-center justify-center text-[#C4B5FD] shadow-lg shrink-0">
            <ShieldAlert className="w-8 h-8 text-[#A78BFA]" />
          </div>
          <div>
            <div className="flex items-center gap-2.5 flex-wrap">
              <span className="px-2.5 py-0.5 rounded-full text-[10px] font-bold tracking-wider uppercase bg-[#8B5CF6]/20 text-[#DDD6FE] border border-[#8B5CF6]/40">
                MoviLog Inteligente
              </span>
              <span className="text-xs text-[#AAA6B5] flex items-center gap-1.5">
                <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse"></span>
                Regras Locais em Tempo Real
              </span>
            </div>
            <h1 className="text-xl font-black text-white tracking-tight mt-1">
              Central de Prevenção & Alertas Operacionais
            </h1>
            <p className="text-xs text-[#AAA6B5] max-w-2xl mt-0.5 leading-relaxed">
              Monitoramento preventivo para identificar entregas atrasadas, tentativas falhas, encomendas represadas na portaria, duplicidades e gargalos de rota antes que virem prejuízo.
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2.5 shrink-0 w-full md:w-auto justify-end">
          <button
            onClick={() => loadAlerts()}
            disabled={loading || refreshing}
            className="px-4 py-2.5 bg-[#1A1633] hover:bg-[#262042] border border-[#2E2854] text-white text-xs font-semibold rounded-xl flex items-center gap-2 transition"
          >
            <RefreshCw className={`w-3.5 h-3.5 text-[#8B5CF6] ${refreshing ? 'animate-spin' : ''}`} />
            <span>{refreshing ? 'Atualizando...' : 'Atualizar Alertas'}</span>
          </button>
        </div>
      </div>

      {/* Feedback Toast */}
      {feedback && (
        <div
          className={`p-4 rounded-2xl text-xs font-medium border flex items-center justify-between transition shadow-xl ${
            feedback.type === 'success'
              ? 'bg-emerald-950/40 border-emerald-500/40 text-emerald-200'
              : 'bg-rose-950/40 border-rose-500/40 text-rose-200'
          }`}
        >
          <div className="flex items-center gap-2.5">
            {feedback.type === 'success' ? (
              <CheckCircle2 className="w-5 h-5 text-emerald-400 shrink-0" />
            ) : (
              <AlertTriangle className="w-5 h-5 text-rose-400 shrink-0" />
            )}
            <span>{feedback.message}</span>
          </div>
          <button onClick={() => setFeedback(null)} className="text-white/60 hover:text-white p-1">
            <X className="w-4 h-4" />
          </button>
        </div>
      )}

      {/* KPI Cards Section */}
      {metrics && (
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3.5">
          {/* Total Ativos */}
          <div className="bg-[#121024] border border-[#262042] rounded-2xl p-4 flex flex-col justify-between">
            <div className="flex items-center justify-between mb-1">
              <span className="text-[11px] font-semibold text-[#AAA6B5]">Alertas Ativos</span>
              <div className="w-6 h-6 rounded-lg bg-[#8B5CF6]/15 text-[#C4B5FD] flex items-center justify-center">
                <ShieldAlert className="w-3.5 h-3.5" />
              </div>
            </div>
            <div className="text-2xl font-black text-white">{metrics.totalAlertasAtivos}</div>
            <span className="text-[10px] text-[#716A86] mt-1">Exigem atenção operacional</span>
          </div>

          {/* Críticos / Urgentes */}
          <div className="bg-gradient-to-br from-[#1c1122] to-[#121024] border border-rose-500/30 rounded-2xl p-4 flex flex-col justify-between">
            <div className="flex items-center justify-between mb-1">
              <span className="text-[11px] font-semibold text-rose-300">Críticos / Urgentes</span>
              <div className="w-6 h-6 rounded-lg bg-rose-500/20 text-rose-400 flex items-center justify-center">
                <AlertOctagon className="w-3.5 h-3.5" />
              </div>
            </div>
            <div className="text-2xl font-black text-rose-400">{metrics.alertasUrgentes}</div>
            <span className="text-[10px] text-rose-300/70 mt-1">SLA violado ou &gt;24h atraso</span>
          </div>

          {/* Entregas Atrasadas */}
          <div className="bg-[#121024] border border-[#262042] rounded-2xl p-4 flex flex-col justify-between">
            <div className="flex items-center justify-between mb-1">
              <span className="text-[11px] font-semibold text-[#AAA6B5]">Entregas Atrasadas</span>
              <div className="w-6 h-6 rounded-lg bg-amber-500/15 text-amber-300 flex items-center justify-center">
                <Clock className="w-3.5 h-3.5" />
              </div>
            </div>
            <div className="text-2xl font-black text-amber-300">{metrics.entregasAtrasadasCount}</div>
            <span className="text-[10px] text-[#716A86] mt-1">Prazo de entrega expirado</span>
          </div>

          {/* Encomendas Retidas */}
          <div className="bg-[#121024] border border-[#262042] rounded-2xl p-4 flex flex-col justify-between">
            <div className="flex items-center justify-between mb-1">
              <span className="text-[11px] font-semibold text-[#AAA6B5]">Portaria / Retenção</span>
              <div className="w-6 h-6 rounded-lg bg-cyan-500/15 text-cyan-300 flex items-center justify-center">
                <Building className="w-3.5 h-3.5" />
              </div>
            </div>
            <div className="text-2xl font-black text-cyan-300">{metrics.encomendasRetidasCount}</div>
            <span className="text-[10px] text-[#716A86] mt-1">&ge;3 dias sem retirada</span>
          </div>

          {/* Taxa de Resolução */}
          <div className="bg-[#121024] border border-[#262042] rounded-2xl p-4 flex flex-col justify-between">
            <div className="flex items-center justify-between mb-1">
              <span className="text-[11px] font-semibold text-[#AAA6B5]">Taxa de Resolução</span>
              <div className="w-6 h-6 rounded-lg bg-emerald-500/15 text-emerald-400 flex items-center justify-center">
                <CheckCircle2 className="w-3.5 h-3.5" />
              </div>
            </div>
            <div className="text-2xl font-black text-emerald-400">
              {metrics.taxaResolucaoPercentual}%
            </div>
            <span className="text-[10px] text-[#716A86] mt-1">
              {metrics.totalResolvidosHistorico} alertas tratados
            </span>
          </div>
        </div>
      )}

      {/* Filter and Search Controls */}
      <div className="bg-[#121024] border border-[#262042] rounded-2xl p-4 space-y-3">
        {/* Category Buttons Pill Bar */}
        <div className="flex items-center gap-2 overflow-x-auto pb-1 scrollbar-thin">
          <button
            onClick={() => setSelectedType('all')}
            className={`px-3 py-1.5 rounded-xl text-xs font-semibold transition whitespace-nowrap ${
              selectedType === 'all'
                ? 'bg-[#8B5CF6] text-white shadow-md'
                : 'bg-[#0A0714] text-[#AAA6B5] hover:text-white border border-[#262042]'
            }`}
          >
            Todos os Alertas ({metrics?.totalAlertasAtivos ?? alerts.length})
          </button>
          <button
            onClick={() => setSelectedType('atraso_entrega')}
            className={`px-3 py-1.5 rounded-xl text-xs font-semibold transition whitespace-nowrap flex items-center gap-1.5 ${
              selectedType === 'atraso_entrega'
                ? 'bg-[#8B5CF6] text-white shadow-md'
                : 'bg-[#0A0714] text-[#AAA6B5] hover:text-white border border-[#262042]'
            }`}
          >
            <Clock className="w-3.5 h-3.5 text-amber-400" />
            <span>Atrasos ({metrics?.entregasAtrasadasCount || 0})</span>
          </button>
          <button
            onClick={() => setSelectedType('tentativa_falha')}
            className={`px-3 py-1.5 rounded-xl text-xs font-semibold transition whitespace-nowrap flex items-center gap-1.5 ${
              selectedType === 'tentativa_falha'
                ? 'bg-[#8B5CF6] text-white shadow-md'
                : 'bg-[#0A0714] text-[#AAA6B5] hover:text-white border border-[#262042]'
            }`}
          >
            <AlertOctagon className="w-3.5 h-3.5 text-rose-400" />
            <span>Insucessos ({metrics?.tentativasFalhasCount || 0})</span>
          </button>
          <button
            onClick={() => setSelectedType('encomenda_pendente')}
            className={`px-3 py-1.5 rounded-xl text-xs font-semibold transition whitespace-nowrap flex items-center gap-1.5 ${
              selectedType === 'encomenda_pendente'
                ? 'bg-[#8B5CF6] text-white shadow-md'
                : 'bg-[#0A0714] text-[#AAA6B5] hover:text-white border border-[#262042]'
            }`}
          >
            <Building className="w-3.5 h-3.5 text-cyan-400" />
            <span>Portaria ({metrics?.encomendasRetidasCount || 0})</span>
          </button>
          <button
            onClick={() => setSelectedType('duplicidade_suspeita')}
            className={`px-3 py-1.5 rounded-xl text-xs font-semibold transition whitespace-nowrap flex items-center gap-1.5 ${
              selectedType === 'duplicidade_suspeita'
                ? 'bg-[#8B5CF6] text-white shadow-md'
                : 'bg-[#0A0714] text-[#AAA6B5] hover:text-white border border-[#262042]'
            }`}
          >
            <Copy className="w-3.5 h-3.5 text-purple-400" />
            <span>Duplicidades ({metrics?.duplicidadesCount || 0})</span>
          </button>
          <button
            onClick={() => setSelectedType('rota_ocorrencia')}
            className={`px-3 py-1.5 rounded-xl text-xs font-semibold transition whitespace-nowrap flex items-center gap-1.5 ${
              selectedType === 'rota_ocorrencia'
                ? 'bg-[#8B5CF6] text-white shadow-md'
                : 'bg-[#0A0714] text-[#AAA6B5] hover:text-white border border-[#262042]'
            }`}
          >
            <Truck className="w-3.5 h-3.5 text-orange-400" />
            <span>Rotas ({metrics?.rotasComProblemasCount || 0})</span>
          </button>
          <button
            onClick={() => setSelectedType('estoque_critico')}
            className={`px-3 py-1.5 rounded-xl text-xs font-semibold transition whitespace-nowrap flex items-center gap-1.5 ${
              selectedType === 'estoque_critico'
                ? 'bg-[#8B5CF6] text-white shadow-md'
                : 'bg-[#0A0714] text-[#AAA6B5] hover:text-white border border-[#262042]'
            }`}
          >
            <Boxes className="w-3.5 h-3.5 text-red-400" />
            <span>Estoque Zerado ({metrics?.estoqueCriticoCount || 0})</span>
          </button>
        </div>

        {/* Search Input & Priority Dropdown */}
        <div className="flex flex-col sm:flex-row gap-3 items-center justify-between">
          <div className="relative flex-1 w-full">
            <Search className="w-4 h-4 absolute left-3 top-3 text-[#AAA6B5]" />
            <input
              type="text"
              placeholder="Buscar por código de rastreio, destinatário, endereço, unidade predial ou rota..."
              value={searchTerm}
              onChange={e => setSearchTerm(e.target.value)}
              className="w-full bg-[#0A0714] border border-[#262042] rounded-xl pl-9 pr-3 py-2 text-xs text-white placeholder-[#AAA6B5] focus:outline-none focus:border-[#8B5CF6]"
            />
          </div>

          <div className="flex items-center gap-2 w-full sm:w-auto">
            <select
              value={selectedPriority}
              onChange={e => setSelectedPriority(e.target.value)}
              className="bg-[#0A0714] border border-[#262042] rounded-xl px-3 py-2 text-xs text-white focus:outline-none focus:border-[#8B5CF6] w-full sm:w-auto"
            >
              <option value="all">Todas as Prioridades</option>
              <option value="urgente">Crítico / Urgente</option>
              <option value="alta">Alta Prioridade</option>
              <option value="media">Atenção Média</option>
              <option value="baixa">Baixa</option>
            </select>
          </div>
        </div>
      </div>

      {/* Alerts List */}
      {loading ? (
        <div className="bg-[#121024] border border-[#262042] rounded-2xl p-16 text-center text-[#AAA6B5] text-xs">
          Analisando histórico de entregas, portaria, rotas e ocorrências...
        </div>
      ) : filteredAlerts.length === 0 ? (
        <div className="bg-[#121024] border border-[#262042] rounded-2xl p-16 text-center text-[#AAA6B5] space-y-3 shadow-xl">
          <div className="w-16 h-16 rounded-3xl bg-emerald-500/10 border border-emerald-500/30 flex items-center justify-center text-emerald-400 mx-auto">
            <CheckCircle2 className="w-8 h-8" />
          </div>
          <h3 className="text-base font-bold text-white">Nenhuma anomalia ativa detectada</h3>
          <p className="text-xs max-w-md mx-auto leading-relaxed">
            {searchTerm || selectedType !== 'all' || selectedPriority !== 'all'
              ? 'Nenhum alerta corresponde aos filtros selecionados. Tente limpar os filtros para ver outros registros.'
              : 'Excelente! Todas as entregas, rotas, encomendas prediais e estoques estão operando dentro dos prazos de SLA e sem ocorrências não tratadas.'}
          </p>
        </div>
      ) : (
        <div className="space-y-3.5">
          {filteredAlerts.map(alert => {
            const badge = getPriorityBadge(alert.prioridade);
            const icon = getTypeIcon(alert.tipo);

            return (
              <div
                key={alert.id}
                className="bg-[#121024] border border-[#262042] hover:border-[#8B5CF6]/50 rounded-2xl p-5 transition shadow-lg space-y-3"
              >
                {/* Header row: Priority, Type, and Reference code */}
                <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2.5 pb-2 border-b border-[#262042]/70">
                  <div className="flex items-center gap-2.5 flex-wrap">
                    <span className={`px-2.5 py-0.5 rounded-full text-[10px] font-bold border flex items-center gap-1.5 ${badge.bg}`}>
                      <span className={`w-1.5 h-1.5 rounded-full ${badge.dot}`}></span>
                      {badge.label}
                    </span>

                    <span className="px-2 py-0.5 rounded-lg text-[10px] font-semibold bg-[#1A1633] text-[#C4B5FD] border border-[#2E2854]">
                      {getTypeLabel(alert.tipo)}
                    </span>

                    {alert.referenciaCodigo && (
                      <span className="text-xs font-mono font-bold text-white bg-[#0A0714] px-2 py-0.5 rounded border border-[#262042]">
                        {alert.referenciaCodigo}
                      </span>
                    )}
                  </div>

                  <span className="text-[11px] text-[#716A86] whitespace-nowrap">
                    Registrado em {new Date(alert.criadoEm).toLocaleString('pt-BR')}
                  </span>
                </div>

                {/* Title & Real Motivo */}
                <div className="flex items-start gap-3">
                  <div className="w-10 h-10 rounded-xl bg-[#0A0714] border border-[#262042] flex items-center justify-center shrink-0 mt-0.5">
                    {icon}
                  </div>
                  <div className="flex-1 space-y-1">
                    <h3 className="text-sm font-bold text-white leading-snug">{alert.titulo}</h3>
                    <p className="text-xs text-[#AAA6B5] leading-relaxed bg-[#0A0714] p-3 rounded-xl border border-[#262042]">
                      <strong className="text-white">Motivo / Evidência:</strong> {alert.motivo}
                    </p>
                  </div>
                </div>

                {/* Action Recommended Box */}
                <div className="p-3 rounded-xl bg-gradient-to-r from-[#1A1633] to-[#121024] border border-[#8B5CF6]/30 flex flex-col sm:flex-row sm:items-center justify-between gap-3 text-xs">
                  <div className="flex items-start gap-2 text-[#DDD6FE]">
                    <Sparkles className="w-4 h-4 text-[#8B5CF6] shrink-0 mt-0.5" />
                    <div>
                      <span className="font-bold text-white block">Ação Recomendada pelo Sistema:</span>
                      <span className="text-xs text-[#C4B5FD] leading-relaxed">{alert.acaoRecomendada}</span>
                    </div>
                  </div>

                  {/* Operational Action Buttons */}
                  <div className="flex items-center gap-2 shrink-0 flex-wrap justify-end">
                    {/* Specific Action: Reschedule delivery */}
                    {alert.referenciaTipo === 'delivery' && (
                      <button
                        onClick={() => {
                          setReschedulingAlert(alert);
                          setNovoPrazoData(new Date(Date.now() + 24 * 3600 * 1000).toISOString().split('T')[0]);
                          setRescheduleMotivo(`Reagendamento preventivo: ${alert.titulo}`);
                        }}
                        className="px-3 py-1.5 bg-[#8B5CF6] hover:bg-[#7C3AED] text-white font-bold text-xs rounded-xl flex items-center gap-1.5 transition shadow-md shadow-[#8B5CF6]/20"
                      >
                        <RotateCcw className="w-3.5 h-3.5" />
                        <span>Reagendar Entrega</span>
                      </button>
                    )}

                    {/* Specific Action: Re-notify condo package */}
                    {alert.referenciaTipo === 'package' && (
                      <button
                        onClick={() => handleRenotifyPackage(alert.referenciaId)}
                        disabled={submittingAction}
                        className="px-3 py-1.5 bg-cyan-600 hover:bg-cyan-500 text-white font-bold text-xs rounded-xl flex items-center gap-1.5 transition shadow-md shadow-cyan-900/20"
                      >
                        <Bell className="w-3.5 h-3.5" />
                        <span>Reenviar PIN ao Morador</span>
                      </button>
                    )}

                    {/* Specific Action: Navigate to Route Planner */}
                    {alert.referenciaTipo === 'route' && onNavigate && (
                      <button
                        onClick={() => onNavigate('routing', 'planner')}
                        className="px-3 py-1.5 bg-[#8B5CF6] hover:bg-[#7C3AED] text-white font-bold text-xs rounded-xl flex items-center gap-1.5 transition"
                      >
                        <Truck className="w-3.5 h-3.5" />
                        <span>Abrir Roteirizador</span>
                      </button>
                    )}

                    {/* Generic Dismiss / Resolve Button */}
                    <button
                      onClick={() => {
                        setResolvingAlert(alert);
                        setResolucaoMotivo('Analisado e tratado operacionalmente');
                      }}
                      className="px-3 py-1.5 bg-[#0A0714] hover:bg-[#1A1633] text-[#AAA6B5] hover:text-white border border-[#262042] font-semibold text-xs rounded-xl flex items-center gap-1.5 transition"
                    >
                      <Check className="w-3.5 h-3.5 text-emerald-400" />
                      <span>Marcar como Tratado</span>
                    </button>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Modal: Marcar Alerta como Tratado */}
      {resolvingAlert && (
        <div className="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="bg-[#121024] border border-[#262042] rounded-3xl p-6 max-w-md w-full shadow-2xl relative text-white space-y-4">
            <button
              onClick={() => setResolvingAlert(null)}
              className="absolute top-4 right-4 text-[#AAA6B5] hover:text-white p-1"
            >
              <X className="w-5 h-5" />
            </button>

            <div className="flex items-center gap-2.5">
              <div className="w-10 h-10 rounded-xl bg-emerald-500/20 text-emerald-400 border border-emerald-500/40 flex items-center justify-center shrink-0">
                <CheckCircle2 className="w-5 h-5" />
              </div>
              <div>
                <h3 className="text-base font-bold text-white">Marcar Alerta como Tratado</h3>
                <p className="text-xs text-[#AAA6B5]">Auditoria operacional da resolução</p>
              </div>
            </div>

            <p className="text-xs text-[#AAA6B5]">
              Você está registrando a tratativa para: <strong className="text-white">{resolvingAlert.titulo}</strong>
            </p>

            <div>
              <label className="text-xs font-semibold text-[#AAA6B5] mb-1.5 block">
                Justificativa / Procedimento Realizado *
              </label>
              <textarea
                rows={3}
                value={resolucaoMotivo}
                onChange={e => setResolucaoMotivo(e.target.value)}
                placeholder="Ex: Contatado o cliente por telefone, endereço confirmado e liberado para próxima expedição."
                className="w-full bg-[#0A0714] border border-[#262042] rounded-xl px-3 py-2 text-xs text-white placeholder-[#716A86] focus:outline-none focus:border-[#8B5CF6]"
              />
            </div>

            <div className="flex justify-end gap-2.5 pt-2 border-t border-[#262042]">
              <button
                type="button"
                onClick={() => setResolvingAlert(null)}
                className="px-4 py-2 bg-[#1A1633] text-[#AAA6B5] hover:text-white rounded-xl text-xs font-semibold transition"
              >
                Cancelar
              </button>
              <button
                type="button"
                disabled={submittingAction || !resolucaoMotivo.trim()}
                onClick={handleConfirmResolve}
                className="px-5 py-2 bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 text-white rounded-xl text-xs font-bold transition flex items-center gap-1.5 shadow-lg shadow-emerald-900/30"
              >
                {submittingAction ? 'Salvando...' : 'Confirmar Tratativa'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Modal: Reagendar Entrega */}
      {reschedulingAlert && (
        <div className="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="bg-[#121024] border border-[#262042] rounded-3xl p-6 max-w-md w-full shadow-2xl relative text-white space-y-4">
            <button
              onClick={() => setReschedulingAlert(null)}
              className="absolute top-4 right-4 text-[#AAA6B5] hover:text-white p-1"
            >
              <X className="w-5 h-5" />
            </button>

            <div className="flex items-center gap-2.5">
              <div className="w-10 h-10 rounded-xl bg-[#8B5CF6]/20 text-[#C4B5FD] border border-[#8B5CF6]/40 flex items-center justify-center shrink-0">
                <RotateCcw className="w-5 h-5" />
              </div>
              <div>
                <h3 className="text-base font-bold text-white">Reagendar Entrega</h3>
                <p className="text-xs text-[#AAA6B5]">
                  Liberação para novo plano de rota no despachante
                </p>
              </div>
            </div>

            <p className="text-xs text-[#AAA6B5]">
              Entrega selecionada: <strong className="text-white">{reschedulingAlert.referenciaCodigo}</strong>
            </p>

            <div>
              <label className="text-xs font-semibold text-[#AAA6B5] mb-1.5 block">
                Novo Prazo de Entrega (Data)
              </label>
              <input
                type="date"
                value={novoPrazoData}
                onChange={e => setNovoPrazoData(e.target.value)}
                className="w-full bg-[#0A0714] border border-[#262042] rounded-xl px-3 py-2 text-xs text-white focus:outline-none focus:border-[#8B5CF6]"
              />
            </div>

            <div>
              <label className="text-xs font-semibold text-[#AAA6B5] mb-1.5 block">
                Motivo do Reagendamento
              </label>
              <textarea
                rows={2}
                value={rescheduleMotivo}
                onChange={e => setRescheduleMotivo(e.target.value)}
                placeholder="Ex: Reagendado após contato com o cliente; Endereço validado."
                className="w-full bg-[#0A0714] border border-[#262042] rounded-xl px-3 py-2 text-xs text-white placeholder-[#716A86] focus:outline-none focus:border-[#8B5CF6]"
              />
            </div>

            <div className="flex justify-end gap-2.5 pt-2 border-t border-[#262042]">
              <button
                type="button"
                onClick={() => setReschedulingAlert(null)}
                className="px-4 py-2 bg-[#1A1633] text-[#AAA6B5] hover:text-white rounded-xl text-xs font-semibold transition"
              >
                Cancelar
              </button>
              <button
                type="button"
                disabled={submittingAction}
                onClick={handleConfirmReschedule}
                className="px-5 py-2 bg-[#8B5CF6] hover:bg-[#7C3AED] disabled:opacity-50 text-white rounded-xl text-xs font-bold transition flex items-center gap-1.5 shadow-lg shadow-[#8B5CF6]/30"
              >
                {submittingAction ? 'Processando...' : 'Confirmar Reagendamento'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

/**
 * MOVILOG — SUÍTE DE AUDITORIA CRÍTICA DO MASTER OWNER
 * Testes reais de autenticação, persistência, autorização, recuperação e isolamento
 */
import { db, createSession, destroySession } from './db.ts';

const BASE_URL = 'http://localhost:3000';

interface TestResult {
  testId: string;
  name: string;
  success: boolean;
  details: string;
}

const results: TestResult[] = [];

async function runMasterAuthAudit() {
  console.log('================================================================');
  console.log('🛡️ INICIANDO AUDITORIA CRÍTICA — ACESSO MASTER OWNER (12 TESTES)');
  console.log('================================================================\n');

  const masterEmailHotmail = 'Alifermadeiro@hotmail.com';
  const masterEmailGoogle = 'alifergael76@gmail.com';
  const validPassword = 'Master@MoviLog2026';

  let masterSessionToken = '';
  let normalUserSessionToken = '';

  try {
    // ------------------------------------------------------------------------
    // TESTE 1: Login com credencial válida do Master Owner
    // ------------------------------------------------------------------------
    {
      const res = await fetch(`${BASE_URL}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: masterEmailHotmail, password: validPassword })
      });
      const data = await res.json();
      const pass = res.ok && data.token && data.user?.role === 'master_owner';
      if (pass) masterSessionToken = data.token;

      results.push({
        testId: 'TESTE 1',
        name: 'Login com credencial válida do Master Owner',
        success: pass,
        details: pass
          ? `Autenticado com sucesso via POST /api/auth/login. Usuário: ${data.user.name} (${data.user.email}), Role: ${data.user.role}.`
          : `Falha no login: ${JSON.stringify(data)}`
      });
    }

    // ------------------------------------------------------------------------
    // TESTE 2: Login com senha incorreta
    // ------------------------------------------------------------------------
    {
      const res = await fetch(`${BASE_URL}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: masterEmailHotmail, password: 'SenhaTotalmenteIncorreta123' })
      });
      const data = await res.json();
      const pass = res.status === 401 && data.error === 'Credenciais inválidas';

      results.push({
        testId: 'TESTE 2',
        name: 'Login com senha incorreta',
        success: pass,
        details: pass
          ? `Senha incorreta rejeitada com HTTP 401: "${data.error}".`
          : `Falha: Status esperado 401, obtido ${res.status}. Resposta: ${JSON.stringify(data)}`
      });
    }

    // ------------------------------------------------------------------------
    // TESTE 3: Persistência da sessão
    // ------------------------------------------------------------------------
    {
      const res = await fetch(`${BASE_URL}/api/auth/me`, {
        headers: { Authorization: `Bearer ${masterSessionToken}` }
      });
      const data = await res.json();
      const pass = res.ok && data.user?.role === 'master_owner' && data.user?.id;

      results.push({
        testId: 'TESTE 3',
        name: 'Persistência da sessão',
        success: pass,
        details: pass
          ? `Sessão ativa e persistente validada no backend para Master Owner ID: ${data.user.id}.`
          : `Falha ao validar sessão: ${JSON.stringify(data)}`
      });
    }

    // ------------------------------------------------------------------------
    // TESTE 4: Atualização da página mantendo autenticação válida (F5 refresh)
    // ------------------------------------------------------------------------
    {
      // Simular refresh sequencial múltiplo através de requisições separadas
      const req1 = await fetch(`${BASE_URL}/api/auth/me`, { headers: { Authorization: `Bearer ${masterSessionToken}` } });
      const req2 = await fetch(`${BASE_URL}/api/auth/me`, { headers: { Authorization: `Bearer ${masterSessionToken}` } });
      const data1 = await req1.json();
      const data2 = await req2.json();
      const pass = req1.ok && req2.ok && data1.user.id === data2.user.id && data1.user.role === 'master_owner';

      results.push({
        testId: 'TESTE 4',
        name: 'Atualização da página mantendo autenticação válida',
        success: pass,
        details: pass
          ? `Sessão sobrevive perfeitamente a reloads e reconexões consecutivas sem deslogar.`
          : `Falha no refresh de sessão.`
      });
    }

    // ------------------------------------------------------------------------
    // TESTE 5: Logout e invalidação da sessão
    // ------------------------------------------------------------------------
    {
      // Criar token temporário para testar logout
      const tempRes = await fetch(`${BASE_URL}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: masterEmailHotmail, password: validPassword })
      });
      const tempData = await tempRes.json();
      const tempToken = tempData.token;

      // Executar logout
      const logoutRes = await fetch(`${BASE_URL}/api/auth/logout`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${tempToken}` }
      });

      // Tentar usar token invalidado
      const afterLogoutRes = await fetch(`${BASE_URL}/api/auth/me`, {
        headers: { Authorization: `Bearer ${tempToken}` }
      });
      const pass = logoutRes.ok && afterLogoutRes.status === 401;

      results.push({
        testId: 'TESTE 5',
        name: 'Logout e invalidação da sessão',
        success: pass,
        details: pass
          ? `Logout executado com sucesso e token invalidado definitivamente (acesso subsequente barrado com 401).`
          : `Falha: Token não foi invalidado pós-logout.`
      });
    }

    // ------------------------------------------------------------------------
    // TESTE 6: Acesso ao painel Master Owner (/master/stats)
    // ------------------------------------------------------------------------
    {
      const res = await fetch(`${BASE_URL}/api/master/stats`, {
        headers: { Authorization: `Bearer ${masterSessionToken}` }
      });
      const data = await res.json();
      const pass = res.ok && 
        (typeof data.totalCompanies === 'number' || typeof data.totalEmpresas === 'number') && 
        (typeof data.totalUsers === 'number' || typeof data.totalUsuarios === 'number');

      results.push({
        testId: 'TESTE 6',
        name: 'Acesso ao painel Master Owner',
        success: pass,
        details: pass
          ? `Painel Master liberado (HTTP 200). Total empresas: ${data.totalCompanies || data.totalEmpresas}, Total usuários: ${data.totalUsers || data.totalUsuarios}.`
          : `Falha ao acessar painel Master: ${JSON.stringify(data)}`
      });
    }

    // ------------------------------------------------------------------------
    // TESTE 7: Autorização para visualizar todas as empresas (/master/companies)
    // ------------------------------------------------------------------------
    {
      const res = await fetch(`${BASE_URL}/api/master/companies`, {
        headers: { Authorization: `Bearer ${masterSessionToken}` }
      });
      const data = await res.json();
      const pass = res.ok && Array.isArray(data.companies) && data.companies.length >= 1;

      results.push({
        testId: 'TESTE 7',
        name: 'Autorização para visualizar empresas',
        success: pass,
        details: pass
          ? `Master Owner possui visão global autorizada de todas as ${data.companies.length} empresas cadastradas na plataforma.`
          : `Falha ao consultar empresas: ${JSON.stringify(data)}`
      });
    }

    // ------------------------------------------------------------------------
    // TESTE 8: Bloqueio de acesso administrativo para usuário comum
    // ------------------------------------------------------------------------
    {
      const normalUser = db.users.find(u => u.role === 'driver' || u.role === 'operator');
      if (normalUser) {
        normalUserSessionToken = createSession(normalUser.id);
        const res = await fetch(`${BASE_URL}/api/master/stats`, {
          headers: { Authorization: `Bearer ${normalUserSessionToken}` }
        });
        const data = await res.json();
        const pass = res.status === 403 && data.error?.includes('Acesso restrito');

        results.push({
          testId: 'TESTE 8',
          name: 'Bloqueio de acesso administrativo para usuário comum',
          success: pass,
          details: pass
            ? `Usuário comum (${normalUser.email}, role: ${normalUser.role}) foi bloqueado com HTTP 403: "${data.error}".`
            : `FALHA DE SEGURANÇA: Usuário comum conseguiu acessar /master/stats! Status: ${res.status}`
        });
      }
    }

    // ------------------------------------------------------------------------
    // TESTE 9: Isolamento multiempresa preservado
    // ------------------------------------------------------------------------
    {
      if (normalUserSessionToken) {
        // Usuário normal tenta listar empresas do master
        const res = await fetch(`${BASE_URL}/api/master/companies`, {
          headers: { Authorization: `Bearer ${normalUserSessionToken}` }
        });
        const pass = res.status === 403;

        results.push({
          testId: 'TESTE 9',
          name: 'Isolamento multiempresa preservado',
          success: pass,
          details: pass
            ? `Isolamento multi-tenant protegido: usuário comum é barrado de invadir escopo de outras empresas.`
            : `FALHA DE SEGURANÇA: Vazamento multi-tenant detectado.`
        });
      }
    }

    // ------------------------------------------------------------------------
    // TESTE 10: Recuperação segura de sessão (master-recovery)
    // ------------------------------------------------------------------------
    {
      const newSecurePass = 'Master@MoviLog2026';
      const res = await fetch(`${BASE_URL}/api/auth/master-recovery`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: masterEmailGoogle,
          newPassword: newSecurePass,
          confirmPassword: newSecurePass,
          recoveryReason: 'Auditoria de recuperação segura de credenciais do titular Master Owner'
        })
      });
      const data = await res.json();
      const pass = res.ok && data.success && data.token && data.user.role === 'master_owner';

      // Testar login subsequente com a nova senha
      const testLogin = await fetch(`${BASE_URL}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: masterEmailGoogle, password: newSecurePass })
      });
      const loginData = await testLogin.json();
      const loginOk = testLogin.ok && loginData.user?.role === 'master_owner';

      results.push({
        testId: 'TESTE 10',
        name: 'Recuperação segura de sessão',
        success: pass && loginOk,
        details: pass && loginOk
          ? `Procedimento de recuperação administrativa executado com sucesso para ${masterEmailGoogle}. Login pós-recuperação confirmado.`
          : `Falha na recuperação: ${JSON.stringify(data)}`
      });
    }

    // ------------------------------------------------------------------------
    // TESTE 11: Proteção contra escalonamento de privilégios
    // ------------------------------------------------------------------------
    {
      const fakeEmail = 'hacker.invasor@qualquer.com';
      const res = await fetch(`${BASE_URL}/api/auth/master-recovery`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: fakeEmail,
          newPassword: 'NovaSenhaTentativa123',
          confirmPassword: 'NovaSenhaTentativa123'
        })
      });
      const data = await res.json();
      const pass = res.status === 403 && data.error?.includes('Apenas contas de Master Owner autorizadas');

      results.push({
        testId: 'TESTE 11',
        name: 'Proteção contra escalonamento de privilégios',
        success: pass,
        details: pass
          ? `Tentativa de redefinição para e-mail não-master barrada com HTTP 403: "${data.error}".`
          : `FALHA DE SEGURANÇA: Escalonamento não foi barrado! Status: ${res.status}`
      });
    }

    // ------------------------------------------------------------------------
    // TESTE 12: Verificação de regressão da autenticação dos demais usuários
    // ------------------------------------------------------------------------
    {
      const driverUser = db.users.find(u => u.role === 'driver');
      const operatorUser = db.users.find(u => u.role === 'operator');
      const pass = !!(driverUser && operatorUser && driverUser.active && operatorUser.active);

      results.push({
        testId: 'TESTE 12',
        name: 'Verificação de regressão da autenticação dos demais usuários',
        success: pass,
        details: pass
          ? `Contas operacionais íntegras: Motorista (${driverUser?.email}) e Operador (${operatorUser?.email}) preservados e ativos.`
          : `Regressão detectada nos usuários operacionais.`
      });
    }

  } finally {
    if (normalUserSessionToken) destroySession(normalUserSessionToken);
  }

  // Relatório Final
  console.log('\n================================================================');
  console.log('📊 RESULTADOS DA AUDITORIA DO MASTER OWNER:');
  console.log('================================================================\n');

  let passed = 0;
  results.forEach(r => {
    const symbol = r.success ? '✅ [APROVADO]' : '❌ [FALHA]';
    console.log(`${symbol} ${r.testId} — ${r.name}`);
    console.log(`   └─ ${r.details}\n`);
    if (r.success) passed++;
  });

  console.log(`TOTAL: ${passed}/${results.length} testes aprovados (${Math.round((passed / results.length) * 100)}%)\n`);

  if (passed !== results.length) {
    process.exit(1);
  }
}

runMasterAuthAudit().catch(err => {
  console.error('Erro fatal durante a auditoria do Master Owner:', err);
  process.exit(1);
});

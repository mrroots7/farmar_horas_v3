const socket = io();
let data = {};
let webhooksData = [];
let dashboardActivityData = [];  // log em tempo real da aba Dashboard
let webhooksActivityData = [];   // log em tempo real da aba Webhooks
let profilesOpen = false;
let webhooksOpen = false;
let dashOpen = true; // Dashboard é a aba inicial
let apiOpen = false;
let searchTerm = '';
const openGames = new Set(); // usernames com o painel "Jogos ativos" expandido

function showTab(name, btn) {
  document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
  btn.classList.add('active');

  document.getElementById('tab-dash').classList.toggle('hidden', name !== 'dash');
  document.getElementById('tab-profiles').classList.toggle('hidden', name !== 'profiles');
  document.getElementById('tab-webhooks').classList.toggle('hidden', name !== 'webhooks');
  document.getElementById('tab-api').classList.toggle('hidden', name !== 'api');
  document.getElementById('tab-importexport').classList.toggle('hidden', name !== 'importexport');

  dashOpen = name === 'dash';
  profilesOpen = name === 'profiles';
  webhooksOpen = name === 'webhooks';
  apiOpen = name === 'api';

  if (dashOpen) renderDashboardActivity();
  if (profilesOpen) { renderProfiles(true); loadSteamKeyInfo(); }
  if (webhooksOpen) { renderWebhooks(); renderWebhooksActivity(); loadInboundInfo(); }
  if (apiOpen) { loadApiToken(); renderApiEndpoints(); renderApiExample(); }
}

// ======================
// WEBHOOKS DE ENTRADA (link que outros apps usam pra falar com este painel)
// ======================
async function loadInboundInfo() {
  try {
    const res = await fetch('/api/inbound-info');
    const result = await res.json();
    const input = document.getElementById('inboundUrl');
    if (input && result.url) input.value = result.url;
  } catch { }
}

function copyInboundUrl() {
  const input = document.getElementById('inboundUrl');
  const msg = document.getElementById('inboundMessage');
  if (!input || !input.value) return;
  navigator.clipboard.writeText(input.value).then(() => {
    if (msg) { msg.style.color = '#8fe0b2'; msg.textContent = 'Link copiado!'; }
  }).catch(() => {
    input.select();
    document.execCommand('copy');
  });
}

async function regenInbound() {
  if (!confirm('Gerar um novo link vai invalidar o link atual. Você precisará atualizar em todos os apps que já usam ele. Continuar?')) return;
  const result = await postJSON('/api/inbound-regenerate', {});
  const input = document.getElementById('inboundUrl');
  const msg = document.getElementById('inboundMessage');
  if (result.url && input) input.value = result.url;
  if (msg) { msg.style.color = result.success ? '#8fe0b2' : '#ffb0b0'; msg.textContent = result.success ? 'Novo link gerado!' : (result.message || 'Erro ao gerar novo link.'); }
}

// Ajusta os rótulos do formulário de acordo com o tipo de webhook escolhido,
// já que Telegram/WhatsApp não usam uma "URL" de verdade nos dois campos.
function onWhTypeChange() {
  const type = document.getElementById('whType').value;
  const urlLabel = document.getElementById('whUrlLabel');
  const urlInput = document.getElementById('whUrl');
  const extraGroup = document.getElementById('whExtraGroup');
  const extraLabel = document.getElementById('whExtraLabel');
  const hint = document.getElementById('whHint');

  const config = {
    discord: { urlLabel: 'URL do Webhook', urlPh: 'https://discord.com/api/webhooks/...', extra: false, hint: 'Crie em: Configurações do canal → Integrações → Webhooks.' },
    telegram: { urlLabel: 'Token do Bot', urlPh: '123456789:AAExemploDoTokenAqui', extra: true, extraLabel: 'Chat ID', extraPh: '-1001234567890', hint: 'Crie um bot com @BotFather e pegue o Chat ID com @userinfobot.' },
    whatsapp: { urlLabel: 'Número (com DDI)', urlPh: '5511999999999', extra: true, extraLabel: 'API Key (CallMeBot)', extraPh: 'Ex: 123456', hint: 'Usa a API gratuita do CallMeBot — envie "I allow callmebot to send me messages" pro contato deles no WhatsApp para gerar sua apikey.' },
    sage: { urlLabel: 'URL do Webhook', urlPh: 'https://sage.exemplo.com/webhook/...', extra: false, hint: 'Cole a URL de webhook gerada dentro do app SAGE.' },
    custom: { urlLabel: 'URL do Endpoint', urlPh: 'https://meuservico.com/webhook', extra: false, hint: 'Qualquer endpoint que aceite POST com JSON { event, username, message, timestamp }.' }
  };

  const c = config[type] || config.custom;
  urlLabel.textContent = c.urlLabel;
  urlInput.placeholder = c.urlPh;
  extraGroup.classList.toggle('hidden', !c.extra);
  if (c.extra) {
    extraLabel.textContent = c.extraLabel;
    document.getElementById('whExtra').placeholder = c.extraPh;
  }
  hint.textContent = c.hint;
}

function fmt(s = 0) {
  const h = String(Math.floor(s / 3600)).padStart(2, '0');
  const m = String(Math.floor((s % 3600) / 60)).padStart(2, '0');
  const sec = String(s % 60).padStart(2, '0');
  return `${h}:${m}:${sec}`;
}

function fmtDate(ts) {
  if (!ts) return '-';
  return new Date(ts).toLocaleString('pt-BR');
}

function fmtDateOnly(ts) {
  if (!ts) return '-';
  return new Date(ts).toLocaleDateString('pt-BR');
}

function elapsed(startedAt) {
  if (!startedAt) return 0;
  return Math.max(0, Math.floor((Date.now() - startedAt) / 1000));
}

function badge(status) {
  if (status === 'ONLINE') return 'b-online';
  if (status === 'ERRO') return 'b-erro';
  if (status === 'AGUARDANDO_GUARD') return 'b-guard';
  if (status === 'CONECTANDO') return 'b-conectando';
  return 'b-offline';
}

function parseIds(text) {
  return String(text || '')
    .split(',')
    .map(v => Number(String(v).trim()))
    .filter(id => Number.isInteger(id) && id > 0);
}

socket.on('update_all', (payload) => {
  data = payload || {};
  renderTable();
  if (profilesOpen) renderProfiles(true);
});

socket.on('tick', (payload) => {
  data = payload || {};
  renderTable();

  Object.values(data).forEach(acc => {
    (acc.activeGames || []).forEach(g => {
      const el = document.getElementById(`game-time-${acc.username}-${g.appId}`);
      if (el) el.textContent = fmt(elapsed(g.startedAt));
    });
  });
});

socket.on('webhooks_update', (payload) => {
  webhooksData = payload || [];
  if (webhooksOpen) renderWebhooks();
});

// Log da aba Dashboard (eventos de contas: online, erro, adicionada, etc.)
socket.on('logs_init_dashboard', (payload) => {
  dashboardActivityData = payload || [];
  if (dashOpen) renderDashboardActivity();
});

socket.on('log_entry_dashboard', (entry) => {
  dashboardActivityData.unshift(entry);
  dashboardActivityData = dashboardActivityData.slice(0, 100);
  if (dashOpen) renderDashboardActivity();
});

socket.on('logs_cleared_dashboard', () => {
  dashboardActivityData = [];
  if (dashOpen) renderDashboardActivity();
});

// Log da aba Webhooks (integrações de saída + tudo que chega via inbound/SAGE)
socket.on('logs_init_webhooks', (payload) => {
  webhooksActivityData = payload || [];
  if (webhooksOpen) renderWebhooksActivity();
});

socket.on('log_entry_webhooks', (entry) => {
  webhooksActivityData.unshift(entry);
  webhooksActivityData = webhooksActivityData.slice(0, 100);
  if (webhooksOpen) renderWebhooksActivity();
});

socket.on('logs_cleared_webhooks', () => {
  webhooksActivityData = [];
  if (webhooksOpen) renderWebhooksActivity();
});

function renderTable() {
  const tbody = document.getElementById('accountsTable');
  if (!tbody) return;

  const term = searchTerm.trim().toLowerCase();

  const list = Object.values(data).filter(acc => {
    if (!term) return true;
    return String(acc.username || '').toLowerCase().includes(term);
  });

  if (!list.length) {
    tbody.innerHTML = `
      <tr>
        <td colspan="4" style="color:#97a0b5; text-align:center;">Nenhuma conta encontrada</td>
      </tr>
    `;
    return;
  }

  tbody.innerHTML = list.map(acc => {
    const qtdJogos = Array.isArray(acc.activeGames) ? acc.activeGames.length : 0;

    return `
      <tr>
        <td><strong>${acc.username}</strong></td>
        <td><span class="badge ${badge(acc.status)}">${acc.status}</span></td>
        <td>${fmtDateOnly(acc.createdAt)}</td>
        <td><strong>${qtdJogos}</strong></td>
      </tr>
    `;
  }).join('');
}

function toggleGames(username) {
  if (openGames.has(username)) openGames.delete(username);
  else openGames.add(username);
  renderProfiles(true);
}

function renderProfiles(preserve = false) {
  const box = document.getElementById('profilesContainer');
  if (!box) return;

  const drafts = {};
  if (preserve) {
    Object.keys(data).forEach(u => {
      const input = document.getElementById(`newgame-${u}`);
      if (input) drafts[u] = input.value;
    });
  }

  const list = Object.values(data);

  if (!list.length) {
    box.innerHTML = '<div class="card empty-box">Nenhuma conta cadastrada.</div>';
    return;
  }

  box.innerHTML = `
    <div class="profiles-list">
      ${list.map(acc => {
        const games = acc.activeGames || [];
        const aberto = openGames.has(acc.username);
        return `
          <article class="profile">
            <div class="profile-header">
              <div class="profile-user">
                <h3>${acc.username}</h3>
              </div>
              <span class="badge ${badge(acc.status)}">${acc.status}</span>
            </div>

            <div class="profile-stats">
              <div class="stat-box">
                <span class="stat-label">Status</span>
                <div class="stat-value">${acc.statusDetalhado || '-'}</div>
              </div>
              <div class="stat-box">
                <span class="stat-label">Perfil Steam</span>
                <div class="stat-value">
                  ${acc.profileUrl
                    ? `<a href="${acc.profileUrl}" target="_blank" rel="noopener">Abrir perfil</a>`
                    : 'Após login'}
                </div>
              </div>              <div class="stat-box">
                <span class="stat-label">Conta desde</span>
                <div class="stat-value">${fmtDateOnly(acc.createdAt)}</div>
              </div>
              <div class="stat-box">
                <span class="stat-label">Jogos configurados</span>
                <div class="stat-value">${Array.isArray(acc.games) ? acc.games.length : 0}</div>
              </div>
            </div>

            <div class="profile-section">
              <div class="section-title-row">
                <h4 class="section-title">Jogos ativos (${games.length})</h4>
                <button class="btn-sm btn-ghost" onclick="toggleGames('${acc.username}')">
                  ${aberto ? 'Ocultar' : 'Visualizar'}
                </button>
              </div>
              ${aberto ? `
                <div class="games">
                  ${games.length ? games.map(g => `
                    <div class="game">
                      <div class="game-main">
                        <div class="title">${g.name || ('App ' + g.appId)}</div>
                        <div class="sub">ID ${g.appId} · iniciado ${fmtDate(g.startedAt)}</div>
                        <div class="time" id="game-time-${acc.username}-${g.appId}">${fmt(elapsed(g.startedAt))}</div>
                      </div>
                      <div class="game-actions">
                        <button class="btn-sm btn-danger" onclick="stopGame('${acc.username}', ${g.appId})">Parar</button>
                      </div>
                    </div>
                  `).join('') : `
                    <div class="empty-box">Nenhum jogo farmando no momento</div>
                  `}
                </div>
              ` : ''}
            </div>

            <div class="profile-footer">
              <div class="add-row">
                <input id="newgame-${acc.username}" placeholder="Adicionar AppID (ex: 570)">
                <button class="btn-sm btn-ok" onclick="addGame('${acc.username}')">Add</button>
              </div>
              <div class="row-actions">
                ${acc.steamID ? `<button class="btn-sm btn-ghost" onclick="openSteamProfile('${acc.username}')">Ver perfil Steam</button>` : ''}
                ${acc.status === 'ONLINE'
                  ? `<button class="btn-sm btn-warn" onclick="stopAccount('${acc.username}')">Parar conta</button>`
                  : `<button class="btn-sm btn-ok" onclick="startAccount('${acc.username}')">Iniciar</button>`}
                <button class="btn-sm btn-danger" onclick="deleteAccount('${acc.username}')">Excluir</button>
              </div>
            </div>
          </article>
        `;
      }).join('')}
    </div>
  `;

  Object.keys(drafts).forEach(u => {
    const input = document.getElementById(`newgame-${u}`);
    if (input) input.value = drafts[u];
  });
}

const WH_LABELS = { discord: 'Discord', telegram: 'Telegram', whatsapp: 'WhatsApp', sage: 'SAGE', custom: 'Custom' };

function whSubtitle(w) {
  if (w.type === 'telegram') return `Chat ID: ${w.extra || '-'}`;
  if (w.type === 'whatsapp') return `Número: ${w.url}`;
  return w.url;
}

// Lista unificada: por padrão só mostra os webhooks ATIVOS que o admin realmente
// cadastrou (nada de seções vazias tipo "Nenhum webhook cadastrado" pra cada tipo).
function renderWebhooks() {
  const box = document.getElementById('webhooksList');
  if (!box) return;

  const showInactive = document.getElementById('showInactiveChk')?.checked;
  const list = webhooksData.filter(w => showInactive || w.active);

  if (!list.length) {
    box.innerHTML = `<div class="empty-box">${showInactive ? 'Nenhum webhook cadastrado ainda.' : 'Nenhum webhook ativo. Adicione um ao lado ou marque "Mostrar desativados".'}</div>`;
    return;
  }

  box.innerHTML = list.map(w => `
    <div class="webhook-item ${w.active ? '' : 'webhook-inactive'}">
      <div class="webhook-info">
        <div class="webhook-name-row">
          <strong>${w.name}</strong>
          <span class="type-tag">${WH_LABELS[w.type] || w.type}</span>
        </div>
        <span class="webhook-url">${whSubtitle(w)}</span>
      </div>
      <div class="webhook-actions">
        <label class="switch" title="${w.active ? 'Ativo' : 'Inativo'}">
          <input type="checkbox" ${w.active ? 'checked' : ''} onchange="toggleWebhook('${w.id}', this.checked)">
          <span class="slider"></span>
        </label>
        <button class="btn-sm btn-ghost" onclick="testWebhook('${w.id}', this)">Testar</button>
        <button class="btn-sm btn-danger" onclick="deleteWebhook('${w.id}')">Excluir</button>
      </div>
    </div>
  `).join('');
}

async function clearDashboardActivity() {
  if (!confirm('Apagar todo o log de atividade das contas? Essa ação não pode ser desfeita.')) return;
  await postJSON('/api/logs/clear', { channel: 'dashboard' });
}

async function clearActivity() {
  if (!confirm('Apagar todo o log de atividade em tempo real? Essa ação não pode ser desfeita.')) return;
  await postJSON('/api/logs/clear', { channel: 'webhooks' });
}

function renderLogEntries(box, list) {
  if (!box) return;
  if (!list.length) {
    box.innerHTML = '<div class="empty-box">Nenhuma atividade registrada ainda.</div>';
    return;
  }

  box.innerHTML = list.map(e => `
    <div class="log-entry">
      <span class="log-time">${fmtDate(e.timestamp)}</span>
      <span class="log-event">${e.evento}</span>
      ${e.username ? `<span class="log-user">${e.username}</span>` : ''}
      <span class="log-msg">${e.mensagem}</span>
    </div>
  `).join('');
}

function renderDashboardActivity() {
  renderLogEntries(document.getElementById('dashboardLog'), dashboardActivityData);
}

function renderWebhooksActivity() {
  renderLogEntries(document.getElementById('activityLog'), webhooksActivityData);
}

// Faz o POST e SEMPRE avisa o usuário se algo deu errado (resposta success:false,
// erro HTTP, ou falha de rede/servidor fora do ar). Antes essas ações falhavam
// em silêncio e parecia que o painel não fazia nada.
async function postJSON(url, body) {
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });

    let result = {};
    try { result = await res.json(); } catch { }

    if (res.status === 401) {
      window.location.href = '/login.html';
      return result;
    }

    if (!res.ok || result.success === false) {
      alert(result.message || `Erro ${res.status} ao chamar ${url}`);
    }
    return result;
  } catch (err) {
    alert('Não foi possível conectar ao servidor. Verifique se ele está rodando (node index.js).');
    return { success: false, message: err.message };
  }
}

async function addGame(username) {
  const input = document.getElementById(`newgame-${username}`);
  const ids = parseIds(input?.value);
  if (!ids.length) return alert('AppID inválido');

  const result = await postJSON('/api/add-games', { username, games: ids });
  if (result.success && input) input.value = '';
}

async function stopGame(username, appId) {
  if (!confirm(`Parar AppID ${appId}?`)) return;
  await postJSON('/api/stop-game', { username, appId });
}

async function stopAccount(username) {
  if (!confirm(`Parar ${username}?`)) return;
  await postJSON('/api/stop-account', { username });
}

async function startAccount(username) {
  await postJSON('/api/start-account', { username });
}

async function deleteAccount(username) {
  if (!confirm(`Excluir ${username}?`)) return;
  await postJSON('/api/delete-account', { username });
}

async function testWebhook(id, btn) {
  const original = btn.textContent;
  btn.disabled = true;
  btn.textContent = 'Enviando...';
  const result = await postJSON('/api/test-webhook', { id });
  btn.disabled = false;
  btn.textContent = original;
  if (result.success) alert('Teste enviado! Confira o Discord/SAGE.');
}

async function deleteWebhook(id) {
  if (!confirm('Excluir este webhook?')) return;
  await postJSON('/api/delete-webhook', { id });
}

async function toggleWebhook(id, active) {
  await postJSON('/api/toggle-webhook', { id, active });
}

async function logout() {
  try { await fetch('/api/logout', { method: 'POST' }); } catch { }
  window.location.href = '/login.html';
}

// Pede o código do Steam Guard direto no navegador quando o servidor precisa dele
// (antes só dava pra digitar no terminal, o que travava o farm se o processo
// rodasse em segundo plano / sem terminal interativo).
socket.on('steamGuard_request', ({ username, domain }) => {
  const onde = domain ? `enviado para ${domain}` : 'do app Steam Guard';
  const code = prompt(`Conta "${username}": digite o código Steam Guard ${onde}:`);
  if (code && code.trim()) {
    socket.emit('steamGuard_submit', { username, code: code.trim() });
  } else {
    alert(`Login de "${username}" cancelado: nenhum código informado.`);
  }
});

document.getElementById('searchUser')?.addEventListener('input', (e) => {
  searchTerm = e.target.value || '';
  renderTable();
});

document.getElementById('addForm').addEventListener('submit', async (e) => {
  e.preventDefault();

  const username = document.getElementById('username').value.trim();
  const password = document.getElementById('password').value;
  const gamesRaw = document.getElementById('games').value.trim();
  const games = parseIds(gamesRaw || '730');
  const msg = document.getElementById('message');

  if (gamesRaw && !games.length) {
    msg.style.color = '#ffb0b0';
    msg.textContent = 'AppIDs inválidos. Use números separados por vírgula, ex: 730, 570';
    return;
  }

  let result;
  try {
    const res = await fetch('/api/add-account', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password, games })
    });
    result = await res.json();
  } catch (err) {
    msg.style.color = '#ffb0b0';
    msg.textContent = 'Não foi possível conectar ao servidor.';
    return;
  }

  msg.style.color = result.success ? '#8fe0b2' : '#ffb0b0';
  msg.textContent = result.message || '';
  if (result.success) e.target.reset();
});

document.getElementById('webhookForm').addEventListener('submit', async (e) => {
  e.preventDefault();

  const name = document.getElementById('whName').value.trim();
  const type = document.getElementById('whType').value;
  const url = document.getElementById('whUrl').value.trim();
  const extra = document.getElementById('whExtra').value.trim();
  const msg = document.getElementById('webhookMessage');

  const result = await postJSON('/api/add-webhook', { name, type, url, extra });

  msg.style.color = result.success ? '#8fe0b2' : '#ffb0b0';
  msg.textContent = result.message || '';
  if (result.success) { e.target.reset(); onWhTypeChange(); }
});

onWhTypeChange();

// ======================
// STEAM WEB API KEY (necessária pra "Ver perfil Steam")
// ======================
async function loadSteamKeyInfo() {
  try {
    const res = await fetch('/api/steam-key');
    const result = await res.json();
    const input = document.getElementById('steamKeyInput');
    if (input && result.configured) input.placeholder = `Configurada (${result.hint})`;
  } catch { }
}

async function saveSteamKey() {
  const input = document.getElementById('steamKeyInput');
  const msg = document.getElementById('steamKeyMessage');
  const key = input?.value.trim();
  if (!key) return;

  const result = await postJSON('/api/steam-key', { key });
  if (msg) {
    msg.style.color = result.success ? '#8fe0b2' : '#ffb0b0';
    msg.textContent = result.message || '';
  }
  if (result.success && input) { input.value = ''; loadSteamKeyInfo(); }
}

// ======================
// PÁGINA DE PERFIL ESTILO STEAM (modal)
// ======================
const PERSONA_CLASS = {
  'Online': 'steam-status-online',
  'Ocupado': 'steam-status-online',
  'Querendo jogar': 'steam-status-online',
  'Querendo trocar': 'steam-status-online',
  'Ausente': 'steam-status-away',
  'Inativo': 'steam-status-away'
};

async function openSteamProfile(username) {
  const overlay = document.getElementById('steamModalOverlay');
  const body = document.getElementById('steamModalBody');
  overlay.classList.remove('hidden');
  body.innerHTML = '<div class="empty-box">Carregando perfil...</div>';

  try {
    const res = await fetch(`/api/steam-profile/${encodeURIComponent(username)}`);
    const result = await res.json();

    if (!result.success) {
      body.innerHTML = `<div class="empty-box">${result.message || 'Não foi possível carregar o perfil.'}</div>`;
      return;
    }

    const p = result.profile;
    const statusClass = PERSONA_CLASS[p.personastate] || 'steam-status-offline';

    body.innerHTML = `
      <div class="steam-profile">
        <div class="steam-profile-header">
          <img class="steam-avatar" src="${p.avatar || ''}" alt="avatar" onerror="this.style.visibility='hidden'">
          <div class="steam-profile-main">
            <div class="steam-persona">${p.personaname || username}</div>
            ${p.realname ? `<div class="steam-realname">${p.realname}</div>` : ''}
            <div class="steam-status ${statusClass}">
              ${p.jogoAtual ? `Jogando agora: ${p.jogoAtual}` : p.personastate}
            </div>
          </div>
          ${p.level !== null ? `<div class="steam-level">${p.level}</div>` : ''}
        </div>

        <div class="steam-profile-grid">
          <div class="steam-stat">
            <span class="stat-label">Membro desde</span>
            <div class="stat-value">${p.criadaEm ? fmtDate(p.criadaEm) : '-'}</div>
          </div>
          <div class="steam-stat">
            <span class="stat-label">País</span>
            <div class="stat-value">${p.pais || '-'}</div>
          </div>
          <div class="steam-stat">
            <span class="stat-label">Jogos na conta</span>
            <div class="stat-value">${p.totalJogos ?? '-'}</div>
          </div>
          <div class="steam-stat">
            <span class="stat-label">Perfil</span>
            <div class="stat-value"><a href="${p.profileurl}" target="_blank" rel="noopener">Abrir na Steam</a></div>
          </div>
        </div>
      </div>
    `;
  } catch (err) {
    body.innerHTML = `<div class="empty-box">Erro ao carregar perfil: ${err.message}</div>`;
  }
}

function closeSteamProfile() {
  document.getElementById('steamModalOverlay').classList.add('hidden');
}

// ======================
// IMPORTAR / EXPORTAR CONFIGURAÇÕES
// ======================
async function exportConfig() {
  try {
    const res = await fetch('/api/export');
    const data = await res.json();
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'farmar-horas-backup.json';
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  } catch (err) {
    alert('Não foi possível exportar: ' + err.message);
  }
}

// ======================
// ABA API — token público + documentação + exemplos de código
// ======================
let apiToken = '';
let apiEditing = false;

async function loadApiToken() {
  try {
    const res = await fetch('/api/api-token');
    const result = await res.json();
    if (result.success) {
      apiToken = result.token;
      const input = document.getElementById('apiTokenInput');
      if (input) input.value = apiToken;
      renderApiExample();
      renderApiEndpoints();
    }
  } catch { }
}

function copyApiToken() {
  const input = document.getElementById('apiTokenInput');
  const msg = document.getElementById('apiTokenMessage');
  if (!input || !input.value) return;
  navigator.clipboard.writeText(input.value).then(() => {
    if (msg) { msg.style.color = '#8fe0b2'; msg.textContent = 'Token copiado!'; }
  }).catch(() => {
    input.select();
    document.execCommand('copy');
  });
}

async function regenApiToken() {
  if (!confirm('Gerar um novo token vai invalidar o token atual. Você precisará atualizar em todos os bots/sites que já usam ele. Continuar?')) return;
  const result = await postJSON('/api/api-token/regenerate', {});
  const msg = document.getElementById('apiTokenMessage');
  if (result.success) {
    apiToken = result.token;
    const input = document.getElementById('apiTokenInput');
    if (input) input.value = apiToken;
    renderApiExample();
    renderApiEndpoints();
  }
  if (msg) {
    msg.style.color = result.success ? '#8fe0b2' : '#ffb0b0';
    msg.textContent = result.success ? 'Novo token gerado!' : (result.message || 'Erro ao gerar novo token.');
  }
}

function renderApiEndpoints() {
  const box = document.getElementById('apiEndpointsList');
  if (!box) return;
  const token = apiToken || 'SEU_TOKEN';

  const endpoints = [
    { method: 'GET', path: `/api/public/accounts?token=${token}`, desc: 'Lista todas as contas salvas com o status atual (sem expor senha).' },
    { method: 'GET', path: `/api/public/logs?token=${token}`, desc: 'Retorna os logs de atividade (Dashboard e Webhooks separados).' },
    { method: 'GET', path: `/api/public/inbound-events?token=${token}`, desc: 'Retorna o histórico bruto de tudo que chegou pelo link de entrada (SAGE/etc).' },
    { method: 'GET', path: `/api/public/data?token=${token}`, desc: 'Retorna tudo (contas + logs) em uma única resposta — ideal pra bots.' }
  ];

  box.innerHTML = endpoints.map(e => `
    <div class="api-endpoint">
      <div class="api-endpoint-head">
        <span class="api-method">${e.method}</span>
        <code class="api-path">${e.path}</code>
      </div>
      <p class="api-endpoint-desc">${e.desc}</p>
    </div>
  `).join('');
}

// Gera o código de exemplo pra cada linguagem, sempre com a URL e o token reais do painel.
function apiExampleCode(lang) {
  const origin = window.location.origin;
  const token = apiToken || 'SEU_TOKEN_AQUI';
  const url = `${origin}/api/public/data?token=${token}`;

  const examples = {
    node: `// Node.js 18+ (usa o fetch nativo, sem precisar instalar nada)
async function getDadosDoPainel() {
  const res = await fetch('${url}');
  const dados = await res.json();
  console.log(dados.accounts);
  return dados;
}

getDadosDoPainel();`,

    fetch: `// JavaScript no navegador (ou em qualquer app que já use fetch)
fetch('${url}')
  .then(res => res.json())
  .then(dados => {
    console.log(dados.accounts);
  });`,

    python: `import requests

resp = requests.get(
    '${origin}/api/public/data',
    params={'token': '${token}'}
)
dados = resp.json()
print(dados['accounts'])`,

    curl: `curl "${url}"`
  };

  return examples[lang] || examples.node;
}

// Highlight simples (sem dependências externas): colore comentários, strings
// e palavras-chave via regex, uma linguagem por vez.
function highlightCode(code, lang) {
  let escaped = code
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

  const rules = {
    node: [
      [/(\/\/.*$)/gm, 'tok-comment'],
      [/(`[^`]*`|'[^']*'|"[^"]*")/g, 'tok-string'],
      [/\b(async|function|await|const|let|return|console|log|new)\b/g, 'tok-keyword']
    ],
    fetch: [
      [/(\/\/.*$)/gm, 'tok-comment'],
      [/(`[^`]*`|'[^']*'|"[^"]*")/g, 'tok-string'],
      [/\b(function|return|then|const|let)\b/g, 'tok-keyword']
    ],
    python: [
      [/(#.*$)/gm, 'tok-comment'],
      [/('[^']*'|"[^"]*")/g, 'tok-string'],
      [/\b(import|def|return|print)\b/g, 'tok-keyword']
    ],
    curl: [
      [/("[^"]*")/g, 'tok-string'],
      [/\b(curl)\b/g, 'tok-keyword']
    ]
  };

  (rules[lang] || rules.node).forEach(([regex, cls]) => {
    escaped = escaped.replace(regex, m => `<span class="${cls}">${m}</span>`);
  });

  return escaped;
}

const API_LANG_LABELS = { node: 'Node.js', fetch: 'JavaScript (fetch)', python: 'Python', curl: 'cURL' };

function renderApiExample() {
  const lang = document.getElementById('apiLangSelect')?.value || 'node';
  const code = apiExampleCode(lang);

  const highlightEl = document.getElementById('apiCodeHighlight');
  const editEl = document.getElementById('apiCodeEdit');
  const langTag = document.getElementById('apiCodeLangTag');

  if (highlightEl) highlightEl.innerHTML = highlightCode(code, lang);
  if (editEl) editEl.value = code;
  if (langTag) langTag.textContent = API_LANG_LABELS[lang] || 'Node.js';
}

function toggleApiEdit() {
  apiEditing = !apiEditing;
  document.getElementById('apiCodeView')?.classList.toggle('hidden', apiEditing);
  document.getElementById('apiCodeEdit')?.classList.toggle('hidden', !apiEditing);
  const btn = document.getElementById('apiEditBtn');
  if (btn) btn.textContent = apiEditing ? 'Visualizar' : 'Editar';
  if (apiEditing) document.getElementById('apiCodeEdit')?.focus();
}

function copyApiExample() {
  const text = apiEditing
    ? (document.getElementById('apiCodeEdit')?.value || '')
    : apiExampleCode(document.getElementById('apiLangSelect')?.value || 'node');

  navigator.clipboard.writeText(text).then(() => {
    alert('Código copiado!');
  }).catch(() => {
    alert('Não foi possível copiar automaticamente. Selecione o texto manualmente.');
  });
}

async function importConfig() {
  const fileInput = document.getElementById('importFile');
  const msg = document.getElementById('importMessage');
  const file = fileInput?.files?.[0];
  if (!file) { alert('Selecione um arquivo .json primeiro.'); return; }

  try {
    const text = await file.text();
    const parsed = JSON.parse(text);
    const result = await postJSON('/api/import', parsed);

    if (msg) {
      msg.style.color = result.success ? '#8fe0b2' : '#ffb0b0';
      msg.textContent = result.message || '';
    }
    if (result.success) fileInput.value = '';
  } catch (err) {
    if (msg) { msg.style.color = '#ffb0b0'; msg.textContent = 'Arquivo inválido: ' + err.message; }
  }
}

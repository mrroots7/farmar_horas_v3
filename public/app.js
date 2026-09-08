const socket = io();
let data = {};
let webhooksData = [];
let dashboardActivityData = [];  // log em tempo real da aba Dashboard
let webhooksActivityData = [];   // log em tempo real da aba Webhooks
let profilesOpen = false;
let bansOpen = false;
let webhooksOpen = false;
let dashOpen = true; // Dashboard é a aba inicial
let apiOpen = false;
let usersOpen = false;
let me = null; // { user: {username, role, plan, planName}, limits: {...} }
let usersList = [];
let searchTerm = '';
const openGames = new Set(); // usernames com o painel "Jogos ativos" expandido

function showTab(name, btn) {
  document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
  btn.classList.add('active');

  document.getElementById('tab-dash').classList.toggle('hidden', name !== 'dash');
  document.getElementById('tab-profiles').classList.toggle('hidden', name !== 'profiles');
  document.getElementById('tab-bans').classList.toggle('hidden', name !== 'bans');
  document.getElementById('tab-webhooks').classList.toggle('hidden', name !== 'webhooks');
  document.getElementById('tab-api').classList.toggle('hidden', name !== 'api');
  document.getElementById('tab-importexport').classList.toggle('hidden', name !== 'importexport');
  document.getElementById('tab-users').classList.toggle('hidden', name !== 'users');

  dashOpen = name === 'dash';
  profilesOpen = name === 'profiles';
  bansOpen = name === 'bans';
  webhooksOpen = name === 'webhooks';
  apiOpen = name === 'api';
  usersOpen = name === 'users';

  if (dashOpen) { renderDashboardActivity(); loadMe(); }
  if (profilesOpen) { renderProfiles(true); if (me?.user?.role === 'admin') loadSteamKeyInfo(); }
  if (bansOpen) { renderBansTable(); loadFaceitKeyInfo(); }
  if (webhooksOpen) { renderWebhooks(); renderWebhooksActivity(); loadInboundInfo(); }
  if (apiOpen) { loadApiToken(); renderApiEndpoints(); renderApiExample(); }
  if (usersOpen) loadUsers();
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
  checkGuardOutcome();
});

socket.on('tick', (payload) => {
  data = payload || {};
  renderTable();
  checkGuardOutcome();

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
                ${acc.steamID || acc.hasSteamGuard ? `<button class="btn-sm btn-ghost" onclick="openSteamProfile('${acc.username}')">Ver perfil Steam</button>` : ''}
                ${acc.hasSteamGuard ? `<button class="btn-sm btn-ok" onclick="gerarCodigoGuard('${acc.username}')">Código Guard</button>` : ''}
                <button class="btn-sm btn-ghost" onclick="verDetalhesConta('${acc.username}')">Detalhes</button>
                ${acc.status === 'ONLINE'
                  ? `<button class="btn-sm btn-warn" onclick="stopAccount('${acc.username}')">Parar conta</button>`
                  : `<button class="btn-sm btn-ok" onclick="startAccount('${acc.username}')">Iniciar</button>`}
                <button class="btn-sm btn-danger" onclick="deleteAccount('${acc.username}')">Excluir</button>
              </div>
              <div id="guard-code-${acc.username}" class="guard-code-box hidden"></div>
              <div id="account-details-${acc.username}" class="account-details-box hidden"></div>
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

  box.innerHTML = list.map(e => {
    let msgHtml = '';
    const raw = e.mensagem == null ? '' : String(e.mensagem);

    // Se a mensagem for um JSON, mostra formatado e organizado (um campo abaixo do outro)
    try {
      const trimmed = raw.trim();
      if ((trimmed.startsWith('{') && trimmed.endsWith('}')) || (trimmed.startsWith('[') && trimmed.endsWith(']'))) {
        const parsed = JSON.parse(trimmed);
        msgHtml = `<pre class="log-json">${escapeHtml(JSON.stringify(parsed, null, 2))}</pre>`;
      } else {
        msgHtml = `<span class="log-msg">${escapeHtml(raw)}</span>`;
      }
    } catch {
      msgHtml = `<span class="log-msg">${escapeHtml(raw)}</span>`;
    }

    return `
      <div class="log-entry">
        <span class="log-time">${fmtDate(e.timestamp)}</span>
        <span class="log-event">${escapeHtml(e.evento || '')}</span>
        ${e.username ? `<span class="log-user">${escapeHtml(e.username)}</span>` : ''}
        ${msgHtml}
      </div>
    `;
  }).join('');
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
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

async function gerarCodigoGuard(username) {
  const box = document.getElementById(`guard-code-${username}`);
  if (!box) return;

  box.classList.remove('hidden');
  box.innerHTML = '<span class="hint">Gerando código...</span>';

  const result = await postJSON('/api/steam-guard-code', { username });
  if (!result.success) {
    box.innerHTML = `<span class="hint" style="color:#ff6b6b">${result.message || 'Erro ao gerar código'}</span>`;
    return;
  }

  box.innerHTML = `
    <div class="guard-code-display">
      <span class="guard-code-label">Steam Guard</span>
      <span class="guard-code-value" id="guard-val-${username}">${result.code}</span>
      <span class="guard-code-timer">expira em <b id="guard-timer-${username}">${result.secondsRemaining}s</b></span>
      <button class="btn-sm btn-ghost" onclick="navigator.clipboard.writeText('${result.code}')">Copiar</button>
    </div>
  `;

  // Countdown visual
  let remaining = result.secondsRemaining;
  const timerEl = document.getElementById(`guard-timer-${username}`);
  const interval = setInterval(() => {
    remaining -= 1;
    if (timerEl) timerEl.textContent = remaining + 's';
    if (remaining <= 0) {
      clearInterval(interval);
      // Auto-renova o código
      gerarCodigoGuard(username);
    }
  }, 1000);
}

async function verDetalhesConta(username) {
  const box = document.getElementById(`account-details-${username}`);
  if (!box) return;

  // Toggle: se já está aberto, fecha
  if (!box.classList.contains('hidden') && box.innerHTML.trim()) {
    box.classList.add('hidden');
    box.innerHTML = '';
    return;
  }

  box.classList.remove('hidden');
  box.innerHTML = '<span class="hint">Carregando...</span>';

  const result = await postJSON('/api/account-details', { username });
  if (!result.success) {
    box.innerHTML = `<span class="hint" style="color:#ff6b6b">${result.message || 'Erro'}</span>`;
    return;
  }

  const a = result.account;
  box.innerHTML = `
    <pre class="log-json">${escapeHtml(JSON.stringify({
      username: a.username,
      password: a.password,
      email: a.email,
      emailPassword: a.emailPassword,
      vaultEmail: a.vaultEmail,
      vaultPassword: a.vaultPassword,
      steamId: a.steamId,
      games: a.games,
      hasSteamGuard: a.hasSteamGuard,
      revocationCode: a.revocationCode,
      origem: a.origem,
      createdAt: a.createdAt ? new Date(a.createdAt).toLocaleString('pt-BR') : null
    }, null, 2))}</pre>
  `;
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

document.getElementById('searchUser')?.addEventListener('input', (e) => {
  searchTerm = e.target.value || '';
  renderTable();
});

// ======================
// BUSCAR JOGO PELO NOME (com foto pra confirmar) — usado no form "Nova conta"
// ======================
let selectedGames = [{ appId: 730, name: 'AppID 730 (padrão: Counter-Strike 2)', image: null }];
let gameSearchDebounce = null;

function syncGamesHiddenInput() {
  document.getElementById('games').value = selectedGames.map(g => g.appId).join(',');
}

function renderSelectedGames() {
  const box = document.getElementById('selectedGames');
  if (!box) return;
  box.innerHTML = selectedGames.map(g => `
    <span class="game-chip">
      ${g.image ? `<img src="${g.image}" alt="">` : ''}
      ${escapeHtml(g.name || `AppID ${g.appId}`)}
      <button type="button" onclick="removeSelectedGame(${g.appId})" title="Remover">&times;</button>
    </span>
  `).join('');
  syncGamesHiddenInput();
}

function removeSelectedGame(appId) {
  selectedGames = selectedGames.filter(g => g.appId !== appId);
  renderSelectedGames();
}

function addSelectedGame(game) {
  if (selectedGames.some(g => g.appId === game.appId)) return;
  selectedGames.push(game);
  renderSelectedGames();
  document.getElementById('gameSearchResults').classList.add('hidden');
  document.getElementById('gameSearchInput').value = '';
}

function addManualAppId() {
  const input = document.getElementById('manualAppId');
  const appId = Number(String(input?.value || '').trim());
  if (!Number.isInteger(appId) || appId <= 0) return alert('AppID inválido.');
  addSelectedGame({ appId, name: `AppID ${appId}`, image: null });
  if (input) input.value = '';
}

function renderGameSearchResults(items) {
  const box = document.getElementById('gameSearchResults');
  if (!items.length) {
    box.innerHTML = '<div class="game-search-empty">Nenhum jogo encontrado com esse nome.</div>';
  } else {
    box.innerHTML = items.map(it => `
      <div class="game-search-item" onclick='addSelectedGame(${JSON.stringify(it).replace(/'/g, "&#39;")})'>
        ${it.image ? `<img src="${it.image}" alt="">` : '<div style="width:62px;height:29px;background:#222;border-radius:4px;flex-shrink:0;"></div>'}
        <div>
          <div class="gsi-name">${escapeHtml(it.name)}</div>
          <div class="gsi-appid">AppID ${it.appId}</div>
        </div>
      </div>
    `).join('');
  }
  box.classList.remove('hidden');
}

function escapeHtml(str) {
  return String(str || '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

document.getElementById('gameSearchInput')?.addEventListener('input', (e) => {
  const term = e.target.value.trim();
  clearTimeout(gameSearchDebounce);
  const spinner = document.getElementById('gameSearchSpinner');
  const box = document.getElementById('gameSearchResults');

  if (term.length < 2) {
    box.classList.add('hidden');
    spinner.classList.add('hidden');
    return;
  }

  spinner.classList.remove('hidden');
  gameSearchDebounce = setTimeout(async () => {
    try {
      const res = await fetch(`/api/steam/search-game?q=${encodeURIComponent(term)}`);
      const result = await res.json();
      renderGameSearchResults(result.items || []);
    } catch {
      renderGameSearchResults([]);
    } finally {
      spinner.classList.add('hidden');
    }
  }, 400);
});

document.addEventListener('click', (e) => {
  const box = document.getElementById('gameSearchResults');
  const input = document.getElementById('gameSearchInput');
  if (box && !box.contains(e.target) && e.target !== input) box.classList.add('hidden');
});

renderSelectedGames();

// ======================
// STEAM GUARD — caixa com spinner (igual ao login), substitui o prompt() nativo
// ======================
let guardCurrentUsername = null;

function closeGuardModal() {
  document.getElementById('guardModalOverlay').classList.add('hidden');
  guardCurrentUsername = null;
}

socket.on('steamGuard_request', ({ username, domain }) => {
  guardCurrentUsername = username;
  const onde = domain ? `Enviado para ${domain}` : 'Peça no seu app Steam Guard (celular)';
  document.getElementById('guardModalSub').textContent = `Conta "${username}" — ${onde}`;
  document.getElementById('guardCodeInput').value = '';
  document.getElementById('guardMessage').textContent = '';
  document.getElementById('guardForm').classList.remove('hidden');
  document.getElementById('guardWaiting').classList.add('hidden');
  document.getElementById('guardSubmitBtn').disabled = false;
  document.getElementById('guardModalOverlay').classList.remove('hidden');
  document.getElementById('guardCodeInput').focus();
});

document.getElementById('guardForm')?.addEventListener('submit', (e) => {
  e.preventDefault();
  const code = document.getElementById('guardCodeInput').value.trim();
  if (!code || !guardCurrentUsername) return;

  socket.emit('steamGuard_submit', { username: guardCurrentUsername, code });
  document.getElementById('guardForm').classList.add('hidden');
  document.getElementById('guardWaiting').classList.remove('hidden');
});

// Observa o status da conta (via update_all/tick) enquanto o modal de Steam Guard
// está esperando confirmação, pra saber se deu certo, código errado, ou expirou.
function checkGuardOutcome() {
  if (!guardCurrentUsername) return;
  const waiting = !document.getElementById('guardWaiting').classList.contains('hidden');
  if (!waiting) return;

  const acc = data[guardCurrentUsername];
  if (!acc) return;

  if (acc.status === 'ONLINE') {
    const msg = document.getElementById('guardMessage');
    msg.style.color = '#8fe0b2';
    msg.textContent = 'Código confirmado! Conta online.';
    setTimeout(closeGuardModal, 1400);
  } else if (acc.status === 'ERRO') {
    document.getElementById('guardWaiting').classList.add('hidden');
    const msg = document.getElementById('guardMessage');
    msg.style.color = '#ffb0b0';
    msg.textContent = acc.statusDetalhado || 'Falha ao confirmar o código.';
    // deixa o modal aberto com a mensagem; o usuário fecha e tenta iniciar de novo
  }
}

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
  if (result.success) {
    e.target.reset();
    selectedGames = [{ appId: 730, name: 'AppID 730 (padrão: Counter-Strike 2)', image: null }];
    renderSelectedGames();
  }
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
// ABA "BANS" (VAC/Game Ban + Faceit) — só admin
// ======================
async function loadFaceitKeyInfo() {
  try {
    const res = await fetch('/api/faceit-key');
    const result = await res.json();
    const input = document.getElementById('faceitKeyInput');
    if (input && result.configured) input.placeholder = `Configurada (${result.hint})`;
  } catch { }
}

async function saveFaceitKey() {
  const input = document.getElementById('faceitKeyInput');
  const msg = document.getElementById('faceitKeyMessage');
  const key = input?.value.trim();
  if (!key) return;

  const result = await postJSON('/api/faceit-key', { key });
  if (msg) {
    msg.style.color = result.success ? '#8fe0b2' : '#ffb0b0';
    msg.textContent = result.message || '';
  }
  if (result.success && input) { input.value = ''; loadFaceitKeyInfo(); }
}

function renderBansTable() {
  const tbody = document.getElementById('bansTable');
  if (!tbody) return;

  const list = Object.values(data);
  if (!list.length) {
    tbody.innerHTML = '<tr><td colspan="4">Nenhuma conta cadastrada.</td></tr>';
    return;
  }

  tbody.innerHTML = list.map(acc => {
    const temCS2 = Array.isArray(acc.games) && acc.games.includes(730);
    return `
      <tr>
        <td>${acc.username}</td>
        <td>${acc.steamID || '<span class="hint">sem login ainda</span>'}</td>
        <td>${temCS2 ? '<span class="badge b-online">Sim</span>' : '<span class="hint">Não</span>'}</td>
        <td>
          ${acc.steamID
            ? `<button class="btn-sm btn-ghost" onclick="openBans('${acc.username}')">Consultar</button>`
            : '<span class="hint">Aguardando login</span>'}
        </td>
      </tr>
    `;
  }).join('');
}

async function openBans(username) {
  const overlay = document.getElementById('steamModalOverlay');
  const body = document.getElementById('steamModalBody');
  overlay.classList.remove('hidden');
  body.innerHTML = '<div class="empty-box">Consultando bans...</div>';

  try {
    const res = await fetch(`/api/steam-bans/${encodeURIComponent(username)}`);
    const result = await res.json();

    if (!result.success) {
      body.innerHTML = `<div class="empty-box">${result.message || 'Não foi possível consultar.'}</div>`;
      return;
    }

    const b = result.bans;
    const f = result.faceit;

    const banRow = (label, ruim, textoRuim, textoOk) => `
      <div class="steam-stat">
        <span class="stat-label">${label}</span>
        <div class="stat-value">
          <span class="badge ${ruim ? 'b-erro' : 'b-online'}">${ruim ? textoRuim : textoOk}</span>
        </div>
      </div>
    `;

    let faceitHtml = '';
    if (result.temCS2) {
      if (f && f.temFaceit) {
        faceitHtml = `
          <div class="steam-stat">
            <span class="stat-label">Faceit</span>
            <div class="stat-value">
              <a href="${f.faceitUrl || '#'}" target="_blank" rel="noopener">${f.nickname || 'perfil'}</a>
              ${f.nivel !== null ? ` · Nível ${f.nivel}` : ''}${f.elo !== null ? ` · ${f.elo} elo` : ''}
            </div>
          </div>
        `;
      } else if (f && !f.temFaceit) {
        faceitHtml = `
          <div class="steam-stat">
            <span class="stat-label">Faceit</span>
            <div class="stat-value"><span class="badge b-erro">Sem conta vinculada</span></div>
          </div>
        `;
      } else {
        faceitHtml = `
          <div class="steam-stat">
            <span class="stat-label">Faceit</span>
            <div class="stat-value hint">${result.faceitMessage || 'Não verificado.'}</div>
          </div>
        `;
      }
    }

    body.innerHTML = `
      <div class="steam-profile">
        <div class="steam-profile-header">
          <div class="steam-profile-main">
            <div class="steam-persona">${username}</div>
            <div class="hint">SteamID: ${result.steamID}</div>
          </div>
        </div>

        <div class="steam-profile-grid">
          ${banRow('VAC Ban', b.vacBanned, `Sim (${b.numeroVacBans})`, 'Não')}
          ${banRow('Game Ban', b.numeroGameBans > 0, `${b.numeroGameBans} ban(s)`, 'Nenhum')}
          ${banRow('Community Ban', b.communityBanned, 'Sim', 'Não')}
          ${banRow('Economy Ban', !!b.economyBan, b.economyBan || '-', 'Nenhum')}
          ${b.diasDesdeUltimoBan !== null && (b.vacBanned || b.numeroGameBans > 0)
            ? `<div class="steam-stat"><span class="stat-label">Dias desde o último ban</span><div class="stat-value">${b.diasDesdeUltimoBan}</div></div>`
            : ''}
          ${faceitHtml}
        </div>

        <p class="hint" style="margin-top:12px">
          A Steam não libera publicamente dado de "GC ban"/trust factor do CS2 pra terceiros — só o que aparece acima.
        </p>
      </div>
    `;
  } catch (err) {
    body.innerHTML = `<div class="empty-box">Erro ao consultar: ${err.message}</div>`;
  }
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

// ======================
// MULTIUSUÁRIO — badge no topo, limites do plano e aba de administração
// ======================
async function loadMe() {
  try {
    const res = await fetch('/api/me');
    if (res.status === 401) { window.location.href = '/login.html'; return; }
    const result = await res.json();
    if (!result.success) return;
    me = result;
    applyMeToUI();
  } catch { }
}

function applyMeToUI() {
  if (!me) return;
  const { user, limits } = me;
  const isAdmin = user.role === 'admin';

  const badge = document.getElementById('userBadge');
  if (badge) {
    badge.innerHTML = `<span class="dot"></span> ${escapeHtml(user.username)} · ${isAdmin ? 'Admin' : user.planName}`;
  }

  // Abas/telas que são só do painel inteiro (admin)
  ['tabBtn-webhooks', 'tabBtn-api', 'tabBtn-importexport', 'tabBtn-bans'].forEach(id => {
    document.getElementById(id)?.classList.toggle('hidden', !isAdmin);
  });
  document.getElementById('tabBtn-users')?.classList.toggle('hidden', !isAdmin);
  document.getElementById('steamKeyCard')?.classList.toggle('hidden', !isAdmin);

  const usage = document.getElementById('planUsageInfo');
  if (usage) {
    usage.textContent = isAdmin
      ? 'Você é admin: sem limite de contas ou jogos.'
      : `Plano ${user.planName}: ${limits.contasUsadas}/${limits.maxAccounts} conta(s) usadas · até ${limits.maxGames} jogo(s) por conta.`;
  }

  const sub = document.getElementById('accountModalSub');
  if (sub) sub.textContent = `${user.username} · ${isAdmin ? 'Admin' : user.planName}`;

  ensureAllowedTab();
}

// Se por acaso a aba ativa era uma exclusiva de admin e o usuário deixou de ser
// admin (ou nunca foi), volta pro Dashboard pra não deixar o painel "preso".
function ensureAllowedTab() {
  if (me?.user?.role === 'admin') return;
  if (webhooksOpen || apiOpen || usersOpen || bansOpen) {
    const dashBtn = document.querySelector('.tabs .tab');
    if (dashBtn) showTab('dash', dashBtn);
  }
}

// ------ Modal "Minha conta" (trocar a própria senha) ------
function openAccountModal() {
  document.getElementById('accountNewPassword').value = '';
  document.getElementById('accountModalMessage').textContent = '';
  document.getElementById('accountModalOverlay').classList.remove('hidden');
}

function closeAccountModal() {
  document.getElementById('accountModalOverlay').classList.add('hidden');
}

document.getElementById('accountPasswordForm')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const password = document.getElementById('accountNewPassword').value;
  const msg = document.getElementById('accountModalMessage');
  const result = await postJSON('/api/users/password', { password });
  if (msg) {
    msg.style.color = result.success ? '#8fe0b2' : '#ffb0b0';
    msg.textContent = result.message || '';
  }
  if (result.success) document.getElementById('accountNewPassword').value = '';
});

// ------ Aba "Usuários" (só admin — o backend também bloqueia por segurança) ------
async function loadUsers() {
  try {
    const res = await fetch('/api/users');
    const result = await res.json();
    if (!result.success) return;
    usersList = result.users || [];
    renderUsers();
  } catch { }
}

function renderUsers() {
  const tbody = document.getElementById('usersTable');
  if (!tbody) return;

  if (!usersList.length) {
    tbody.innerHTML = `<tr><td colspan="5" style="color:#97a0b5; text-align:center;">Nenhum usuário cadastrado</td></tr>`;
    return;
  }

  tbody.innerHTML = usersList.map(u => `
    <tr>
      <td><strong>${escapeHtml(u.username)}</strong></td>
      <td>${u.role === 'admin' ? 'Admin' : 'Usuário'}</td>
      <td>
        <select id="plan-${escapeHtml(u.username)}" ${u.role === 'admin' ? 'disabled' : ''}>
          <option value="bronze" ${u.plan === 'bronze' ? 'selected' : ''}>Bronze</option>
          <option value="prata" ${u.plan === 'prata' ? 'selected' : ''}>Prata</option>
          <option value="ouro" ${u.plan === 'ouro' ? 'selected' : ''}>Ouro</option>
        </select>
        <button class="btn-sm btn-ghost" onclick="changeUserPlan('${escapeHtml(u.username)}')" ${u.role === 'admin' ? 'disabled' : ''}>Salvar</button>
      </td>
      <td>${fmtDateOnly(u.createdAt)}</td>
      <td class="users-actions">
        <input type="password" id="pwd-${escapeHtml(u.username)}" placeholder="Nova senha" class="pwd-input">
        <button class="btn-sm btn-ghost" onclick="resetUserPassword('${escapeHtml(u.username)}')">Definir senha</button>
        <button class="btn-sm btn-danger" onclick="deleteUser('${escapeHtml(u.username)}')">Excluir</button>
      </td>
    </tr>
  `).join('');
}

document.getElementById('userForm')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const username = document.getElementById('newUserUsername').value.trim();
  const password = document.getElementById('newUserPassword').value;
  const role = document.getElementById('newUserRole').value;
  const plan = document.getElementById('newUserPlan').value;
  const msg = document.getElementById('userMessage');

  const result = await postJSON('/api/users', { username, password, role, plan });
  if (msg) {
    msg.style.color = result.success ? '#8fe0b2' : '#ffb0b0';
    msg.textContent = result.message || '';
  }
  if (result.success) {
    document.getElementById('userForm').reset();
    loadUsers();
  }
});

async function changeUserPlan(username) {
  const select = document.getElementById(`plan-${username}`);
  if (!select) return;
  const result = await postJSON('/api/users/plan', { username, plan: select.value });
  if (result.success) loadUsers();
}

async function resetUserPassword(username) {
  const input = document.getElementById(`pwd-${username}`);
  const password = input?.value || '';
  if (password.length < 4) { alert('Digite uma senha com pelo menos 4 caracteres.'); return; }
  const result = await postJSON('/api/users/password', { username, password });
  if (result.success) {
    alert(`Senha de "${username}" atualizada.`);
    if (input) input.value = '';
  }
}

async function deleteUser(username) {
  if (!confirm(`Excluir o usuário "${username}"? As contas Steam dele continuam no painel, mas sem dono.`)) return;
  const result = await postJSON('/api/users/delete', { username });
  if (result.success) loadUsers();
}

loadMe();

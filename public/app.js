const socket = io();
let data = {};
let profilesOpen = false;
let searchTerm = '';

function showTab(name, btn) {
  document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
  btn.classList.add('active');

  document.getElementById('tab-dash').classList.toggle('hidden', name !== 'dash');
  document.getElementById('tab-profiles').classList.toggle('hidden', name !== 'profiles');

  profilesOpen = name === 'profiles';
  if (profilesOpen) renderProfiles(true);
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
              </div>
              <div class="stat-box">
                <span class="stat-label">Conta desde</span>
                <div class="stat-value">${fmtDateOnly(acc.createdAt)}</div>
              </div>
              <div class="stat-box">
                <span class="stat-label">Jogos configurados</span>
                <div class="stat-value">${Array.isArray(acc.games) ? acc.games.length : 0}</div>
              </div>
            </div>

            <div class="profile-section">
              <h4 class="section-title">Jogos ativos</h4>
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
            </div>

            <div class="profile-footer">
              <div class="add-row">
                <input id="newgame-${acc.username}" placeholder="Adicionar AppID (ex: 570)">
                <button class="btn-sm btn-ok" onclick="addGame('${acc.username}')">Add</button>
              </div>
              <div class="row-actions">
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
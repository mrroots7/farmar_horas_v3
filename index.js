const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const SteamUser = require('steam-user');
const fs = require('fs');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = 3000;
const ACCOUNTS_FILE = path.join(__dirname, 'accounts.json');
const STEAM_GUARD_TIMEOUT_MS = 5 * 60 * 1000; // 5 min pra digitar o código antes de desistir

let accounts = [];
const clients = {};          // username -> instância SteamUser conectada/conectando
const statusContas = {};     // username -> status exibido no painel
const gameNameCache = {};    // appId -> nome do jogo (cache em memória)
const steamGuardPending = {}; // username -> { answered, callback }

// ======================
// UTILITÁRIOS
// ======================
function log(tag, msg, extra) {
  const time = new Date().toLocaleTimeString('pt-BR');
  if (extra !== undefined) console.log(`[${time}] [${tag}] ${msg}`, extra);
  else console.log(`[${time}] [${tag}] ${msg}`);
}

function salvarContas() {
  fs.writeFileSync(ACCOUNTS_FILE, JSON.stringify(accounts, null, 2));
}

function normalizarAppIds(input) {
  const arr = Array.isArray(input) ? input : String(input || '').split(',');
  return [...new Set(
    arr.map(v => Number(String(v).trim()))
      .filter(id => Number.isInteger(id) && id > 0 && id < 999999999)
  )];
}

function validarAppIds(ids) {
  if (!ids.length) return { ok: false, message: 'Nenhum AppID válido.' };
  return { ok: true };
}

// Traduz o motivo de falha de login da Steam pra algo legível no painel
function descreverErroSteam(err) {
  const nomes = {
    5: 'Usuário ou senha incorretos',
    6: 'Sessão inválida, tente novamente',
    18: 'Conta Steam não existe',
    20: 'Serviço da Steam indisponível no momento',
    34: 'Sessão expirada, será necessário logar de novo',
    84: 'Muitas tentativas de login seguidas (rate limit). Aguarde alguns minutos',
    88: 'Código Steam Guard incorreto',
    65: 'Código Steam Guard incorreto',
    63: 'É necessário confirmar o login por e-mail ou app Steam Guard',
    5001: 'Falha de conexão com os servidores da Steam'
  };
  const eresult = err?.eresult;
  if (eresult && nomes[eresult]) return `${nomes[eresult]} (código ${eresult})`;
  if (eresult) {
    const nomeEnum = SteamUser.EResult?.[eresult];
    return nomeEnum ? `${nomeEnum} (código ${eresult})` : `Erro Steam código ${eresult}`;
  }
  return err?.message || 'Erro desconhecido';
}

function ensureStatus(username, partial = {}) {
  if (!statusContas[username]) {
    statusContas[username] = {
      username,
      status: 'OFFLINE',
      tempoFarmando: 0,
      statusDetalhado: 'Aguardando...',
      games: [730],
      activeGames: [], // [{appId,name,startedAt}]
      startedAt: null,
      steamID: null,
      profileUrl: null,
      createdAt: null
    };
  }
  Object.assign(statusContas[username], partial);
}

function emitAll(reason = 'update') {
  log('SOCKET', `emit update_all (${reason})`);
  io.emit('update_all', statusContas);
}

async function getGameName(appId) {
  const id = Number(appId);
  if (gameNameCache[id]) return gameNameCache[id];

  try {
    const url = `https://store.steampowered.com/api/appdetails?appids=${id}&l=portuguese`;
    const res = await fetch(url);
    const data = await res.json();
    const name = data?.[id]?.success ? data[id].data.name : `App ${id}`;
    gameNameCache[id] = name;
    return name;
  } catch (e) {
    log('WARN', `falha nome appId=${id}`, e.message);
    gameNameCache[id] = `App ${id}`;
    return gameNameCache[id];
  }
}

async function buildActiveGames(appIds, keepMap = {}) {
  const now = Date.now();
  const list = [];
  for (const id of appIds) {
    const name = await getGameName(id);
    list.push({
      appId: id,
      name,
      startedAt: keepMap[id]?.startedAt || now
    });
  }
  return list;
}

function carregarContas() {
  try {
    accounts = JSON.parse(fs.readFileSync(ACCOUNTS_FILE, 'utf8'));
    log('DB', `Contas carregadas: ${accounts.length}`);
  } catch {
    accounts = [];
    salvarContas();
  }

  let precisaSalvar = false;
  accounts.forEach(acc => {
    if (!Array.isArray(acc.games) || !acc.games.length) acc.games = [730];
    acc.games = normalizarAppIds(acc.games);

    if (!acc.createdAt) {
      acc.createdAt = Date.now();
      precisaSalvar = true;
    }

    ensureStatus(acc.username, {
      games: acc.games,
      activeGames: [],
      status: 'OFFLINE',
      statusDetalhado: 'Aguardando...',
      tempoFarmando: 0,
      startedAt: null,
      steamID: null,
      profileUrl: null,
      createdAt: acc.createdAt
    });
  });

  if (precisaSalvar) salvarContas();
}

carregarContas();

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.use((req, res, next) => {
  if (req.path.startsWith('/api/')) log('API', `${req.method} ${req.path}`, req.body || {});
  next();
});

// ======================
// ROTAS
// ======================
app.post('/api/add-account', async (req, res) => {
  try {
    const { username, password, games } = req.body;
    if (!username || !password) {
      return res.status(400).json({ success: false, message: 'Usuário e senha obrigatórios.' });
    }
    if (accounts.some(a => a.username === username)) {
      return res.status(400).json({ success: false, message: 'Conta já existe.' });
    }

    const gamesArray = normalizarAppIds(games?.length ? games : [730]);
    const valid = validarAppIds(gamesArray);
    if (!valid.ok) return res.status(400).json({ success: false, message: valid.message });

    const createdAt = Date.now();
    accounts.push({ username, password, games: gamesArray, createdAt });
    salvarContas();

    ensureStatus(username, {
      status: 'OFFLINE',
      tempoFarmando: 0,
      statusDetalhado: 'Conta adicionada',
      games: gamesArray,
      activeGames: [],
      startedAt: null,
      steamID: null,
      profileUrl: null,
      createdAt
    });

    emitAll('add-account');
    res.json({ success: true, message: 'Conta adicionada!' });
  } catch (err) {
    log('ERROR', 'add-account', err.message);
    res.status(500).json({ success: false, message: 'Erro interno.' });
  }
});

app.post('/api/delete-account', (req, res) => {
  try {
    const { username } = req.body;
    if (!username) return res.status(400).json({ success: false, message: 'Username obrigatório.' });

    if (clients[username]) {
      try { clients[username].logOff(); } catch { }
      delete clients[username];
    }

    accounts = accounts.filter(a => a.username !== username);
    delete statusContas[username];
    salvarContas();
    emitAll('delete-account');
    res.json({ success: true, message: 'Conta excluída.' });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Erro interno.' });
  }
});

app.post('/api/add-games', async (req, res) => {
  try {
    const { username, games } = req.body;
    if (!username || games === undefined) {
      return res.status(400).json({ success: false, message: 'Dados incompletos.' });
    }

    const acc = accounts.find(a => a.username === username);
    if (!acc) return res.status(404).json({ success: false, message: 'Conta não encontrada.' });

    const novos = normalizarAppIds(games);
    const valid = validarAppIds(novos);
    if (!valid.ok) return res.status(400).json({ success: false, message: valid.message });

    acc.games = normalizarAppIds([...(acc.games || []), ...novos]);
    salvarContas();
    ensureStatus(username, { games: acc.games });

    if (clients[username] && statusContas[username].status === 'ONLINE') {
      const keepMap = {};
      (statusContas[username].activeGames || []).forEach(g => {
        keepMap[g.appId] = g;
      });

      clients[username].gamesPlayed(acc.games);
      const activeGames = await buildActiveGames(acc.games, keepMap);

      ensureStatus(username, {
        activeGames,
        statusDetalhado: `Farmando ${activeGames.length} jogo(s)`
      });
    }

    emitAll('add-games');
    res.json({ success: true, message: 'Jogos adicionados!', games: acc.games });
  } catch (err) {
    log('ERROR', 'add-games', err.message);
    res.status(500).json({ success: false, message: 'Erro interno.' });
  }
});

app.post('/api/stop-game', async (req, res) => {
  try {
    const { username, appId } = req.body;
    if (!username || appId === undefined) {
      return res.status(400).json({ success: false, message: 'Dados incompletos.' });
    }

    const acc = accounts.find(a => a.username === username);
    if (!acc) return res.status(404).json({ success: false, message: 'Conta não encontrada.' });

    const id = Number(appId);
    acc.games = (acc.games || []).filter(g => g !== id);
    salvarContas();

    const keepMap = {};
    (statusContas[username]?.activeGames || []).forEach(g => {
      if (g.appId !== id) keepMap[g.appId] = g;
    });

    if (clients[username] && statusContas[username].status === 'ONLINE') {
      clients[username].gamesPlayed(acc.games);
      const activeGames = await buildActiveGames(acc.games, keepMap);
      ensureStatus(username, {
        games: acc.games,
        activeGames,
        statusDetalhado: activeGames.length ? `Farmando ${activeGames.length} jogo(s)` : 'Nenhum jogo ativo'
      });
    } else {
      ensureStatus(username, {
        games: acc.games,
        activeGames: (statusContas[username].activeGames || []).filter(g => g.appId !== id)
      });
    }

    emitAll('stop-game');
    res.json({ success: true, message: `Jogo ${id} parado.` });
  } catch (err) {
    log('ERROR', 'stop-game', err.message);
    res.status(500).json({ success: false, message: 'Erro interno.' });
  }
});

app.post('/api/stop-account', (req, res) => {
  try {
    const { username } = req.body;
    if (!username) return res.status(400).json({ success: false, message: 'Username obrigatório.' });

    if (clients[username]) {
      try {
        clients[username].gamesPlayed([]);
        clients[username].logOff();
      } catch { }
      delete clients[username];
    }

    ensureStatus(username, {
      status: 'OFFLINE',
      statusDetalhado: 'Farm parado',
      activeGames: [],
      startedAt: null,
      tempoFarmando: 0
    });

    emitAll('stop-account');
    res.json({ success: true, message: 'Farm parado.' });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Erro interno.' });
  }
});

app.post('/api/start-account', (req, res) => {
  try {
    const { username } = req.body;
    const acc = accounts.find(a => a.username === username);
    if (!acc) return res.status(404).json({ success: false, message: 'Conta não encontrada.' });
    if (clients[username]) return res.json({ success: false, message: 'Conta já está rodando.' });

    iniciarConta(acc.username, acc.password, acc.games || [730]);
    res.json({ success: true, message: 'Iniciando...' });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Erro interno.' });
  }
});

// ======================
// SOCKET + TIMER
// ======================
setInterval(() => {
  let mudou = false;
  Object.keys(statusContas).forEach(user => {
    if (statusContas[user].status === 'ONLINE') {
      statusContas[user].tempoFarmando += 1;
      mudou = true;
    }
  });
  if (mudou) io.emit('tick', statusContas);
}, 1000);

io.on('connection', (socket) => {
  socket.emit('update_all', statusContas);

  // Recebe o código do Steam Guard digitado no painel web
  socket.on('steamGuard_submit', ({ username, code }) => {
    const pending = steamGuardPending[username];
    if (!pending || pending.answered) return;
    pending.answered = true;
    delete steamGuardPending[username];
    log('STEAM', `${username} código Steam Guard recebido via painel`);
    pending.callback(String(code || '').trim());
  });
});

const delay = ms => new Promise(r => setTimeout(r, ms));

// ======================
// LOGIN NA STEAM
// ======================
function iniciarConta(username, password, games = [730]) {
  if (clients[username]) return;

  const cleanGames = normalizarAppIds(games);
  if (!validarAppIds(cleanGames).ok) {
    ensureStatus(username, { status: 'ERRO', statusDetalhado: 'AppIDs inválidos', activeGames: [] });
    emitAll('invalid-games');
    return;
  }

  const client = new SteamUser();
  clients[username] = client;

  ensureStatus(username, {
    status: 'CONECTANDO',
    statusDetalhado: 'Conectando...',
    games: cleanGames
  });
  emitAll('connecting');

  client.on('loggedOn', async () => {
    try {
      const steamID = client.steamID.getSteamID64();
      const profileUrl = `https://steamcommunity.com/profiles/${steamID}`;

      client.setPersona(SteamUser.EPersonaState.Online);
      client.gamesPlayed(cleanGames);

      const activeGames = await buildActiveGames(cleanGames);

      ensureStatus(username, {
        status: 'ONLINE',
        statusDetalhado: `Farmando ${activeGames.length} jogo(s)`,
        activeGames,
        games: [...cleanGames],
        startedAt: Date.now(),
        tempoFarmando: 0,
        steamID,
        profileUrl
      });

      emitAll('loggedOn');
      log('STEAM', `${username} ONLINE`, cleanGames);
    } catch (err) {
      log('ERROR', `${username} loggedOn`, err.message);
    }
  });

  // Salva o token de sessão pra não pedir Steam Guard de novo nos próximos starts
  client.on('refreshToken', (token) => {
    const acc = accounts.find(a => a.username === username);
    if (acc) {
      acc.refreshToken = token;
      salvarContas();
      log('STEAM', `${username} refreshToken salvo (login futuro não vai pedir Steam Guard)`);
    }
  });

  client.on('error', (err) => {
    const motivo = descreverErroSteam(err);
    ensureStatus(username, {
      status: 'ERRO',
      statusDetalhado: `Erro: ${motivo}`,
      activeGames: []
    });
    emitAll('error');
    log('ERROR', `${username} login falhou: ${motivo}`);

    // Token pode ter expirado/sido revogado — remove pra tentar user/senha no próximo start
    const acc = accounts.find(a => a.username === username);
    if (acc?.refreshToken && [5, 63, 65, 88].includes(err?.eresult)) {
      delete acc.refreshToken;
      salvarContas();
    }

    delete clients[username];
    try { client.logOff(); } catch { }
  });

  client.on('disconnected', () => {
    ensureStatus(username, {
      status: 'OFFLINE',
      statusDetalhado: 'Desconectado',
      activeGames: [],
      startedAt: null
    });
    emitAll('disconnected');
    delete clients[username];
  });

  client.on('steamGuard', (domain, callback) => {
    ensureStatus(username, {
      status: 'AGUARDANDO_GUARD',
      statusDetalhado: domain
        ? `Aguardando código enviado para ${domain} (digite no painel)`
        : 'Aguardando código do app Steam Guard (digite no painel)'
    });
    emitAll('steamGuard');

    if (steamGuardPending[username]) steamGuardPending[username].answered = true;
    steamGuardPending[username] = { answered: false, callback: (code) => callback(code) };
    io.emit('steamGuard_request', { username, domain: domain || null });
    log('STEAM', `${username} aguardando Steam Guard (informe no painel web)`);

    // Fallback: também aceita digitar direto no terminal, se houver um anexado
    process.stdin.once('data', data => {
      const pending = steamGuardPending[username];
      if (!pending || pending.answered) return;
      pending.answered = true;
      delete steamGuardPending[username];
      pending.callback(data.toString().trim());
    });

    // Evita ficar travado pra sempre se ninguém responder
    setTimeout(() => {
      const pending = steamGuardPending[username];
      if (!pending || pending.answered) return;
      pending.answered = true;
      delete steamGuardPending[username];
      log('WARN', `${username} Steam Guard expirou sem resposta`);
      ensureStatus(username, { status: 'ERRO', statusDetalhado: 'Tempo esgotado esperando código Steam Guard' });
      emitAll('steamGuard-timeout');
      delete clients[username];
      try { client.logOff(); } catch { }
    }, STEAM_GUARD_TIMEOUT_MS);
  });

  // Usa o refreshToken salvo se existir (evita pedir Steam Guard de novo);
  // se não tiver, loga normal com usuário/senha.
  const acc = accounts.find(a => a.username === username);
  if (acc?.refreshToken) {
    client.logOn({ refreshToken: acc.refreshToken });
  } else {
    client.logOn({ accountName: username, password });
  }
}

async function iniciarTodas() {
  for (const acc of accounts) {
    if (!clients[acc.username]) {
      iniciarConta(acc.username, acc.password, acc.games || [730]);
      await delay(25000 + Math.floor(Math.random() * 35000));
    }
  }
}

server.listen(PORT, () => {
  log('BOOT', `Painel em http://localhost:${PORT}`);
  iniciarTodas();
});

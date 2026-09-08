const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const session = require('express-session');
const SteamUser = require('steam-user');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = 3000;
const ACCOUNTS_FILE = path.join(__dirname, 'accounts.json');
const AUTH_FILE = path.join(__dirname, 'auth.json');
const SESSION_SECRET_FILE = path.join(__dirname, 'session-secret.json');
const WEBHOOKS_FILE = path.join(__dirname, 'webhooks.json');
const DASHBOARD_LOGS_FILE = path.join(__dirname, 'logs-dashboard.json');
const WEBHOOKS_LOGS_FILE = path.join(__dirname, 'logs-webhooks.json');
const INBOUND_EVENTS_FILE = path.join(__dirname, 'inbound-events.json');
const INBOUND_FILE = path.join(__dirname, 'inbound.json');
const API_CONFIG_FILE = path.join(__dirname, 'api-config.json');
const STEAM_KEY_FILE = path.join(__dirname, 'steam-api-key.json');
const WEBHOOK_TYPES = ['discord', 'telegram', 'whatsapp', 'sage', 'custom'];
const STEAM_GUARD_TIMEOUT_MS = 5 * 60 * 1000; // 5 min pra digitar o código antes de desistir
const MAX_LOGS = 500;
const MAX_INBOUND_EVENTS = 500;

let accounts = [];
let webhooks = [];
// Logs separados por aba: cada uma tem seu próprio histórico e seu próprio canal Socket.IO
let dashboardLog = [];
let webhooksLog = [];
let inboundEvents = []; // histórico organizado de tudo que chega em /api/inbound/:token
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

// ======================
// PERFIL STEAM (Steam Web API) — mostra uma "página de perfil" dentro do painel
// ======================
function loadSteamApiKey() {
  try {
    return JSON.parse(fs.readFileSync(STEAM_KEY_FILE, 'utf8')).key || '';
  } catch {
    return '';
  }
}

function saveSteamApiKey(key) {
  fs.writeFileSync(STEAM_KEY_FILE, JSON.stringify({ key: key || '' }, null, 2));
}

// Estados de presença que a Steam Web API devolve como número
const PERSONA_STATES = {
  0: 'Offline',
  1: 'Online',
  2: 'Ocupado',
  3: 'Ausente',
  4: 'Inativo',
  5: 'Querendo trocar',
  6: 'Querendo jogar'
};

async function buscarPerfilSteam(steamID) {
  const key = loadSteamApiKey();
  if (!key) {
    return { ok: false, message: 'Nenhuma Steam Web API Key configurada. Gere uma em https://steamcommunity.com/dev/apikey e salve no painel.' };
  }
  if (!steamID) {
    return { ok: false, message: 'Essa conta ainda não tem um SteamID (faça login nela ao menos uma vez).' };
  }

  try {
    const [summaryRes, levelRes, gamesRes] = await Promise.all([
      fetch(`https://api.steampowered.com/ISteamUser/GetPlayerSummaries/v0002/?key=${key}&steamids=${steamID}`),
      fetch(`https://api.steampowered.com/IPlayerService/GetSteamLevel/v1/?key=${key}&steamid=${steamID}`),
      fetch(`https://api.steampowered.com/IPlayerService/GetOwnedGames/v1/?key=${key}&steamid=${steamID}&include_appinfo=false`)
    ]);

    const summaryData = await summaryRes.json().catch(() => ({}));
    const levelData = await levelRes.json().catch(() => ({}));
    const gamesData = await gamesRes.json().catch(() => ({}));

    const p = summaryData?.response?.players?.[0];
    if (!p) return { ok: false, message: 'Steam não retornou dados para esse perfil (verifique a API key ou o SteamID).' };

    return {
      ok: true,
      profile: {
        steamID,
        personaname: p.personaname,
        realname: p.realname || null,
        avatar: p.avatarfull || p.avatarmedium || p.avatar || null,
        profileurl: p.profileurl,
        personastate: PERSONA_STATES[p.personastate] ?? 'Desconhecido',
        online: p.personastate !== 0,
        visibilidadePublica: p.communityvisibilitystate === 3,
        criadaEm: p.timecreated ? p.timecreated * 1000 : null,
        pais: p.loccountrycode || null,
        jogoAtual: p.gameextrainfo || null,
        level: levelData?.response?.player_level ?? null,
        totalJogos: gamesData?.response?.game_count ?? null
      }
    };
  } catch (err) {
    return { ok: false, message: `Erro ao consultar a Steam Web API: ${err.message}` };
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

// ======================
// LOGIN FIXO (DONO DO PAINEL)
// ======================
function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  try {
    const [salt, hash] = String(stored || '').split(':');
    if (!salt || !hash) return false;
    const hashVerify = crypto.scryptSync(password, salt, 64).toString('hex');
    const a = Buffer.from(hash, 'hex');
    const b = Buffer.from(hashVerify, 'hex');
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

function loadAuth() {
  try {
    return JSON.parse(fs.readFileSync(AUTH_FILE, 'utf8'));
  } catch {
    const def = { username: 'admin', passwordHash: hashPassword('admin123') };
    fs.writeFileSync(AUTH_FILE, JSON.stringify(def, null, 2));
    log('AUTH', '⚠ auth.json criado com login padrão (usuário: admin / senha: admin123).');
    log('AUTH', '⚠ TROQUE AGORA rodando: node set-password.js <usuario> <senha>');
    return def;
  }
}

function loadSessionSecret() {
  try {
    return JSON.parse(fs.readFileSync(SESSION_SECRET_FILE, 'utf8')).secret;
  } catch {
    const secret = crypto.randomBytes(32).toString('hex');
    fs.writeFileSync(SESSION_SECRET_FILE, JSON.stringify({ secret }));
    return secret;
  }
}

const sessionMiddleware = session({
  secret: loadSessionSecret(),
  resave: false,
  saveUninitialized: false,
  cookie: {
    maxAge: 7 * 24 * 60 * 60 * 1000, // 7 dias
    httpOnly: true,
    sameSite: 'lax'
  }
});

// Caminhos acessíveis sem estar logado (só a tela de login e os recursos que
// precisam ser chamados de fora, como o link de webhooks de entrada)
function isPublicPath(p) {
  return (
    p === '/login.html' ||
    p === '/login.js' ||
    p === '/style.css' ||
    p === '/api/login' ||
    p.startsWith('/api/inbound/') ||
    p.startsWith('/api/public/') ||
    p.startsWith('/socket.io')
  );
}

function requireAuth(req, res, next) {
  if (isPublicPath(req.path)) return next();
  if (req.session && req.session.loggedIn) return next();
  if (req.path.startsWith('/api/')) {
    return res.status(401).json({ success: false, message: 'Não autenticado. Faça login novamente.' });
  }
  return res.redirect('/login.html');
}

// ======================
// WEBHOOKS (DISCORD / SAGE) + LOG DE ATIVIDADE
// ======================
function salvarWebhooks() {
  fs.writeFileSync(WEBHOOKS_FILE, JSON.stringify(webhooks, null, 2));
}

function carregarWebhooks() {
  try {
    webhooks = JSON.parse(fs.readFileSync(WEBHOOKS_FILE, 'utf8'));
  } catch {
    webhooks = [];
    salvarWebhooks();
  }
}

function salvarDashboardLog() {
  fs.writeFileSync(DASHBOARD_LOGS_FILE, JSON.stringify(dashboardLog.slice(-MAX_LOGS), null, 2));
}

function salvarWebhooksLog() {
  fs.writeFileSync(WEBHOOKS_LOGS_FILE, JSON.stringify(webhooksLog.slice(-MAX_LOGS), null, 2));
}

function carregarLogs() {
  try {
    dashboardLog = JSON.parse(fs.readFileSync(DASHBOARD_LOGS_FILE, 'utf8'));
  } catch {
    dashboardLog = [];
  }
  try {
    webhooksLog = JSON.parse(fs.readFileSync(WEBHOOKS_LOGS_FILE, 'utf8'));
  } catch {
    webhooksLog = [];
  }
}

function salvarInboundEvents() {
  fs.writeFileSync(INBOUND_EVENTS_FILE, JSON.stringify(inboundEvents.slice(-MAX_INBOUND_EVENTS), null, 2));
}

function carregarInboundEvents() {
  try {
    inboundEvents = JSON.parse(fs.readFileSync(INBOUND_EVENTS_FILE, 'utf8'));
  } catch {
    inboundEvents = [];
  }
}

// Guarda de forma organizada (JSON) TUDO que chega no link de entrada, antes mesmo
// de tentar interpretar o conteúdo. Assim nada se perde, mesmo que o formato do
// SAGE (ou de outro serviço) mude no futuro.
function registrarEventoInbound(corpo, meta = {}) {
  const entry = {
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 7),
    timestamp: Date.now(),
    origemIp: meta.ip || null,
    body: corpo
  };
  inboundEvents.push(entry);
  if (inboundEvents.length > MAX_INBOUND_EVENTS) inboundEvents = inboundEvents.slice(-MAX_INBOUND_EVENTS);
  salvarInboundEvents();
  return entry;
}

// ======================
// WEBHOOKS DE ENTRADA (o painel recebe eventos de fora: SAGE, Discord, etc.)
// ======================
function gerarToken() {
  return crypto.randomBytes(24).toString('hex');
}

function carregarInbound() {
  try {
    return JSON.parse(fs.readFileSync(INBOUND_FILE, 'utf8'));
  } catch {
    const cfg = { token: gerarToken() };
    fs.writeFileSync(INBOUND_FILE, JSON.stringify(cfg, null, 2));
    return cfg;
  }
}

function salvarInbound(cfg) {
  fs.writeFileSync(INBOUND_FILE, JSON.stringify(cfg, null, 2));
}

function inboundUrl(req, token) {
  return `${req.protocol}://${req.get('host')}/api/inbound/${token}`;
}

// ======================
// API PÚBLICA (token separado do link de inbound — pra terceiros consultarem
// os dados salvos, e não pra receber eventos)
// ======================
function carregarApiConfig() {
  try {
    return JSON.parse(fs.readFileSync(API_CONFIG_FILE, 'utf8'));
  } catch {
    const cfg = { token: gerarToken() };
    fs.writeFileSync(API_CONFIG_FILE, JSON.stringify(cfg, null, 2));
    return cfg;
  }
}

function salvarApiConfig(cfg) {
  fs.writeFileSync(API_CONFIG_FILE, JSON.stringify(cfg, null, 2));
}

// Aceita o token via query (?token=), header X-API-Token ou Authorization: Bearer.
function verificarApiToken(req, res, next) {
  const auth = req.headers.authorization || '';
  const bearer = auth.toLowerCase().startsWith('bearer ') ? auth.slice(7).trim() : null;
  const token = req.query.token || req.headers['x-api-token'] || bearer;

  if (!token || token !== apiConfig.token) {
    return res.status(401).json({ success: false, message: 'Token de API inválido ou ausente. Envie em ?token=, no header X-API-Token ou Authorization: Bearer.' });
  }
  next();
}

// ======================
// EXTRAÇÃO DE CONTAS A PARTIR DO BODY DO SAGE (ou de qualquer serviço parecido)
// ======================
// O SAGE (e serviços similares) não têm um formato 100% fixo de campo, então
// tentamos várias variações comuns de nome antes de desistir.
function pickField(obj, names) {
  if (!obj || typeof obj !== 'object') return undefined;
  for (const n of names) {
    if (obj[n] !== undefined && obj[n] !== null && obj[n] !== '') return obj[n];
  }
  return undefined;
}

const CAMPOS_USERNAME = ['username', 'user', 'login', 'account', 'accountName', 'account_name', 'steamLogin', 'steam_username', 'steamUsername', 'conta', 'usuario'];
const CAMPOS_PASSWORD = ['password', 'senha', 'pass', 'pwd', 'steamPassword', 'steam_password', 'steamSenha'];
const CAMPOS_GAMES = ['games', 'game', 'appids', 'appIds', 'apps', 'appid', 'app_id', 'appId', 'jogos'];

// Retorna { username, password, games } se o objeto parecer uma conta Steam válida
// (username + password presentes), ou null caso contrário.
function extrairContaDoBody(item) {
  if (!item || typeof item !== 'object') return null;

  const username = pickField(item, CAMPOS_USERNAME);
  const password = pickField(item, CAMPOS_PASSWORD);
  if (!username || !password) return null;

  const gamesRaw = pickField(item, CAMPOS_GAMES);
  const games = gamesRaw !== undefined ? normalizarAppIds(gamesRaw) : [730];

  return {
    username: String(username).trim(),
    password: String(password),
    games: games.length ? games : [730]
  };
}

// channel: 'dashboard' (eventos de contas/farm) ou 'webhooks' (eventos de
// integrações/entrada). Cada canal tem seu próprio histórico + evento Socket.IO,
// então cada aba do painel mostra só o que é dela.
function addLog(evento, mensagem, username = null, channel = 'dashboard') {
  const entry = {
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 7),
    timestamp: Date.now(),
    evento,
    mensagem,
    username,
    channel
  };

  if (channel === 'webhooks') {
    webhooksLog.push(entry);
    if (webhooksLog.length > MAX_LOGS) webhooksLog = webhooksLog.slice(-MAX_LOGS);
    salvarWebhooksLog();
    io.emit('log_entry_webhooks', entry);
  } else {
    dashboardLog.push(entry);
    if (dashboardLog.length > MAX_LOGS) dashboardLog = dashboardLog.slice(-MAX_LOGS);
    salvarDashboardLog();
    io.emit('log_entry_dashboard', entry);
  }

  return entry;
}

// Monta a requisição certa pra cada tipo de webhook de saída e a dispara.
// Retorna { ok, status, text } pra quem quiser reportar sucesso/erro (ex: botão Testar).
async function enviarParaWebhook(wh, evento, mensagem, username) {
  const texto = `[${evento}]${username ? ` ${username} —` : ''} ${mensagem}`;

  if (wh.type === 'discord') {
    const resp = await fetch(wh.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: `**[${evento}]**${username ? ` \`${username}\` —` : ''} ${mensagem}` })
    });
    return { ok: resp.ok, status: resp.status, text: resp.ok ? '' : await resp.text().catch(() => '') };
  }

  if (wh.type === 'telegram') {
    // wh.url guarda o token do bot, wh.extra guarda o chat_id
    const resp = await fetch(`https://api.telegram.org/bot${wh.url}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: wh.extra, text: texto })
    });
    return { ok: resp.ok, status: resp.status, text: resp.ok ? '' : await resp.text().catch(() => '') };
  }

  if (wh.type === 'whatsapp') {
    // wh.url guarda o número (com DDI), wh.extra guarda a apikey do CallMeBot
    const params = new URLSearchParams({ phone: wh.url, text: texto, apikey: wh.extra || '' });
    const resp = await fetch(`https://api.callmebot.com/whatsapp.php?${params.toString()}`, { method: 'GET' });
    return { ok: resp.ok, status: resp.status, text: resp.ok ? '' : await resp.text().catch(() => '') };
  }

  // 'sage' e 'custom' (e qualquer serviço genérico): JSON simples via POST
  const resp = await fetch(wh.url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ event: evento, username, message: mensagem, timestamp: Date.now() })
  });
  return { ok: resp.ok, status: resp.status, text: resp.ok ? '' : await resp.text().catch(() => '') };
}

// Dispara o evento pra todos os webhooks ativos (cada tipo recebe o formato certo)
// e sempre grava no log de atividade do site, mesmo sem nenhum webhook cadastrado.
// channel decide em qual aba (Dashboard ou Webhooks) o evento aparece em tempo real.
async function dispararWebhooks(evento, mensagem, username = null, channel = 'dashboard') {
  addLog(evento, mensagem, username, channel);

  const ativos = webhooks.filter(w => w.active);
  for (const wh of ativos) {
    try {
      const resultado = await enviarParaWebhook(wh, evento, mensagem, username);
      if (!resultado.ok) {
        log('WEBHOOK', `Falha ao enviar para "${wh.name}" (${wh.type}): HTTP ${resultado.status}`);
      }
    } catch (err) {
      log('WEBHOOK', `Erro ao enviar para "${wh.name}" (${wh.type}): ${err.message}`);
    }
  }
}

carregarContas();
carregarWebhooks();
carregarLogs();
carregarInboundEvents();
let inboundConfig = carregarInbound();
let apiConfig = carregarApiConfig();
const authConfig = loadAuth();

app.use(express.json());
app.use(sessionMiddleware);
app.use(requireAuth);
app.use(express.static(path.join(__dirname, 'public')));

app.use((req, res, next) => {
  if (req.path.startsWith('/api/')) log('API', `${req.method} ${req.path}`, req.body || {});
  next();
});

// ======================
// ROTAS DE LOGIN
// ======================
app.post('/api/login', (req, res) => {
  const { username, password } = req.body || {};
  const auth = loadAuth(); // relê do disco (permite trocar senha via set-password.js sem reiniciar)

  if (username === auth.username && verifyPassword(password, auth.passwordHash)) {
    req.session.loggedIn = true;
    req.session.username = username;
    log('AUTH', `Login bem-sucedido: ${username}`);
    return res.json({ success: true });
  }

  log('AUTH', `Tentativa de login falhou para usuário "${username}"`);
  return res.status(401).json({ success: false, message: 'Usuário ou senha inválidos.' });
});

app.post('/api/logout', (req, res) => {
  req.session.destroy(() => {
    res.json({ success: true });
  });
});

// ======================
// ROTAS - CONTAS
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
    dispararWebhooks('CONTA_ADICIONADA', `Conta cadastrada com AppIDs: ${gamesArray.join(', ')}`, username);
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
    dispararWebhooks('CONTA_EXCLUIDA', 'Conta removida do painel.', username);
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
    dispararWebhooks('JOGOS_ADICIONADOS', `AppIDs adicionados: ${novos.join(', ')}`, username);
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
    dispararWebhooks('JOGO_PARADO', `AppID ${id} parado.`, username);
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
    dispararWebhooks('CONTA_PARADA', 'Farm parado manualmente.', username);
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
// ROTAS - WEBHOOKS
// ======================
app.get('/api/webhooks', (req, res) => {
  res.json({ success: true, webhooks, logs: webhooksLog.slice(-100).reverse() });
});

// Igual ao "adicionar conta", só que aqui é pra webhooks: escolha quantos quiser,
// separando Discord de SAGE pelo campo "type".
app.post('/api/add-webhook', (req, res) => {
  try {
    const { name, type, url, extra } = req.body || {};
    if (!name || !type || !url) {
      return res.status(400).json({ success: false, message: 'Nome, tipo e o primeiro campo são obrigatórios.' });
    }
    if (!WEBHOOK_TYPES.includes(type)) {
      return res.status(400).json({ success: false, message: `Tipo inválido (use: ${WEBHOOK_TYPES.join(', ')}).` });
    }

    // Discord/SAGE/Custom usam URL de verdade; Telegram usa token do bot; WhatsApp usa número.
    if (['discord', 'sage', 'custom'].includes(type)) {
      try { new URL(url); } catch {
        return res.status(400).json({ success: false, message: 'URL inválida.' });
      }
    }
    if (type === 'telegram' && !extra) {
      return res.status(400).json({ success: false, message: 'Informe o Chat ID do Telegram.' });
    }
    if (type === 'whatsapp' && !extra) {
      return res.status(400).json({ success: false, message: 'Informe a API Key (CallMeBot) do WhatsApp.' });
    }

    const webhook = {
      id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      name,
      type,
      url,
      extra: extra || null,
      active: true,
      createdAt: Date.now()
    };
    webhooks.push(webhook);
    salvarWebhooks();
    io.emit('webhooks_update', webhooks);
    dispararWebhooks('WEBHOOK_ADICIONADO', `Webhook "${name}" (${type}) cadastrado.`, null, 'webhooks');
    res.json({ success: true, message: 'Webhook adicionado!', webhook });
  } catch (err) {
    log('ERROR', 'add-webhook', err.message);
    res.status(500).json({ success: false, message: 'Erro interno.' });
  }
});

app.post('/api/delete-webhook', (req, res) => {
  try {
    const { id } = req.body || {};
    const wh = webhooks.find(w => w.id === id);
    webhooks = webhooks.filter(w => w.id !== id);
    salvarWebhooks();
    io.emit('webhooks_update', webhooks);
    if (wh) dispararWebhooks('WEBHOOK_REMOVIDO', `Webhook "${wh.name}" (${wh.type}) removido.`, null, 'webhooks');
    res.json({ success: true, message: 'Webhook removido.' });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Erro interno.' });
  }
});

// Envia uma mensagem de teste pro webhook na hora, sem depender de nenhum evento real acontecer.
app.post('/api/test-webhook', async (req, res) => {
  try {
    const { id } = req.body || {};
    const wh = webhooks.find(w => w.id === id);
    if (!wh) return res.status(404).json({ success: false, message: 'Webhook não encontrado.' });

    const resultado = await enviarParaWebhook(wh, 'TESTE', `Webhook "${wh.name}" configurado corretamente!`, null);

    if (!resultado.ok) {
      addLog('WEBHOOK_TESTE_FALHOU', `Teste para "${wh.name}" (${wh.type}) retornou HTTP ${resultado.status}.`, null, 'webhooks');
      return res.status(400).json({ success: false, message: `A requisição respondeu com erro HTTP ${resultado.status}. ${resultado.text ? resultado.text.slice(0, 200) : ''}`.trim() });
    }

    addLog('WEBHOOK_TESTE_OK', `Teste enviado com sucesso para "${wh.name}" (${wh.type}).`, null, 'webhooks');
    res.json({ success: true, message: 'Teste enviado! Confira se chegou.' });
  } catch (err) {
    addLog('WEBHOOK_TESTE_FALHOU', `Erro ao testar webhook: ${err.message}`, null, 'webhooks');
    res.status(500).json({ success: false, message: `Não foi possível enviar: ${err.message}` });
  }
});

app.post('/api/toggle-webhook', (req, res) => {
  try {
    const { id, active } = req.body || {};
    const wh = webhooks.find(w => w.id === id);
    if (!wh) return res.status(404).json({ success: false, message: 'Webhook não encontrado.' });

    wh.active = !!active;
    salvarWebhooks();
    io.emit('webhooks_update', webhooks);
    dispararWebhooks('WEBHOOK_ATUALIZADO', `Webhook "${wh.name}" ${wh.active ? 'ativado' : 'desativado'}.`, null, 'webhooks');
    res.json({ success: true, message: 'Webhook atualizado.' });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Erro interno.' });
  }
});

// ======================
// ROTAS - PERFIL STEAM (Steam Web API)
// ======================
app.get('/api/steam-key', (req, res) => {
  const key = loadSteamApiKey();
  // nunca devolve a chave inteira pro front, só se está configurada e os últimos 4 caracteres
  res.json({ success: true, configured: !!key, hint: key ? `••••••••${key.slice(-4)}` : null });
});

app.post('/api/steam-key', (req, res) => {
  const { key } = req.body || {};
  if (!key || typeof key !== 'string' || key.trim().length < 10) {
    return res.status(400).json({ success: false, message: 'Chave inválida. Cole a Steam Web API Key completa.' });
  }
  saveSteamApiKey(key.trim());
  addLog('STEAM_API_KEY', 'Steam Web API Key atualizada.', null, 'dashboard');
  res.json({ success: true, message: 'Chave salva!' });
});

app.get('/api/steam-profile/:username', async (req, res) => {
  const acc = statusContas[req.params.username];
  if (!acc) return res.status(404).json({ success: false, message: 'Conta não encontrada.' });

  const resultado = await buscarPerfilSteam(acc.steamID);
  if (!resultado.ok) return res.status(400).json(resultado);
  res.json({ success: true, profile: resultado.profile });
});

// ======================
// ROTAS - EXPORTAR / IMPORTAR CONFIGURAÇÕES
// ======================
app.get('/api/export', (req, res) => {
  const payload = {
    formato: 'farmar-horas-backup-v1',
    exportedAt: Date.now(),
    accounts: accounts.map(a => ({ username: a.username, password: a.password, games: a.games })),
    webhooks: webhooks.map(w => ({ name: w.name, type: w.type, url: w.url, extra: w.extra || null }))
  };
  res.setHeader('Content-Disposition', 'attachment; filename="farmar-horas-backup.json"');
  res.json(payload);
});

app.post('/api/import', async (req, res) => {
  try {
    const body = req.body || {};
    const contasEntrada = Array.isArray(body.accounts) ? body.accounts : [];
    const webhooksEntrada = Array.isArray(body.webhooks) ? body.webhooks : [];

    let contasAdicionadas = 0, contasIgnoradas = 0;
    let webhooksAdicionados = 0, webhooksIgnorados = 0;

    for (const item of contasEntrada) {
      const username = String(item?.username || '').trim();
      const password = String(item?.password || '');
      if (!username || !password) { contasIgnoradas++; continue; }
      if (accounts.some(a => a.username === username)) { contasIgnoradas++; continue; }

      const gamesArray = normalizarAppIds(Array.isArray(item.games) && item.games.length ? item.games : [730]);
      const createdAt = Date.now();
      accounts.push({ username, password, games: gamesArray, createdAt });
      ensureStatus(username, {
        status: 'OFFLINE', tempoFarmando: 0, statusDetalhado: 'Importada',
        games: gamesArray, activeGames: [], startedAt: null, steamID: null, profileUrl: null, createdAt
      });
      contasAdicionadas++;
    }
    if (contasAdicionadas) salvarContas();

    for (const item of webhooksEntrada) {
      const name = String(item?.name || '').trim();
      const type = String(item?.type || '').trim();
      const url = String(item?.url || '').trim();
      const extra = item?.extra || null;
      if (!name || !WEBHOOK_TYPES.includes(type) || !url) { webhooksIgnorados++; continue; }

      webhooks.push({
        id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
        name, type, url, extra, active: true, createdAt: Date.now()
      });
      webhooksAdicionados++;
    }
    if (webhooksAdicionados) salvarWebhooks();

    if (contasAdicionadas) emitAll('import');
    if (webhooksAdicionados) io.emit('webhooks_update', webhooks);

    const resumo = `Importação: ${contasAdicionadas} conta(s) e ${webhooksAdicionados} webhook(s) adicionados; ${contasIgnoradas} conta(s) e ${webhooksIgnorados} webhook(s) ignorados (duplicados ou inválidos).`;
    dispararWebhooks('CONFIG_IMPORTADA', resumo);
    res.json({ success: true, message: resumo, contasAdicionadas, contasIgnoradas, webhooksAdicionados, webhooksIgnorados });
  } catch (err) {
    res.status(500).json({ success: false, message: `Erro ao importar: ${err.message}` });
  }
});

// ======================
// ROTAS - WEBHOOKS DE ENTRADA (o painel recebe eventos de fora)
// ======================
app.get('/api/inbound-info', (req, res) => {
  res.json({ success: true, url: inboundUrl(req, inboundConfig.token), token: inboundConfig.token });
});

app.post('/api/inbound-regenerate', (req, res) => {
  inboundConfig = { token: gerarToken() };
  salvarInbound(inboundConfig);
  dispararWebhooks('INBOUND_REGERADO', 'O link de recebimento de webhooks foi renovado (o antigo parou de funcionar).', null, 'webhooks');
  res.json({ success: true, url: inboundUrl(req, inboundConfig.token), token: inboundConfig.token });
});

// Rota pública (validada pelo token na URL, não por sessão) — é nela que SAGE,
// Discord ou qualquer outro serviço deve enviar um POST pra avisar o painel de algo.
// Registra TUDO (mesmo que não seja reconhecido), tenta extrair conta(s) Steam
// nova(s) do corpo, e se achar, salva + inicia o farm automaticamente.
app.post('/api/inbound/:token', async (req, res) => {
  if (req.params.token !== inboundConfig.token) {
    // Antes isso falhava em SILÊNCIO (nada aparecia em lugar nenhum). Agora fica
    // registrado, pra dar pra perceber quando o SAGE (ou outro serviço) está
    // batendo num link antigo/errado.
    addLog(
      'INBOUND_TOKEN_INVALIDO',
      `Recebido POST com token inválido em /api/inbound/${req.params.token.slice(0, 8)}... (IP: ${req.ip}). Se você regenerou o link recentemente, atualize a URL cadastrada no SAGE/Discord.`,
      null,
      'webhooks'
    );
    return res.status(403).json({ success: false, message: 'Token inválido.' });
  }

  const corpo = req.body || {};

  // 1) Guarda o evento cru, organizado, antes de qualquer interpretação —
  //    assim nada se perde mesmo que o formato mude.
  registrarEventoInbound(corpo, { ip: req.ip });

  // 2) Tenta extrair conta(s) Steam do corpo. Aceita tanto um objeto único
  //    quanto uma lista em "accounts" (alguns serviços mandam várias de uma vez).
  const listaCandidatos = Array.isArray(corpo.accounts) ? corpo.accounts : [corpo];
  let contasAdicionadas = 0;
  const usernamesProcessados = [];

  for (const item of listaCandidatos) {
    const conta = extrairContaDoBody(item);
    if (!conta) continue;

    usernamesProcessados.push(conta.username);

    if (accounts.some(a => a.username === conta.username)) {
      addLog('SAGE_CONTA_DUPLICADA', `Conta "${conta.username}" recebida via SAGE já existia no painel — ignorada.`, conta.username, 'webhooks');
      continue;
    }

    const valid = validarAppIds(conta.games);
    if (!valid.ok) {
      addLog('SAGE_CONTA_INVALIDA', `Conta "${conta.username}" recebida via SAGE com AppIDs inválidos.`, conta.username, 'webhooks');
      continue;
    }

    const createdAt = Date.now();
    accounts.push({ username: conta.username, password: conta.password, games: conta.games, createdAt, origem: 'sage' });
    salvarContas();

    ensureStatus(conta.username, {
      status: 'OFFLINE',
      statusDetalhado: 'Conta recebida via SAGE — iniciando...',
      games: conta.games,
      activeGames: [],
      startedAt: null,
      steamID: null,
      profileUrl: null,
      createdAt
    });

    emitAll('inbound-sage-account');
    addLog('SAGE_CONTA_RECEBIDA', `Conta recebida via SAGE e salva automaticamente. AppIDs: ${conta.games.join(', ')}`, conta.username, 'webhooks');
    dispararWebhooks('CONTA_ADICIONADA', `Conta cadastrada automaticamente via SAGE. AppIDs: ${conta.games.join(', ')}`, conta.username, 'dashboard');

    // Inicia o farm sozinho, sem precisar de nenhuma ação manual no painel.
    iniciarConta(conta.username, conta.password, conta.games);
    contasAdicionadas++;
  }

  // 3) Sempre registra o evento no log (mesmo quando nenhuma conta foi extraída,
  //    ex: pings, testes, ou eventos informativos do SAGE/Discord).
  const origem = usernamesProcessados[0] || corpo.username || corpo.user || corpo.account || null;
  let mensagem = corpo.message || corpo.mensagem || corpo.content || corpo.text;
  if (!mensagem) {
    if (contasAdicionadas > 0) {
      mensagem = `${contasAdicionadas} conta(s) recebida(s) e iniciada(s) automaticamente.`;
    } else {
      try { mensagem = JSON.stringify(corpo).slice(0, 300); } catch { mensagem = 'Evento recebido sem corpo legível.'; }
    }
  }

  const eventoNome = corpo.event || corpo.evento || (contasAdicionadas > 0 ? 'SAGE_CONTAS_PROCESSADAS' : 'WEBHOOK_RECEBIDO');
  addLog(eventoNome, String(mensagem), origem, 'webhooks');

  res.json({ success: true, message: 'Evento recebido.', contasAdicionadas });
});

// ======================
// ROTAS - TOKEN DA API PÚBLICA (protegidas por sessão, é aqui que o dono do
// painel gerencia o token; quem usa a API de fora usa /api/public/*)
// ======================
app.get('/api/api-token', (req, res) => {
  res.json({ success: true, token: apiConfig.token });
});

app.post('/api/api-token/regenerate', (req, res) => {
  apiConfig = { token: gerarToken() };
  salvarApiConfig(apiConfig);
  addLog('API_TOKEN_REGENERADO', 'O token da API pública foi renovado (o antigo parou de funcionar).', null, 'dashboard');
  res.json({ success: true, token: apiConfig.token });
});

// ======================
// API PÚBLICA (protegida por token, pra terceiros/bots consumirem os dados)
// ======================
function contaPublica(acc) {
  const status = statusContas[acc.username] || {};
  return {
    username: acc.username,
    games: acc.games,
    createdAt: acc.createdAt,
    origem: acc.origem || 'manual',
    status: status.status || 'OFFLINE',
    statusDetalhado: status.statusDetalhado || null,
    tempoFarmando: status.tempoFarmando || 0,
    activeGames: status.activeGames || [],
    steamID: status.steamID || null,
    profileUrl: status.profileUrl || null
    // senha nunca é exposta pela API pública
  };
}

app.get('/api/public/accounts', verificarApiToken, (req, res) => {
  res.json({ success: true, count: accounts.length, accounts: accounts.map(contaPublica) });
});

app.get('/api/public/logs', verificarApiToken, (req, res) => {
  const limit = Math.min(Math.max(Number(req.query.limit) || 100, 1), MAX_LOGS);
  res.json({
    success: true,
    dashboard: dashboardLog.slice(-limit).reverse(),
    webhooks: webhooksLog.slice(-limit).reverse()
  });
});

app.get('/api/public/inbound-events', verificarApiToken, (req, res) => {
  const limit = Math.min(Math.max(Number(req.query.limit) || 100, 1), MAX_INBOUND_EVENTS);
  res.json({ success: true, events: inboundEvents.slice(-limit).reverse() });
});

// Endpoint "tudo em um" — mais prático pra bots que só querem um único GET.
app.get('/api/public/data', verificarApiToken, (req, res) => {
  const limit = Math.min(Math.max(Number(req.query.limit) || 100, 1), MAX_LOGS);
  res.json({
    success: true,
    accounts: accounts.map(contaPublica),
    logs: {
      dashboard: dashboardLog.slice(-limit).reverse(),
      webhooks: webhooksLog.slice(-limit).reverse()
    }
  });
});

// ======================
// ROTAS - LOGS
// ======================
// channel no body decide qual log é apagado ('dashboard' ou 'webhooks'); sem
// informar, apaga os dois (compatibilidade com a versão anterior).
app.post('/api/logs/clear', (req, res) => {
  const { channel } = req.body || {};

  if (!channel || channel === 'dashboard') {
    dashboardLog = [];
    salvarDashboardLog();
    io.emit('logs_cleared_dashboard');
  }
  if (!channel || channel === 'webhooks') {
    webhooksLog = [];
    salvarWebhooksLog();
    io.emit('logs_cleared_webhooks');
  }

  res.json({ success: true, message: 'Log de atividade apagado.' });
});

// ======================
// SOCKET (protegido por sessão) + TIMER
// ======================
io.use((socket, next) => sessionMiddleware(socket.request, {}, next));
io.use((socket, next) => {
  if (socket.request.session && socket.request.session.loggedIn) return next();
  next(new Error('unauthorized'));
});

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
  socket.emit('webhooks_update', webhooks);
  socket.emit('logs_init_dashboard', dashboardLog.slice(-100).reverse());
  socket.emit('logs_init_webhooks', webhooksLog.slice(-100).reverse());

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
      dispararWebhooks('CONTA_ONLINE', `Online e farmando ${activeGames.length} jogo(s): ${activeGames.map(g => g.name).join(', ')}`, username);
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
    dispararWebhooks('CONTA_ERRO', `Falha: ${motivo}`, username);
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
    dispararWebhooks('CONTA_DESCONECTADA', 'Conta desconectada.', username);
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
    dispararWebhooks('STEAM_GUARD', 'Aguardando código Steam Guard.', username);

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
  log('BOOT', `Login: usuário "${authConfig.username}" (troque a senha com: node set-password.js <usuario> <senha>)`);
  iniciarTodas();
});

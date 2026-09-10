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
const USERS_FILE = path.join(__dirname, 'users.json');
const SESSION_SECRET_FILE = path.join(__dirname, 'session-secret.json');
const WEBHOOKS_FILE = path.join(__dirname, 'webhooks.json');
const DASHBOARD_LOGS_FILE = path.join(__dirname, 'logs-dashboard.json');
const WEBHOOKS_LOGS_FILE = path.join(__dirname, 'logs-webhooks.json');
const INBOUND_EVENTS_FILE = path.join(__dirname, 'inbound-events.json');
const INBOUND_FILE = path.join(__dirname, 'inbound.json');
const API_CONFIG_FILE = path.join(__dirname, 'api-config.json');
const STEAM_KEY_FILE = path.join(__dirname, 'steam-api-key.json');
const FACEIT_KEY_FILE = path.join(__dirname, 'faceit-api-key.json');
const WEBHOOK_TYPES = ['discord', 'telegram', 'whatsapp', 'sage', 'custom'];
const STEAM_GUARD_TIMEOUT_MS = 5 * 60 * 1000; // 5 min pra digitar o código antes de desistir
const MAX_LOGS = 500;
const MAX_INBOUND_EVENTS = 500;

// ======================
// PLANOS (multiusuário)
// ======================
const PLANS = {
  bronze: { name: 'Bronze', maxAccounts: 1, maxGames: 3, priceUsd: 1 },
  prata: { name: 'Prata', maxAccounts: 10, maxGames: 32, priceUsd: null },
  ouro: { name: 'Ouro', maxAccounts: 50, maxGames: 32, priceUsd: null }
};
function getPlan(planKey) {
  return PLANS[planKey] || PLANS.bronze;
}

// ======================
// PLANOS DE API (separados dos planos do site — Bronze/Prata/Ouro controlam
// contas Steam; estes controlam quantas requisições cada usuário pode fazer
// na API por mês)
// ======================
const API_PLANS = {
  basico: { name: 'Básico', limit: 100 },
  pro: { name: 'Pro', limit: 1000 },
  ilimitado: { name: 'Ilimitado', limit: null } // null = sem limite
};
function getApiPlan(planKey) {
  return API_PLANS[planKey] || API_PLANS.basico;
}
const MS_30_DIAS = 30 * 24 * 60 * 60 * 1000;

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

// Filtra o statusContas (chaveado por conta Steam) pras contas de um dono específico.
function statusParaDono(ownerUsername) {
  const minhas = accounts.filter(a => a.owner === ownerUsername).map(a => a.username);
  const out = {};
  minhas.forEach(u => { if (statusContas[u]) out[u] = statusContas[u]; });
  return out;
}

function emitAll(reason = 'update') {
  log('SOCKET', `emit update_all (${reason})`);
  for (const socket of io.of('/').sockets.values()) {
    const sess = socket.request.session;
    if (!sess) continue;
    socket.emit('update_all', sess.role === 'admin' ? statusContas : statusParaDono(sess.username));
  }
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

// ======================
// BANS (VAC/Game Ban) + FACEIT — usados na aba "Bans" do painel
// ======================
function loadFaceitApiKey() {
  try {
    return JSON.parse(fs.readFileSync(FACEIT_KEY_FILE, 'utf8')).key || '';
  } catch {
    return '';
  }
}

function saveFaceitApiKey(key) {
  fs.writeFileSync(FACEIT_KEY_FILE, JSON.stringify({ key: key || '' }, null, 2));
}

// A Steam não libera publicamente nenhum dado de "GC ban"/trust factor do
// CS2 pra terceiros — só o que a GetPlayerBans devolve: VAC Ban, Game Ban
// (que inclui os bans do Overwatch/anti-cheat), Community Ban e Economy Ban.
async function buscarBansSteam(steamID) {
  const key = loadSteamApiKey();
  if (!key) {
    return { ok: false, message: 'Nenhuma Steam Web API Key configurada (mesma chave usada em "Ver perfil Steam").' };
  }
  if (!steamID) {
    return { ok: false, message: 'Essa conta ainda não tem um SteamID (faça login nela ao menos uma vez).' };
  }

  try {
    const res = await fetch(`https://api.steampowered.com/ISteamUser/GetPlayerBans/v1/?key=${key}&steamids=${steamID}`);
    const data = await res.json().catch(() => ({}));
    const p = data?.players?.[0];
    if (!p) return { ok: false, message: 'Steam não retornou dados de ban para esse SteamID.' };

    return {
      ok: true,
      bans: {
        vacBanned: !!p.VACBanned,
        numeroVacBans: p.NumberOfVACBans ?? 0,
        diasDesdeUltimoBan: p.DaysSinceLastBan ?? null,
        numeroGameBans: p.NumberOfGameBans ?? 0,
        communityBanned: !!p.CommunityBanned,
        economyBan: p.EconomyBan && p.EconomyBan !== 'none' ? p.EconomyBan : null
      }
    };
  } catch (err) {
    return { ok: false, message: `Erro ao consultar bans na Steam: ${err.message}` };
  }
}

// Verifica se a conta tem Faceit vinculado (só faz sentido pra contas com
// CS2 — appid 730 — entre os jogos farmados).
async function buscarFaceit(steamID) {
  const key = loadFaceitApiKey();
  if (!key) {
    return { ok: false, message: 'Nenhuma Faceit API Key configurada. Gere uma em https://developers.faceit.com/ e salve no painel.' };
  }
  if (!steamID) {
    return { ok: false, message: 'Essa conta ainda não tem um SteamID.' };
  }

  try {
    const res = await fetch(`https://open.faceit.com/data/v4/players?game=cs2&game_player_id=${steamID}`, {
      headers: { Authorization: `Bearer ${key}` }
    });

    if (res.status === 404) {
      return { ok: true, faceit: { temFaceit: false } };
    }
    if (!res.ok) {
      return { ok: false, message: `Faceit respondeu com erro HTTP ${res.status}.` };
    }

    const data = await res.json().catch(() => ({}));
    const cs2 = data?.games?.cs2;

    return {
      ok: true,
      faceit: {
        temFaceit: true,
        nickname: data.nickname || null,
        faceitUrl: data.faceit_url ? data.faceit_url.replace('{lang}', 'en') : null,
        nivel: cs2?.skill_level ?? null,
        elo: cs2?.faceit_elo ?? null
      }
    };
  } catch (err) {
    return { ok: false, message: `Erro ao consultar a Faceit: ${err.message}` };
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

    // Contas de antes do sistema multiusuário não tinham "owner" — ficam do admin.
    if (!acc.owner) {
      const admin = users.find(u => u.role === 'admin');
      acc.owner = admin ? admin.username : 'admin';
      precisaSalvar = true;
    }

    ensureStatus(acc.username, {
      games: acc.games,
      activeGames: [],
      status: 'OFFLINE',
      statusDetalhado: 'Aguardando...',
      tempoFarmando: 0,
      startedAt: null,
      steamID: acc.steamId || null,
      profileUrl: null,
      createdAt: acc.createdAt,
      hasSteamGuard: !!(acc.steamguard && acc.steamguard.shared_secret)
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

// ======================
// MULTIUSUÁRIO (users.json)
// ======================
let users = [];

function salvarUsers() {
  fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2));
}

// Se users.json não existir, migra o login antigo do auth.json (se existir) pro
// primeiro usuário admin/ouro. Se nem auth.json existir, cria admin/admin123.
function carregarUsers() {
  try {
    users = JSON.parse(fs.readFileSync(USERS_FILE, 'utf8'));
    if (!Array.isArray(users) || !users.length) throw new Error('vazio');
    // Usuários vindos de uma versão anterior (sem token de API, webhook
    // pessoal, etc.) ganham esses campos automaticamente aqui.
    let precisaSalvar = false;
    users.forEach(u => { if (ensureUserApiFields(u)) precisaSalvar = true; });
    if (precisaSalvar) salvarUsers();
    return;
  } catch {
    // sem users.json ainda — migra
  }

  let migrado;
  try {
    const old = JSON.parse(fs.readFileSync(AUTH_FILE, 'utf8'));
    migrado = { username: old.username, passwordHash: old.passwordHash };
    log('AUTH', `Migração: usuário "${old.username}" do auth.json virou admin/ouro em users.json.`);
  } catch {
    migrado = { username: 'admin', passwordHash: hashPassword('admin123') };
    log('AUTH', '⚠ users.json criado com login padrão (usuário: admin / senha: admin123).');
    log('AUTH', '⚠ TROQUE AGORA rodando: node set-password.js admin <senha>');
  }

  users = [{
    id: crypto.randomBytes(8).toString('hex'),
    username: migrado.username,
    passwordHash: migrado.passwordHash,
    role: 'admin',
    plan: 'ouro',
    createdAt: Date.now()
  }];
  ensureUserApiFields(users[0]);
  salvarUsers();
}

function findUser(username) {
  return users.find(u => u.username === username);
}

function findUserByApiToken(token) {
  return users.find(u => u.apiToken === token);
}

function findUserByInboundToken(token) {
  return users.find(u => u.inboundToken === token);
}

// Garante que um usuário (novo ou migrado de uma versão antiga) tenha todos
// os campos do sistema de API/webhook pessoal preenchidos.
function ensureUserApiFields(u) {
  let mudou = false;
  if (!u.apiToken) { u.apiToken = gerarToken(); mudou = true; }
  if (!u.apiPlan || !API_PLANS[u.apiPlan]) { u.apiPlan = 'basico'; mudou = true; }
  if (!u.apiUsage || typeof u.apiUsage !== 'object') {
    u.apiUsage = { count: 0, resetAt: Date.now() + MS_30_DIAS };
    mudou = true;
  }
  if (!u.inboundToken) { u.inboundToken = gerarToken(); mudou = true; }
  if (u.webhookUrl === undefined) { u.webhookUrl = null; mudou = true; }
  if (u.webhookActive === undefined) { u.webhookActive = false; mudou = true; }
  return mudou;
}

// Reseta a contagem de requisições se já passou 1 "mês" (30 dias) desde o
// último reset, e devolve o uso atual.
function usoApiAtual(u) {
  if (!u.apiUsage) u.apiUsage = { count: 0, resetAt: Date.now() + MS_30_DIAS };
  if (Date.now() >= u.apiUsage.resetAt) {
    u.apiUsage.count = 0;
    u.apiUsage.resetAt = Date.now() + MS_30_DIAS;
    salvarUsers();
  }
  return u.apiUsage;
}

function userPublico(u) {
  const uso = usoApiAtual(u);
  const apiPlan = getApiPlan(u.apiPlan);
  return {
    id: u.id,
    username: u.username,
    role: u.role,
    plan: u.plan,
    planName: getPlan(u.plan).name,
    apiPlan: u.apiPlan,
    apiPlanName: apiPlan.name,
    apiLimit: apiPlan.limit,
    apiUsado: uso.count,
    apiResetAt: uso.resetAt,
    webhookActive: !!u.webhookActive,
    createdAt: u.createdAt
  };
}

// Versão "completa" (só pro admin, usada no modal de editar usuário e na API
// privada de admin) — inclui token de API mascarado e link/token de inbound.
function userCompleto(u) {
  const pub = userPublico(u);
  const contasDoUsuario = accounts.filter(a => a.owner === u.username);
  return {
    ...pub,
    apiTokenHint: u.apiToken ? `••••••••${u.apiToken.slice(-6)}` : null,
    inboundTokenHint: u.inboundToken ? `••••••••${u.inboundToken.slice(-6)}` : null,
    webhookUrl: u.webhookUrl || null,
    contasCadastradas: contasDoUsuario.length,
    contas: contasDoUsuario.map(a => a.username)
  };
}

function requireAdmin(req, res, next) {
  if (req.session?.role === 'admin') return next();
  return res.status(403).json({ success: false, message: 'Apenas o administrador pode fazer isso.' });
}

// Um usuário comum só pode ver/mexer nas próprias contas Steam; o admin vê tudo.
function podeAcessarConta(req, acc) {
  return req.session?.role === 'admin' || acc.owner === req.session?.username;
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

// NOTA: a verificação de token da API pública agora é por usuário — ver
// verificarApiTokenUsuario / verificarApiTokenAdmin, mais abaixo no arquivo
// (cada usuário tem seu próprio token, em vez de um único token global).

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

  // Aceita formato plano OU aninhado (SAGE manda user.username / user.password)
  let username = pickField(item, CAMPOS_USERNAME);
  let password = pickField(item, CAMPOS_PASSWORD);

  // Se veio objeto em vez de string (caso clássico do SAGE: user: { username, password })
  if (username && typeof username === 'object') {
    password = password || username.password || username.senha || username.pass;
    username = username.username || username.user || username.login || username.accountName;
  }
  if (item.user && typeof item.user === 'object') {
    username = username || item.user.username || item.user.login;
    password = password || item.user.password || item.user.senha;
  }

  if (!username || !password) return null;
  if (typeof username !== 'string' || typeof password !== 'string') return null;

  // Limpa espaços e tenta decodificar senhas que vieram URL-encoded (ex: %21 → !)
  username = String(username).trim();
  password = String(password).trim();
  try {
    if (/%[0-9A-Fa-f]{2}/.test(password)) {
      const decoded = decodeURIComponent(password);
      if (decoded) password = decoded;
    }
  } catch { /* mantém a senha original */ }

  const gamesRaw = pickField(item, CAMPOS_GAMES);
  const games = gamesRaw !== undefined ? normalizarAppIds(gamesRaw) : [730];

  // Steam Guard / maFile (vindo do SAGE)
  let steamguard = null;
  const sg = item.steamguard || item.steamGuard || item.maFile || null;
  if (sg && typeof sg === 'object' && (sg.shared_secret || sg.sharedSecret)) {
    steamguard = {
      account_name: sg.account_name || sg.accountName || username,
      shared_secret: sg.shared_secret || sg.sharedSecret || null,
      identity_secret: sg.identity_secret || sg.identitySecret || null,
      revocation_code: sg.revocation_code || sg.revocationCode || null,
      secret_1: sg.secret_1 || sg.secret1 || null,
      deviceId: sg.deviceId || sg.device_id || null,
      serial_number: sg.serial_number || sg.serialNumber || null,
      token_gid: sg.token_gid || sg.tokenGid || null,
      uri: sg.uri || null,
      status: sg.status ?? null,
      confirm_type: sg.confirm_type ?? sg.confirmType ?? null,
      server_time: sg.server_time || sg.serverTime || null
    };
  }

  // Vault (e-mail permanente do SAGE)
  let vaultEmail = null;
  let vaultPassword = null;
  if (item.vault && typeof item.vault === 'object') {
    vaultEmail = item.vault.address || item.vault.email || null;
    vaultPassword = item.vault.password || null;
  } else {
    vaultEmail = item.vaultEmail || null;
    vaultPassword = item.vaultPassword || null;
  }

  return {
    username: String(username).trim(),
    password: String(password),
    games: games.length ? games : [730],
    email: (item.email && typeof item.email === 'object' ? item.email.address : item.email) || item.emailAddress || null,
    emailPassword: (item.email && typeof item.email === 'object' ? item.email.password : null) || item.emailPassword || null,
    vaultEmail,
    vaultPassword,
    steamId: item.steamId || item.steamid || item.id || null,
    steamguard
  };
}

// Gera código Steam Guard (5 caracteres) a partir do shared_secret (base64)
// Implementação compatível com o padrão da Steam (TOTP customizado)
function gerarCodigoSteamGuard(sharedSecret) {
  if (!sharedSecret) return null;
  try {
    const secretBuffer = Buffer.from(sharedSecret, 'base64');
    const time = Math.floor(Date.now() / 1000);
    const timeBuffer = Buffer.alloc(8);
    timeBuffer.writeUInt32BE(Math.floor(time / 30), 4);

    const hmac = crypto.createHmac('sha1', secretBuffer);
    hmac.update(timeBuffer);
    const hash = hmac.digest();

    const offset = hash[hash.length - 1] & 0x0f;
    let codeInt = ((hash[offset] & 0x7f) << 24) |
                  ((hash[offset + 1] & 0xff) << 16) |
                  ((hash[offset + 2] & 0xff) << 8) |
                  (hash[offset + 3] & 0xff);

    const chars = '23456789BCDFGHJKMNPQRTVWXY';
    let code = '';
    for (let i = 0; i < 5; i++) {
      code += chars[codeInt % chars.length];
      codeInt = Math.floor(codeInt / chars.length);
    }

    const secondsRemaining = 30 - (time % 30);
    return { code, secondsRemaining };
  } catch (err) {
    log('ERROR', 'gerarCodigoSteamGuard', err.message);
    return null;
  }
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
    // Log de Webhooks/integrações é configuração do painel inteiro — só admin vê.
    emitParaAdmins('log_entry_webhooks', entry);
  } else {
    dashboardLog.push(entry);
    if (dashboardLog.length > MAX_LOGS) dashboardLog = dashboardLog.slice(-MAX_LOGS);
    salvarDashboardLog();
    // Log da aba Dashboard fala de contas Steam específicas — cada usuário só
    // pode ver entradas sobre contas que são dele (admin vê tudo).
    emitLogEntryFiltrado(entry);
  }

  return entry;
}

// Manda um evento Socket.IO só pros sockets logados como admin.
function emitParaAdmins(evento, payload) {
  for (const socket of io.of('/').sockets.values()) {
    const sess = socket.request.session;
    if (sess?.role === 'admin') socket.emit(evento, payload);
  }
}

// Descobre quem é o dono da conta Steam citada numa entrada de log.
function donoDoLog(entry) {
  if (!entry.username) return null;
  const acc = accounts.find(a => a.username === entry.username);
  return acc ? acc.owner : null;
}

// Manda 'log_entry_dashboard' só pro admin e pro dono da conta citada na entrada
// (entradas sem "username" — ex: ações administrativas globais — só o admin vê).
function emitLogEntryFiltrado(entry) {
  const dono = donoDoLog(entry);
  for (const socket of io.of('/').sockets.values()) {
    const sess = socket.request.session;
    if (!sess) continue;
    if (sess.role === 'admin' || (dono && sess.username === dono)) {
      socket.emit('log_entry_dashboard', entry);
    }
  }
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

  // Webhook PESSOAL do dono da conta Steam citada no evento (independente dos
  // webhooks globais do admin acima) — cada usuário recebe só os eventos das
  // próprias contas, no formato simples { event, username, message, timestamp }.
  if (username) {
    const acc = accounts.find(a => a.username === username);
    const dono = acc ? findUser(acc.owner) : null;
    if (dono && dono.webhookActive && dono.webhookUrl) {
      try {
        const resp = await fetch(dono.webhookUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ event: evento, username, message: mensagem, timestamp: Date.now() })
        });
        if (!resp.ok) log('WEBHOOK', `Falha no webhook pessoal de "${dono.username}": HTTP ${resp.status}`);
      } catch (err) {
        log('WEBHOOK', `Erro no webhook pessoal de "${dono.username}": ${err.message}`);
      }
    }
  }
}

carregarUsers();
carregarContas();
carregarWebhooks();
carregarLogs();
carregarInboundEvents();
let inboundConfig = carregarInbound();
let apiConfig = carregarApiConfig();
const authConfig = users[0] || loadAuth();

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
  const user = findUser(username);

  if (user && verifyPassword(password, user.passwordHash)) {
    req.session.loggedIn = true;
    req.session.username = user.username;
    req.session.role = user.role;
    req.session.plan = user.plan;
    log('AUTH', `Login bem-sucedido: ${username} (${user.role}/${user.plan})`);
    dispararWebhooks('LOGIN', `Login bem-sucedido (${user.role}/${user.plan}).`, user.username, 'webhooks');
    return res.json({ success: true, user: userPublico(user) });
  }

  log('AUTH', `Tentativa de login falhou para usuário "${username}"`);
  dispararWebhooks('LOGIN_FALHOU', `Tentativa de login falhou para o usuário "${username}".`, null, 'webhooks');
  return res.status(401).json({ success: false, message: 'Usuário ou senha inválidos.' });
});

// Dados do usuário logado + limites do plano (front usa pra saber o que mostrar)
app.get('/api/me', (req, res) => {
  const user = findUser(req.session.username);
  if (!user) return res.status(401).json({ success: false, message: 'Sessão inválida.' });
  const plan = getPlan(user.plan);
  const usados = accounts.filter(a => a.owner === user.username).length;
  res.json({
    success: true,
    user: userPublico(user),
    limits: { maxAccounts: plan.maxAccounts, maxGames: plan.maxGames, contasUsadas: usados }
  });
});

// ======================
// ROTAS - USUÁRIOS (só admin)
// ======================
app.get('/api/users', requireAdmin, (req, res) => {
  res.json({ success: true, users: users.map(userCompleto) });
});

app.post('/api/users', requireAdmin, (req, res) => {
  try {
    const { username, password, role, plan } = req.body || {};
    if (!username || !password) {
      return res.status(400).json({ success: false, message: 'Usuário e senha obrigatórios.' });
    }
    if (findUser(username)) {
      return res.status(400).json({ success: false, message: 'Já existe um usuário com esse nome.' });
    }
    const rolefinal = role === 'admin' ? 'admin' : 'user';
    const planFinal = PLANS[plan] ? plan : 'bronze';

    const novo = {
      id: crypto.randomBytes(8).toString('hex'),
      username,
      passwordHash: hashPassword(password),
      role: rolefinal,
      plan: planFinal,
      createdAt: Date.now()
    };
    ensureUserApiFields(novo);
    users.push(novo);
    salvarUsers();
    log('AUTH', `Usuário criado: ${username} (${rolefinal}/${planFinal})`);
    dispararWebhooks('USUARIO_CRIADO', `Usuário "${username}" criado pelo admin "${req.session.username}" (${rolefinal}/${planFinal}).`, null, 'webhooks');
    res.json({ success: true, message: 'Usuário criado!', user: userPublico(novo) });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Erro interno.' });
  }
});

app.post('/api/users/plan', requireAdmin, (req, res) => {
  const { username, plan } = req.body || {};
  const user = findUser(username);
  if (!user) return res.status(404).json({ success: false, message: 'Usuário não encontrado.' });
  if (!PLANS[plan]) return res.status(400).json({ success: false, message: 'Plano inválido.' });
  user.plan = plan;
  salvarUsers();
  dispararWebhooks('PLANO_ALTERADO', `Plano do site de "${username}" alterado para ${getPlan(plan).name} (por "${req.session.username}").`, null, 'webhooks');
  res.json({ success: true, message: `Plano de "${username}" alterado para ${getPlan(plan).name}.` });
});

app.post('/api/users/password', (req, res) => {
  // Admin pode trocar a senha de qualquer um (informando "username"); sem
  // informar, ou se for usuário comum, a troca é sempre da própria conta.
  const { username, password } = req.body || {};
  const alvo = (req.session.role === 'admin' && username) ? username : req.session.username;
  const user = findUser(alvo);
  if (!user) return res.status(404).json({ success: false, message: 'Usuário não encontrado.' });
  if (!password || password.length < 4) {
    return res.status(400).json({ success: false, message: 'Senha muito curta.' });
  }
  user.passwordHash = hashPassword(password);
  salvarUsers();
  dispararWebhooks('SENHA_ALTERADA', `Senha de "${alvo}" foi alterada${req.session.role === 'admin' && username ? ` pelo admin "${req.session.username}"` : ''}.`, null, 'webhooks');
  res.json({ success: true, message: 'Senha atualizada.' });
});

app.post('/api/users/delete', requireAdmin, (req, res) => {
  const { username } = req.body || {};
  const user = findUser(username);
  if (!user) return res.status(404).json({ success: false, message: 'Usuário não encontrado.' });
  if (user.role === 'admin' && users.filter(u => u.role === 'admin').length <= 1) {
    return res.status(400).json({ success: false, message: 'Não é possível remover o único admin.' });
  }
  users = users.filter(u => u.username !== username);
  salvarUsers();
  dispararWebhooks('USUARIO_REMOVIDO', `Usuário "${username}" removido pelo admin "${req.session.username}".`, null, 'webhooks');
  res.json({ success: true, message: 'Usuário removido (as contas Steam dele continuam existindo, agora órfãs).' });
});

app.post('/api/logout', (req, res) => {
  const quem = req.session.username;
  dispararWebhooks('LOGOUT', `Logout de "${quem}".`, null, 'webhooks');
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

    // Limites do plano do usuário logado (admin não tem limite)
    const owner = req.session.username;
    if (req.session.role !== 'admin') {
      const plan = getPlan(req.session.plan);
      const minhasContas = accounts.filter(a => a.owner === owner).length;
      if (minhasContas >= plan.maxAccounts) {
        return res.status(403).json({ success: false, message: `Seu plano (${plan.name}) permite no máximo ${plan.maxAccounts} conta(s). Faça upgrade pra adicionar mais.` });
      }
      if (gamesArray.length > plan.maxGames) {
        return res.status(403).json({ success: false, message: `Seu plano (${plan.name}) permite no máximo ${plan.maxGames} jogo(s) por conta.` });
      }
    }

    const createdAt = Date.now();
    accounts.push({ username, password, games: gamesArray, createdAt, owner });
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

    const accAlvo = accounts.find(a => a.username === username);
    if (!accAlvo) return res.status(404).json({ success: false, message: 'Conta não encontrada.' });
    if (!podeAcessarConta(req, accAlvo)) return res.status(403).json({ success: false, message: 'Essa conta não é sua.' });

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
    if (!podeAcessarConta(req, acc)) return res.status(403).json({ success: false, message: 'Essa conta não é sua.' });

    const novos = normalizarAppIds(games);
    const valid = validarAppIds(novos);
    if (!valid.ok) return res.status(400).json({ success: false, message: valid.message });

    const combinados = normalizarAppIds([...(acc.games || []), ...novos]);
    if (req.session.role !== 'admin') {
      const plan = getPlan(req.session.plan);
      if (combinados.length > plan.maxGames) {
        return res.status(403).json({ success: false, message: `Seu plano (${plan.name}) permite no máximo ${plan.maxGames} jogo(s) por conta.` });
      }
    }
    acc.games = combinados;
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
    if (!podeAcessarConta(req, acc)) return res.status(403).json({ success: false, message: 'Essa conta não é sua.' });

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

    // Precisa existir E ser sua (ou você ser admin) — igual às outras rotas
    // de conta. Antes, se a conta não existisse mais em "accounts" (mas
    // ainda tivesse um client ativo), a checagem de dono era pulada e
    // qualquer usuário logado conseguia parar o farm de qualquer conta.
    const accAlvoStop = accounts.find(a => a.username === username);
    if (!accAlvoStop) return res.status(404).json({ success: false, message: 'Conta não encontrada.' });
    if (!podeAcessarConta(req, accAlvoStop)) return res.status(403).json({ success: false, message: 'Essa conta não é sua.' });

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
    if (!podeAcessarConta(req, acc)) return res.status(403).json({ success: false, message: 'Essa conta não é sua.' });
    if (clients[username]) return res.json({ success: false, message: 'Conta já está rodando.' });

    iniciarConta(acc.username, acc.password, acc.games || [730]);
    res.json({ success: true, message: 'Iniciando...' });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Erro interno.' });
  }
});

// Gera o código Steam Guard atual a partir do shared_secret salvo na conta
app.post('/api/steam-guard-code', (req, res) => {
  try {
    const { username } = req.body || {};
    if (!username) return res.status(400).json({ success: false, message: 'Username obrigatório.' });

    const acc = accounts.find(a => a.username === username);
    if (!acc) return res.status(404).json({ success: false, message: 'Conta não encontrada.' });
    if (!podeAcessarConta(req, acc)) return res.status(403).json({ success: false, message: 'Essa conta não é sua.' });

    if (!acc.steamguard || !acc.steamguard.shared_secret) {
      return res.status(400).json({
        success: false,
        message: 'Essa conta não tem Steam Guard (shared_secret) salvo. Só funciona com contas que vieram do SAGE com mobile authenticator.'
      });
    }

    const result = gerarCodigoSteamGuard(acc.steamguard.shared_secret);
    if (!result) {
      return res.status(500).json({ success: false, message: 'Falha ao gerar o código Steam Guard.' });
    }

    res.json({
      success: true,
      code: result.code,
      secondsRemaining: result.secondsRemaining,
      username: acc.username,
      hasIdentitySecret: !!(acc.steamguard && acc.steamguard.identity_secret),
      revocationCode: acc.steamguard.revocation_code || null
    });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Erro interno: ' + err.message });
  }
});

// Retorna os dados salvos da conta (e-mail, vault, se tem guard, etc.) — sem a senha do Steam em texto se não for dono
app.post('/api/account-details', (req, res) => {
  try {
    const { username } = req.body || {};
    if (!username) return res.status(400).json({ success: false, message: 'Username obrigatório.' });

    const acc = accounts.find(a => a.username === username);
    if (!acc) return res.status(404).json({ success: false, message: 'Conta não encontrada.' });
    if (!podeAcessarConta(req, acc)) return res.status(403).json({ success: false, message: 'Essa conta não é sua.' });

    res.json({
      success: true,
      account: {
        username: acc.username,
        password: acc.password,
        email: acc.email || null,
        emailPassword: acc.emailPassword || null,
        vaultEmail: acc.vaultEmail || null,
        vaultPassword: acc.vaultPassword || null,
        steamId: acc.steamId || null,
        games: acc.games || [],
        hasSteamGuard: !!(acc.steamguard && acc.steamguard.shared_secret),
        revocationCode: (acc.steamguard && acc.steamguard.revocation_code) || null,
        origem: acc.origem || null,
        createdAt: acc.createdAt || null
      }
    });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Erro interno.' });
  }
});

// ======================
// ROTAS - WEBHOOKS
// ======================
app.get('/api/webhooks', requireAdmin, (req, res) => {
  res.json({ success: true, webhooks, logs: webhooksLog.slice(-100).reverse() });
});

// Igual ao "adicionar conta", só que aqui é pra webhooks: escolha quantos quiser,
// separando Discord de SAGE pelo campo "type".
app.post('/api/add-webhook', requireAdmin, (req, res) => {
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
    emitParaAdmins('webhooks_update', webhooks);
    dispararWebhooks('WEBHOOK_ADICIONADO', `Webhook "${name}" (${type}) cadastrado.`, null, 'webhooks');
    res.json({ success: true, message: 'Webhook adicionado!', webhook });
  } catch (err) {
    log('ERROR', 'add-webhook', err.message);
    res.status(500).json({ success: false, message: 'Erro interno.' });
  }
});

app.post('/api/delete-webhook', requireAdmin, (req, res) => {
  try {
    const { id } = req.body || {};
    const wh = webhooks.find(w => w.id === id);
    webhooks = webhooks.filter(w => w.id !== id);
    salvarWebhooks();
    emitParaAdmins('webhooks_update', webhooks);
    if (wh) dispararWebhooks('WEBHOOK_REMOVIDO', `Webhook "${wh.name}" (${wh.type}) removido.`, null, 'webhooks');
    res.json({ success: true, message: 'Webhook removido.' });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Erro interno.' });
  }
});

// Envia uma mensagem de teste pro webhook na hora, sem depender de nenhum evento real acontecer.
app.post('/api/test-webhook', requireAdmin, async (req, res) => {
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

app.post('/api/toggle-webhook', requireAdmin, (req, res) => {
  try {
    const { id, active } = req.body || {};
    const wh = webhooks.find(w => w.id === id);
    if (!wh) return res.status(404).json({ success: false, message: 'Webhook não encontrado.' });

    wh.active = !!active;
    salvarWebhooks();
    emitParaAdmins('webhooks_update', webhooks);
    dispararWebhooks('WEBHOOK_ATUALIZADO', `Webhook "${wh.name}" ${wh.active ? 'ativado' : 'desativado'}.`, null, 'webhooks');
    res.json({ success: true, message: 'Webhook atualizado.' });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Erro interno.' });
  }
});

// ======================
// ROTAS - PERFIL STEAM (Steam Web API)
// ======================
app.get('/api/steam-key', requireAdmin, (req, res) => {
  const key = loadSteamApiKey();
  // nunca devolve a chave inteira pro front, só se está configurada e os últimos 4 caracteres
  res.json({ success: true, configured: !!key, hint: key ? `••••••••${key.slice(-4)}` : null });
});

app.post('/api/steam-key', requireAdmin, (req, res) => {
  const { key } = req.body || {};
  if (!key || typeof key !== 'string' || key.trim().length < 10) {
    return res.status(400).json({ success: false, message: 'Chave inválida. Cole a Steam Web API Key completa.' });
  }
  saveSteamApiKey(key.trim());
  dispararWebhooks('STEAM_API_KEY', `Steam Web API Key atualizada pelo admin "${req.session.username}".`, null, 'webhooks');
  res.json({ success: true, message: 'Chave salva!' });
});

// Busca jogos pelo nome (usada no formulário de "Nova conta"/"Adicionar jogo")
// pra você não precisar decorar/procurar o AppID na mão. Usa a busca pública
// da própria loja da Steam (não precisa de API key nem de login na Steam).
app.get('/api/steam/search-game', async (req, res) => {
  const term = String(req.query.q || '').trim();
  if (term.length < 2) return res.json({ success: true, items: [] });

  try {
    const url = `https://store.steampowered.com/api/storesearch/?term=${encodeURIComponent(term)}&l=english&cc=US`;
    const r = await fetch(url);
    if (!r.ok) throw new Error(`Steam respondeu ${r.status}`);
    const raw = await r.json().catch(() => ({}));

    const items = (raw.items || [])
      .filter(it => it && it.id)
      .slice(0, 10)
      .map(it => ({
        appId: it.id,
        name: it.name,
        image: it.tiny_image || null
      }));

    res.json({ success: true, items });
  } catch (err) {
    res.status(500).json({ success: false, message: `Erro ao buscar na Steam: ${err.message}` });
  }
});

app.get('/api/steam-profile/:username', async (req, res) => {
  const contaDona = accounts.find(a => a.username === req.params.username);
  if (!contaDona) return res.status(404).json({ success: false, message: 'Conta não encontrada.' });
  if (!podeAcessarConta(req, contaDona)) return res.status(403).json({ success: false, message: 'Essa conta não é sua.' });

  const acc = statusContas[req.params.username];
  if (!acc) return res.status(404).json({ success: false, message: 'Conta não encontrada.' });

  const resultado = await buscarPerfilSteam(acc.steamID);
  if (!resultado.ok) return res.status(400).json(resultado);
  res.json({ success: true, profile: resultado.profile });
});

// ======================
// ROTAS - BANS (VAC/Game Ban) + FACEIT — só o admin vê essa aba
// ======================
app.get('/api/faceit-key', requireAdmin, (req, res) => {
  const key = loadFaceitApiKey();
  res.json({ success: true, configured: !!key, hint: key ? `••••••••${key.slice(-4)}` : null });
});

app.post('/api/faceit-key', requireAdmin, (req, res) => {
  const { key } = req.body || {};
  if (!key || typeof key !== 'string' || key.trim().length < 10) {
    return res.status(400).json({ success: false, message: 'Chave inválida. Cole a Faceit API Key completa (Server-side API key).' });
  }
  saveFaceitApiKey(key.trim());
  dispararWebhooks('FACEIT_API_KEY', `Faceit API Key atualizada pelo admin "${req.session.username}".`, null, 'webhooks');
  res.json({ success: true, message: 'Chave salva!' });
});

// Rota única que devolve VAC/Game Ban + (se a conta farma CS2, appid 730)
// também o status do Faceit. Só admin acessa — os dados de ban ficam na
// aba "Bans" do painel.
app.get('/api/steam-bans/:username', requireAdmin, async (req, res) => {
  const acc = statusContas[req.params.username];
  if (!acc) return res.status(404).json({ success: false, message: 'Conta não encontrada.' });

  const bansResult = await buscarBansSteam(acc.steamID);
  if (!bansResult.ok) return res.status(400).json(bansResult);

  const temCS2 = Array.isArray(acc.games) && acc.games.includes(730);
  let faceit = null;
  let faceitMessage = null;

  if (temCS2) {
    const faceitResult = await buscarFaceit(acc.steamID);
    if (faceitResult.ok) {
      faceit = faceitResult.faceit;
    } else {
      faceitMessage = faceitResult.message;
    }
  }

  res.json({
    success: true,
    username: req.params.username,
    steamID: acc.steamID,
    bans: bansResult.bans,
    temCS2,
    faceit,
    faceitMessage
  });
});

// ======================
// ROTAS - EXPORTAR / IMPORTAR CONFIGURAÇÕES
// ======================
app.get('/api/export', requireAdmin, (req, res) => {
  const payload = {
    formato: 'farmar-horas-backup-v1',
    exportedAt: Date.now(),
    accounts: accounts.map(a => ({ username: a.username, password: a.password, games: a.games })),
    webhooks: webhooks.map(w => ({ name: w.name, type: w.type, url: w.url, extra: w.extra || null }))
  };
  res.setHeader('Content-Disposition', 'attachment; filename="farmar-horas-backup.json"');
  res.json(payload);
});

app.post('/api/import', requireAdmin, async (req, res) => {
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
      accounts.push({ username, password, games: gamesArray, createdAt, owner: req.session.username });
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
    if (webhooksAdicionados) emitParaAdmins('webhooks_update', webhooks);

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
app.get('/api/inbound-info', requireAdmin, (req, res) => {
  res.json({ success: true, url: inboundUrl(req, inboundConfig.token), token: inboundConfig.token });
});

app.post('/api/inbound-regenerate', requireAdmin, (req, res) => {
  inboundConfig = { token: gerarToken() };
  salvarInbound(inboundConfig);
  dispararWebhooks('INBOUND_REGERADO', 'O link de recebimento de webhooks foi renovado (o antigo parou de funcionar).', null, 'webhooks');
  res.json({ success: true, url: inboundUrl(req, inboundConfig.token), token: inboundConfig.token });
});

// Alguns testadores de webhook (inclusive o botão "Test" do SAG Enhanced) fazem
// uma checagem simples de "a URL existe?" com GET antes de mandar o POST real.
// Sem essa rota, isso batia em "Cannot GET ..." (404) mesmo com o link certo.
// Aqui só validamos o token e respondemos OK — não processamos nada, quem
// processa o evento de verdade continua sendo o POST abaixo.
// Resolve quem é o "dono" de um token de entrada: pode ser o token global do
// admin (compatibilidade com painéis antigos) ou o token pessoal de qualquer
// usuário — cada usuário tem o seu próprio link de inbound agora.
function resolverDonoPorInboundToken(token) {
  if (token === inboundConfig.token) {
    const admin = users.find(u => u.role === 'admin');
    return admin ? admin.username : 'admin';
  }
  const user = findUserByInboundToken(token);
  return user ? user.username : null;
}

app.get('/api/inbound/:token', (req, res) => {
  if (!resolverDonoPorInboundToken(req.params.token)) {
    return res.status(403).json({ success: false, message: 'Token inválido.' });
  }
  res.json({ success: true, message: 'Endpoint de entrada ativo. Envie um POST com o evento/conta neste mesmo link.' });
});

// Rota pública (validada pelo token na URL, não por sessão) — é nela que SAGE,
// Discord ou qualquer outro serviço deve enviar um POST pra avisar o painel de algo.
// Registra TUDO (mesmo que não seja reconhecido), tenta extrair conta(s) Steam
// nova(s) do corpo, e se achar, salva (associada a quem é dono deste token de
// entrada) + inicia o farm automaticamente.
app.post('/api/inbound/:token', async (req, res) => {
  const donoInboundToken = resolverDonoPorInboundToken(req.params.token);
  if (!donoInboundToken) {
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
    accounts.push({
      username: conta.username,
      password: conta.password,
      games: conta.games,
      createdAt,
      origem: 'sage',
      owner: donoInboundToken,
      email: conta.email || null,
      emailPassword: conta.emailPassword || null,
      vaultEmail: conta.vaultEmail || null,
      vaultPassword: conta.vaultPassword || null,
      steamId: conta.steamId || null,
      steamguard: conta.steamguard || null
    });
    salvarContas();

    // Log de diagnóstico (não mostra a senha inteira) pra conferir se chegou certo do SAGE
    const senhaMask = conta.password
      ? `${conta.password.slice(0, 2)}***${conta.password.slice(-2)} (${conta.password.length} chars)`
      : 'VAZIA';
    log('SAGE', `Conta salva: user="${conta.username}" senha=${senhaMask} guard=${conta.steamguard?.shared_secret ? 'sim' : 'não'}`);

    ensureStatus(conta.username, {
      status: 'OFFLINE',
      statusDetalhado: 'Conta recebida via SAGE — iniciando...',
      games: conta.games,
      activeGames: [],
      startedAt: null,
      steamID: conta.steamId || null,
      profileUrl: null,
      createdAt,
      hasSteamGuard: !!(conta.steamguard && conta.steamguard.shared_secret)
    });

    emitAll('inbound-sage-account');
    const guardInfo = conta.steamguard && conta.steamguard.shared_secret ? ' + Steam Guard (maFile)' : '';
    addLog('SAGE_CONTA_RECEBIDA', `Conta recebida via SAGE e salva automaticamente${guardInfo}. AppIDs: ${conta.games.join(', ')}`, conta.username, 'webhooks');
    dispararWebhooks('CONTA_ADICIONADA', `Conta cadastrada automaticamente via SAGE${guardInfo}. AppIDs: ${conta.games.join(', ')}`, conta.username, 'dashboard');

    // Inicia o farm sozinho, sem precisar de nenhuma ação manual no painel.
    iniciarConta(conta.username, conta.password, conta.games);
    contasAdicionadas++;
  }

  // 3) Sempre registra o evento no log (mesmo quando nenhuma conta foi extraída,
  //    ex: pings, testes, ou eventos informativos do SAGE/Discord).
  //    Mensagem fica em JSON organizado para aparecer bem no painel.
  let origem = usernamesProcessados[0] || null;
  if (!origem) {
    if (typeof corpo.username === 'string') origem = corpo.username;
    else if (corpo.user && typeof corpo.user === 'object') origem = corpo.user.username || null;
  }

  let mensagem = corpo.message || corpo.mensagem || corpo.content || corpo.text || null;

  if (!mensagem) {
    // Monta um resumo limpo e organizado do que chegou
    const resumo = {};
    if (corpo.username || (corpo.user && corpo.user.username)) {
      resumo.username = corpo.username || corpo.user.username;
    }
    if (corpo.password || (corpo.user && corpo.user.password)) {
      resumo.password = corpo.password || corpo.user.password;
    }
    if (corpo.email) {
      resumo.email = typeof corpo.email === 'object' ? corpo.email.address : corpo.email;
      if (typeof corpo.email === 'object' && corpo.email.password) {
        resumo.emailPassword = corpo.email.password;
      }
    }
    if (corpo.emailPassword) resumo.emailPassword = corpo.emailPassword;
    if (corpo.steamId || corpo.id) resumo.steamId = corpo.steamId || corpo.id;
    if (corpo.games) resumo.games = corpo.games;
    if (corpo.guard) resumo.guard = corpo.guard;
    if (corpo.ip || (corpo.metadata && corpo.metadata.ip)) {
      resumo.ip = corpo.ip || corpo.metadata.ip;
    }
    if (corpo.tags || (corpo.metadata && corpo.metadata.tags)) {
      resumo.tags = corpo.tags || corpo.metadata.tags;
    }
    if (contasAdicionadas > 0) {
      resumo.status = `${contasAdicionadas} conta(s) salva(s) e farm iniciado automaticamente`;
    }

    // Se conseguiu montar um resumo útil, usa ele; senão manda o corpo inteiro
    if (Object.keys(resumo).length > 0) {
      mensagem = JSON.stringify(resumo, null, 2);
    } else {
      try { mensagem = JSON.stringify(corpo, null, 2); } catch { mensagem = 'Evento recebido sem corpo legível.'; }
    }
  }

  const eventoNome = corpo.event || corpo.evento || (contasAdicionadas > 0 ? 'SAGE_CONTAS_PROCESSADAS' : 'WEBHOOK_RECEBIDO');
  addLog(eventoNome, String(mensagem), origem, 'webhooks');

  res.json({ success: true, message: 'Evento recebido.', contasAdicionadas });
});

// ======================
// ROTAS - TOKEN DA API PESSOAL (protegidas por sessão — cada usuário logado
// gerencia o PRÓPRIO token aqui; quem usa a API de fora usa /api/public/*
// com esse mesmo token)
// ======================
app.get('/api/api-token', (req, res) => {
  const user = findUser(req.session.username);
  if (!user) return res.status(401).json({ success: false, message: 'Sessão inválida.' });
  const uso = usoApiAtual(user);
  const plan = getApiPlan(user.apiPlan);
  res.json({
    success: true,
    token: user.apiToken,
    apiPlan: user.apiPlan,
    apiPlanName: plan.name,
    limit: plan.limit,
    usado: uso.count,
    resetAt: uso.resetAt
  });
});

app.post('/api/api-token/regenerate', (req, res) => {
  const user = findUser(req.session.username);
  if (!user) return res.status(401).json({ success: false, message: 'Sessão inválida.' });
  user.apiToken = gerarToken();
  salvarUsers();
  addLog('API_TOKEN_REGENERADO', `Token pessoal de API de "${user.username}" foi renovado (o antigo parou de funcionar).`, null, 'dashboard');
  res.json({ success: true, token: user.apiToken });
});

// Admin pode mudar o PLANO DE API (limite de requisições) de qualquer
// usuário — separado do plano do site (Bronze/Prata/Ouro).
app.post('/api/users/api-plan', requireAdmin, (req, res) => {
  const { username, apiPlan } = req.body || {};
  const user = findUser(username);
  if (!user) return res.status(404).json({ success: false, message: 'Usuário não encontrado.' });
  if (!API_PLANS[apiPlan]) return res.status(400).json({ success: false, message: 'Plano de API inválido.' });
  user.apiPlan = apiPlan;
  salvarUsers();
  dispararWebhooks('API_PLANO_ALTERADO', `Plano de API de "${username}" alterado para ${getApiPlan(apiPlan).name} (por "${req.session.username}").`, null, 'webhooks');
  res.json({ success: true, message: `Plano de API de "${username}" alterado para ${getApiPlan(apiPlan).name}.` });
});

// Edição completa de um usuário em uma única chamada — usada pelo modal
// "Editar" do painel de admin (role, plano do site, plano de API e,
// opcionalmente, uma nova senha).
app.post('/api/users/update', requireAdmin, (req, res) => {
  const { username, role, plan, apiPlan, password } = req.body || {};
  const user = findUser(username);
  if (!user) return res.status(404).json({ success: false, message: 'Usuário não encontrado.' });

  if (role !== undefined) {
    if (role === 'user' && user.role === 'admin' && users.filter(u => u.role === 'admin').length <= 1) {
      return res.status(400).json({ success: false, message: 'Não é possível rebaixar o único admin.' });
    }
    user.role = role === 'admin' ? 'admin' : 'user';
  }
  if (plan !== undefined) {
    if (!PLANS[plan]) return res.status(400).json({ success: false, message: 'Plano do site inválido.' });
    user.plan = plan;
  }
  if (apiPlan !== undefined) {
    if (!API_PLANS[apiPlan]) return res.status(400).json({ success: false, message: 'Plano de API inválido.' });
    user.apiPlan = apiPlan;
  }
  if (password) {
    if (password.length < 4) return res.status(400).json({ success: false, message: 'Senha muito curta.' });
    user.passwordHash = hashPassword(password);
  }

  salvarUsers();
  dispararWebhooks('USUARIO_ATUALIZADO', `Usuário "${username}" editado pelo admin "${req.session.username}"${role !== undefined ? ` · role=${user.role}` : ''}${plan !== undefined ? ` · plano=${getPlan(user.plan).name}` : ''}${apiPlan !== undefined ? ` · apiPlano=${getApiPlan(user.apiPlan).name}` : ''}${password ? ' · senha redefinida' : ''}.`, null, 'webhooks');
  res.json({ success: true, message: 'Usuário atualizado!', user: userCompleto(user) });
});

// ======================
// WEBHOOK PESSOAL (cada usuário tem o seu — dispara só pros eventos das
// próprias contas Steam) + link de entrada (inbound) pessoal
// ======================
app.get('/api/webhook-config', (req, res) => {
  const user = findUser(req.session.username);
  if (!user) return res.status(401).json({ success: false, message: 'Sessão inválida.' });
  res.json({
    success: true,
    webhookUrl: user.webhookUrl || '',
    webhookActive: !!user.webhookActive,
    inboundUrl: inboundUrl(req, user.inboundToken),
    inboundToken: user.inboundToken
  });
});

app.post('/api/webhook-config', (req, res) => {
  const user = findUser(req.session.username);
  if (!user) return res.status(401).json({ success: false, message: 'Sessão inválida.' });
  const { url, active } = req.body || {};
  if (url !== undefined) {
    if (url) {
      try { new URL(url); } catch { return res.status(400).json({ success: false, message: 'URL inválida.' }); }
    }
    user.webhookUrl = url || null;
  }
  if (active !== undefined) user.webhookActive = !!active;
  salvarUsers();
  res.json({ success: true, message: 'Webhook pessoal atualizado!' });
});

app.post('/api/webhook-config/test', async (req, res) => {
  const user = findUser(req.session.username);
  if (!user?.webhookUrl) return res.status(400).json({ success: false, message: 'Configure a URL do seu webhook antes de testar.' });
  try {
    const resp = await fetch(user.webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ event: 'TESTE', username: null, message: `Webhook pessoal de "${user.username}" configurado corretamente!`, timestamp: Date.now() })
    });
    if (!resp.ok) return res.status(400).json({ success: false, message: `A requisição respondeu com erro HTTP ${resp.status}.` });
    res.json({ success: true, message: 'Teste enviado! Confira se chegou.' });
  } catch (err) {
    res.status(500).json({ success: false, message: `Não foi possível enviar: ${err.message}` });
  }
});

app.post('/api/webhook-inbound-regenerate', (req, res) => {
  const user = findUser(req.session.username);
  if (!user) return res.status(401).json({ success: false, message: 'Sessão inválida.' });
  user.inboundToken = gerarToken();
  salvarUsers();
  res.json({ success: true, url: inboundUrl(req, user.inboundToken), token: user.inboundToken });
});

// ======================
// AUTENTICAÇÃO DA API POR TOKEN (sem sessão/cookie — pra bots e serviços
// externos). Aceita o token via ?token=, header X-API-Token ou
// Authorization: Bearer. Cada token pertence a UM usuário e só enxerga os
// dados DELE (contas, logs). Também controla o limite de requisições do
// plano de API daquele usuário.
// ======================
function extrairToken(req) {
  const auth = req.headers.authorization || '';
  const bearer = auth.toLowerCase().startsWith('bearer ') ? auth.slice(7).trim() : null;
  return req.query.token || req.headers['x-api-token'] || bearer || null;
}

function verificarApiTokenUsuario(req, res, next) {
  const token = extrairToken(req);
  if (!token) {
    return res.status(401).json({ success: false, message: 'Token de API ausente. Envie em ?token=, no header X-API-Token ou Authorization: Bearer.' });
  }
  const user = findUserByApiToken(token);
  if (!user) {
    return res.status(401).json({ success: false, message: 'Token de API inválido.' });
  }
  const uso = usoApiAtual(user);
  const plan = getApiPlan(user.apiPlan);
  if (plan.limit !== null && uso.count >= plan.limit) {
    return res.status(429).json({
      success: false,
      message: `Limite de requisições do seu plano de API (${plan.name}: ${plan.limit}/mês) atingido. Renova em ${new Date(uso.resetAt).toLocaleString('pt-BR')}, ou peça upgrade de plano ao administrador.`
    });
  }
  uso.count++;
  salvarUsers();
  req.apiUser = user;
  next();
}

// Igual à de cima, mas só deixa passar se o token pertencer a uma conta
// ADMIN — usada pelas rotas privadas de administração (/api/public/admin/*).
function verificarApiTokenAdmin(req, res, next) {
  const token = extrairToken(req);
  if (!token) {
    return res.status(401).json({ success: false, message: 'Token de API ausente. Envie em ?token=, no header X-API-Token ou Authorization: Bearer.' });
  }
  const user = findUserByApiToken(token);
  if (!user || user.role !== 'admin') {
    return res.status(401).json({ success: false, message: 'Esta é a API privada de administração: o token precisa pertencer a uma conta admin.' });
  }
  const uso = usoApiAtual(user);
  const plan = getApiPlan(user.apiPlan);
  if (plan.limit !== null && uso.count >= plan.limit) {
    return res.status(429).json({ success: false, message: `Limite de requisições do seu plano de API (${plan.name}: ${plan.limit}/mês) atingido.` });
  }
  uso.count++;
  salvarUsers();
  req.apiUser = user;
  next();
}

// ======================
// API PÚBLICA — escopo PESSOAL (protegida por token; cada usuário só vê as
// próprias contas Steam, nunca as de outros usuários)
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

app.get('/api/public/accounts', verificarApiTokenUsuario, (req, res) => {
  const minhas = accounts.filter(a => a.owner === req.apiUser.username);
  res.json({ success: true, count: minhas.length, accounts: minhas.map(contaPublica) });
});

app.get('/api/public/accounts/:username', verificarApiTokenUsuario, (req, res) => {
  const acc = accounts.find(a => a.username === req.params.username && a.owner === req.apiUser.username);
  if (!acc) return res.status(404).json({ success: false, message: 'Conta não encontrada (ou não é sua).' });
  res.json({ success: true, account: contaPublica(acc) });
});

app.get('/api/public/logs', verificarApiTokenUsuario, (req, res) => {
  const limit = Math.min(Math.max(Number(req.query.limit) || 100, 1), MAX_LOGS);
  const minhasContas = new Set(accounts.filter(a => a.owner === req.apiUser.username).map(a => a.username));
  const dashboard = dashboardLog.filter(e => e.username && minhasContas.has(e.username)).slice(-limit).reverse();
  res.json({ success: true, dashboard });
});

// Endpoint "tudo em um" — mais prático pra bots que só querem um único GET.
app.get('/api/public/data', verificarApiTokenUsuario, (req, res) => {
  const limit = Math.min(Math.max(Number(req.query.limit) || 100, 1), MAX_LOGS);
  const minhas = accounts.filter(a => a.owner === req.apiUser.username);
  const minhasUsernames = new Set(minhas.map(a => a.username));
  res.json({
    success: true,
    accounts: minhas.map(contaPublica),
    logs: {
      dashboard: dashboardLog.filter(e => e.username && minhasUsernames.has(e.username)).slice(-limit).reverse()
    }
  });
});

// ======================
// API PRIVADA DE ADMIN — protegida por token de uma conta ADMIN. Enxerga e
// gerencia TODOS os usuários e TODAS as contas do painel (a aba "API Admin"
// aparece pra qualquer usuário no painel, mas só funciona com token de admin).
// ======================
app.get('/api/public/admin/users', verificarApiTokenAdmin, (req, res) => {
  res.json({ success: true, count: users.length, users: users.map(userCompleto) });
});

app.post('/api/public/admin/users', verificarApiTokenAdmin, (req, res) => {
  const { username, password, role, plan, apiPlan } = req.body || {};
  if (!username || !password) return res.status(400).json({ success: false, message: 'Usuário e senha obrigatórios.' });
  if (findUser(username)) return res.status(400).json({ success: false, message: 'Já existe um usuário com esse nome.' });

  const novo = {
    id: crypto.randomBytes(8).toString('hex'),
    username,
    passwordHash: hashPassword(password),
    role: role === 'admin' ? 'admin' : 'user',
    plan: PLANS[plan] ? plan : 'bronze',
    createdAt: Date.now()
  };
  ensureUserApiFields(novo);
  if (API_PLANS[apiPlan]) novo.apiPlan = apiPlan;
  users.push(novo);
  salvarUsers();
  dispararWebhooks('USUARIO_CRIADO_VIA_API', `Usuário "${username}" criado via API privada de admin (token de "${req.apiUser.username}").`, null, 'webhooks');
  res.json({ success: true, message: 'Usuário criado!', user: userCompleto(novo) });
});

app.get('/api/public/admin/users/:username', verificarApiTokenAdmin, (req, res) => {
  const user = findUser(req.params.username);
  if (!user) return res.status(404).json({ success: false, message: 'Usuário não encontrado.' });
  res.json({ success: true, user: userCompleto(user) });
});

app.put('/api/public/admin/users/:username', verificarApiTokenAdmin, (req, res) => {
  const user = findUser(req.params.username);
  if (!user) return res.status(404).json({ success: false, message: 'Usuário não encontrado.' });
  const { role, plan, apiPlan, password } = req.body || {};
  if (role !== undefined) user.role = role === 'admin' ? 'admin' : 'user';
  if (plan !== undefined && PLANS[plan]) user.plan = plan;
  if (apiPlan !== undefined && API_PLANS[apiPlan]) user.apiPlan = apiPlan;
  if (password) user.passwordHash = hashPassword(password);
  salvarUsers();
  dispararWebhooks('USUARIO_ATUALIZADO_VIA_API', `Usuário "${req.params.username}" editado via API privada de admin (token de "${req.apiUser.username}").`, null, 'webhooks');
  res.json({ success: true, message: 'Usuário atualizado!', user: userCompleto(user) });
});

app.delete('/api/public/admin/users/:username', verificarApiTokenAdmin, (req, res) => {
  const user = findUser(req.params.username);
  if (!user) return res.status(404).json({ success: false, message: 'Usuário não encontrado.' });
  if (user.role === 'admin' && users.filter(u => u.role === 'admin').length <= 1) {
    return res.status(400).json({ success: false, message: 'Não é possível remover o único admin.' });
  }
  users = users.filter(u => u.username !== req.params.username);
  salvarUsers();
  dispararWebhooks('USUARIO_REMOVIDO_VIA_API', `Usuário "${req.params.username}" removido via API privada de admin (token de "${req.apiUser.username}").`, null, 'webhooks');
  res.json({ success: true, message: 'Usuário removido.' });
});

app.get('/api/public/admin/accounts', verificarApiTokenAdmin, (req, res) => {
  res.json({ success: true, count: accounts.length, accounts: accounts.map(a => ({ ...contaPublica(a), owner: a.owner })) });
});

app.get('/api/public/admin/logs', verificarApiTokenAdmin, (req, res) => {
  const limit = Math.min(Math.max(Number(req.query.limit) || 100, 1), MAX_LOGS);
  res.json({
    success: true,
    dashboard: dashboardLog.slice(-limit).reverse(),
    webhooks: webhooksLog.slice(-limit).reverse()
  });
});

// ======================
// ROTAS - LOGS
// ======================
// channel no body decide qual log é apagado ('dashboard' ou 'webhooks'); sem
// informar, apaga os dois (compatibilidade com a versão anterior).
app.post('/api/logs/clear', requireAdmin, (req, res) => {
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
  // IMPORTANTE: nunca usar io.emit aqui — isso mandaria as contas de TODOS os
  // usuários pra TODO MUNDO conectado. Cada socket recebe só o que é seu
  // (ou tudo, se for admin), igual ao emitAll().
  if (mudou) {
    for (const socket of io.of('/').sockets.values()) {
      const sess = socket.request.session;
      if (!sess) continue;
      socket.emit('tick', sess.role === 'admin' ? statusContas : statusParaDono(sess.username));
    }
  }
}, 1000);

io.on('connection', (socket) => {
  const sess = socket.request.session;
  const isAdmin = sess?.role === 'admin';

  socket.emit('update_all', isAdmin ? statusContas : statusParaDono(sess?.username));

  // Log da aba Dashboard: admin vê tudo; cada usuário vê só entradas sobre
  // as próprias contas Steam (mesma regra do emitLogEntryFiltrado).
  if (isAdmin) {
    socket.emit('logs_init_dashboard', dashboardLog.slice(-100).reverse());
  } else {
    const minhasContas = new Set(accounts.filter(a => a.owner === sess?.username).map(a => a.username));
    socket.emit('logs_init_dashboard', dashboardLog.filter(e => e.username && minhasContas.has(e.username)).slice(-100).reverse());
  }

  // Webhooks globais (do admin) e o log de integrações/entrada são
  // configuração do painel inteiro — só o admin vê.
  if (isAdmin) {
    socket.emit('webhooks_update', webhooks);
    socket.emit('logs_init_webhooks', webhooksLog.slice(-100).reverse());
  }

  // Recebe o código do Steam Guard digitado no painel web
  socket.on('steamGuard_submit', ({ username, code }) => {
    const pending = steamGuardPending[username];
    if (!pending || pending.answered) return;

    const contaSubmit = accounts.find(a => a.username === username);
    if (!isAdmin && contaSubmit?.owner !== sess?.username) return; // não é sua conta

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
    // Se temos shared_secret salvo (veio do SAGE), gera o código sozinho e não pede pro usuário
    const contaGuard = accounts.find(a => a.username === username);
    if (contaGuard?.steamguard?.shared_secret) {
      const gerado = gerarCodigoSteamGuard(contaGuard.steamguard.shared_secret);
      if (gerado && gerado.code) {
        log('STEAM', `${username} Steam Guard resolvido automaticamente via shared_secret: ${gerado.code}`);
        ensureStatus(username, {
          status: 'CONECTANDO',
          statusDetalhado: `Steam Guard automático (${gerado.code})`
        });
        emitAll('steamGuard-auto');
        callback(gerado.code);
        return;
      }
    }

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

    // Só quem é dono da conta (ou o admin) precisa ver o pedido de Steam Guard.
    const donoGuard = contaGuard?.owner;
    for (const socket of io.of('/').sockets.values()) {
      const sess = socket.request.session;
      if (!sess) continue;
      if (sess.role === 'admin' || sess.username === donoGuard) {
        socket.emit('steamGuard_request', { username, domain: domain || null });
      }
    }
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

// Erros não tratados também entram no "log de tudo que acontece no site" e
// disparam pros webhooks ativos — assim uma falha inesperada (bug, crash de
// uma promise, etc.) chega no Discord/Telegram do admin em vez de passar
// batido só no console do servidor.
process.on('uncaughtException', (err) => {
  log('ERROR', 'uncaughtException', err.stack || err.message);
  dispararWebhooks('ERRO_INESPERADO', `Exceção não tratada: ${err.message}`, null, 'webhooks');
});
process.on('unhandledRejection', (reason) => {
  const msg = reason instanceof Error ? reason.message : String(reason);
  log('ERROR', 'unhandledRejection', msg);
  dispararWebhooks('ERRO_INESPERADO', `Promise rejeitada sem tratamento: ${msg}`, null, 'webhooks');
});

server.listen(PORT, () => {
  log('BOOT', `Painel em http://localhost:${PORT}`);
  log('BOOT', `Login: usuário "${authConfig.username}" (troque a senha com: node set-password.js <usuario> <senha>)`);
  dispararWebhooks('SERVIDOR_INICIADO', 'O painel foi iniciado/reiniciado.', null, 'webhooks');
  iniciarTodas();
});
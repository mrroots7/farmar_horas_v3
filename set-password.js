// Define ou troca a senha de um usuário do painel (users.json).
// Uso: node set-password.js <usuario> <senha> [role] [plan]
// - Se o usuário não existir, cria um novo (role padrão: user, plan padrão: bronze).
// - Pra criar/resetar o admin principal: node set-password.js admin <senha> admin ouro
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const [, , username, password, roleArg, planArg] = process.argv;

if (!username || !password) {
  console.log('Uso: node set-password.js <usuario> <senha> [role: admin|user] [plan: bronze|prata|ouro]');
  process.exit(1);
}

const PLANOS_VALIDOS = ['bronze', 'prata', 'ouro'];

function hashPassword(pw) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(pw, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

const usersFile = path.join(__dirname, 'users.json');
let users = [];
try {
  users = JSON.parse(fs.readFileSync(usersFile, 'utf8'));
} catch {
  users = [];
}

const role = roleArg === 'admin' ? 'admin' : (roleArg === 'user' ? 'user' : undefined);
const plan = PLANOS_VALIDOS.includes(planArg) ? planArg : undefined;

let user = users.find(u => u.username === username);
if (user) {
  user.passwordHash = hashPassword(password);
  if (role) user.role = role;
  if (plan) user.plan = plan;
  console.log(`Senha de "${username}" atualizada.`);
} else {
  user = {
    id: crypto.randomBytes(8).toString('hex'),
    username,
    passwordHash: hashPassword(password),
    role: role || 'user',
    plan: plan || 'bronze',
    createdAt: Date.now()
  };
  users.push(user);
  console.log(`Usuário "${username}" criado (role: ${user.role}, plano: ${user.plan}).`);
}

fs.writeFileSync(usersFile, JSON.stringify(users, null, 2));
console.log('Se o servidor já estiver rodando, reinicie pra recarregar users.json (ou implemente um reload a quente se preferir).');

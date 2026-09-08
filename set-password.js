// Define ou troca o usuário/senha de acesso ao painel.
// Uso: node set-password.js <usuario> <senha>
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const [, , username, password] = process.argv;

if (!username || !password) {
  console.log('Uso: node set-password.js <usuario> <senha>');
  process.exit(1);
}

function hashPassword(pw) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(pw, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

const authFile = path.join(__dirname, 'auth.json');
fs.writeFileSync(authFile, JSON.stringify({ username, passwordHash: hashPassword(password) }, null, 2));

console.log(`Login definido! Usuário: "${username}"`);
console.log('Se o servidor já estiver rodando, o novo login já vale no próximo POST /api/login (não precisa reiniciar).');

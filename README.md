# Steam Hours Farmer — Novidades v3.4

## Resumo desta versão
- `/api/inbound/:token` agora **extrai conta Steam do corpo recebido** (username/password/AppIDs,
  tentando várias variações de nome de campo) e, se achar uma, **salva em `accounts.json` e
  inicia o farm sozinho** (`iniciarConta`). Continua registrando **tudo** que chega, mesmo
  quando não reconhece uma conta no corpo.
- Todo evento recebido pelo link de entrada é gravado, cru e organizado, em
  `inbound-events.json` (histórico separado, não se perde nada mesmo que o formato mude).
- **Logs separados por aba:** Dashboard e Webhooks agora têm cada um o seu próprio arquivo
  (`logs-dashboard.json` / `logs-webhooks.json`) e o seu próprio canal Socket.IO
  (`log_entry_dashboard` / `log_entry_webhooks`), então cada aba mostra só o que é dela.
- **Nova aba "API":** transforma o painel em uma API pública protegida por token
  (`/api/public/accounts`, `/api/public/logs`, `/api/public/inbound-events`,
  `/api/public/data`). A aba mostra o token, os endpoints documentados e um editor de
  código com exemplos (Node.js, JavaScript fetch, Python, cURL), com botões Editar/Copiar
  e syntax highlight simples.

---

# Steam Hours Farmer — Novidades v3.1

## 1. Instalar e rodar
```
npm install
node index.js
```
Acesse `http://localhost:3000`. Você será redirecionado para a tela de login.

## 2. Login fixo (painel privado)
Login padrão criado automaticamente no primeiro start:
- **usuário:** `admin`
- **senha:** `admin123`

**Troque isso AGORA**, antes de expor o painel na rede:
```
node set-password.js seu_usuario sua_senha_forte
```
Isso reescreve `auth.json` com a senha em hash (scrypt). O arquivo `auth.json` nunca deve ser
compartilhado nem commitado.

Sem sessão válida, nada funciona: rotas `/api/*`, a página principal e até a conexão do
Socket.IO (o "tempo real" do painel) exigem login. Só quem tiver usuário e senha entra.

A sessão dura 7 dias (cookie), mesmo se o servidor reiniciar (a chave fica salva em
`session-secret.json`).

## 3. Jogos ativos ocultos no perfil
Na aba **Perfis**, a lista de "Jogos ativos" agora vem **oculta por padrão** — só o contador
aparece. Clique em **Visualizar** para expandir e **Ocultar** para recolher de novo. Isso evita
que o card fique gigante quando a conta tem muitos jogos configurados.

## 4. Webhooks (Discord e SAGE)
Nova aba **Webhooks**, com um formulário parecido com o de "Adicionar conta": você escolhe um
nome, o **tipo** (Discord ou SAGE) e cola a **URL** do webhook. Pode cadastrar quantos quiser
dos dois tipos — eles aparecem separados em duas listas (Discord / SAGE), cada um com um
interruptor pra ativar/desativar sem precisar excluir.

Sempre que algo acontece no painel — conta adicionada/excluída, conta ficou online, erro de
login, pedido de Steam Guard, jogo iniciado/parado, farm parado — o evento é:
1. Registrado no **log de atividade** da própria aba Webhooks (em tempo real, mesmo sem
   nenhum webhook cadastrado).
2. Enviado para todos os webhooks **ativos**:
   - **Discord**: mensagem formatada (`content`) pronta pro formato de webhook do Discord.
   - **SAGE**: JSON genérico `{ event, username, message, timestamp }`.

Os dados ficam salvos em `webhooks.json` e `logs.json` (últimos 500 eventos).

### Testar um webhook na hora
Cada webhook cadastrado tem um botão **Testar** — ele manda uma mensagem de teste
imediatamente pra aquela URL, sem precisar esperar um evento real (conta online, erro, etc.)
acontecer. Se a URL estiver errada ou o serviço responder com erro, aparece um aviso na hora.

## 5. Webhooks de saída — mais tipos (v3.2)
Além de Discord e SAGE, agora dá pra cadastrar:
- **Telegram**: informe o token do bot (crie com `@BotFather`) e o Chat ID (descubra com
  `@userinfobot`). O painel manda a mensagem via API oficial do Telegram.
- **WhatsApp**: informe o número com DDI e a apikey do
  [CallMeBot](https://www.callmebot.com/blog/free-api-whatsapp-messages/) (serviço gratuito de
  terceiros — é preciso autorizar o bot deles no seu WhatsApp uma única vez).
- **Custom**: qualquer endpoint HTTP que aceite `POST` com JSON
  `{ event, username, message, timestamp }`.

O formulário da aba **Webhooks** muda os campos automaticamente de acordo com o tipo escolhido.

## 6. Webhooks de entrada (o painel recebe eventos de fora)
Na aba **Webhooks**, o card **"Receber webhooks (entrada)"** mostra um link único
(`/api/inbound/<token>`) protegido por um token secreto. Cole esse link no campo de webhook do
SAGE (ou de qualquer outro serviço) para que ele possa enviar eventos pro seu painel — eles
aparecem na hora no **log de atividade em tempo real**.

- **Copiar**: copia o link pra área de transferência.
- **Gerar novo link**: invalida o link atual e cria outro (use se o token vazar).

O endpoint aceita JSON livre; se vier `message`/`event`/`username`, o painel usa esses campos,
senão registra o corpo bruto da requisição.

## 7. Apagar o log de atividade em tempo real
O card de atividade agora tem um botão **"Apagar tudo"**. Ele limpa `logs.json` no servidor e
avisa **todas as abas do painel abertas simultaneamente** via Socket.IO, então o log some na
hora em qualquer lugar que o painel esteja aberto.

## 8. Visual novo
Tema escuro "industrial" com destaque em vermelho neon: bordas com brilho (glow) nas caixas,
efeito pulsante atrás do logo/nome do site e realce nos textos de tempo/eventos. Puramente
visual — nenhum comportamento mudou.

## 9. Webhooks configurados — lista limpa (v3.3)
A lista de "Webhooks configurados" agora mostra, por padrão, **só os webhooks ativos** que você
realmente cadastrou (sem seções vazias tipo "Nenhum webhook cadastrado" pra cada tipo). Cada item
mostra o **nome que você escolheu** e uma etiqueta com o tipo (Discord/Telegram/WhatsApp/SAGE/
Custom). Marque **"Mostrar desativados"** se quiser ver e reativar um webhook que você desligou.

## 10. Resumo do painel
As abas **Dashboard** e **Webhooks** agora têm um card curto no topo explicando o que o painel faz
e como funcionam os webhooks de entrada/saída — útil pra lembrar rápido sem precisar ler o README.

## 11. Página de perfil Steam
Na aba **Perfis**, contas que já fizeram login (têm um SteamID salvo) ganham um botão
**"Ver perfil Steam"**, que abre uma janela com os dados públicos da conta: avatar, nome, nível,
status/jogo atual, país, data de criação e total de jogos.

Isso usa a **Steam Web API oficial**, então é preciso configurar uma chave uma única vez: gere
gratuitamente em https://steamcommunity.com/dev/apikey e cole no card "Steam Web API" no topo
da aba Perfis. Sem a chave, o botão mostra uma mensagem explicando o que falta.

## 12. Importar / Exportar configurações
Nova aba **Importar/Exportar**:
- **Exportar**: baixa um `.json` com todas as contas (usuário/senha/AppIDs) e webhooks cadastrados
  — serve como backup ou para levar a configuração pra outro painel.
- **Importar**: selecione um `.json` no mesmo formato e o painel adiciona tudo automaticamente
  (contas e webhooks com usuário/nome já existente são ignorados, pra não duplicar).
- A própria aba mostra o **formato esperado** do arquivo, incluindo como `username`/`password`
  devem estar (o login e senha reais da Steam) e como `url`/`extra` mudam de sentido conforme o
  tipo do webhook.

**Atenção:** o arquivo exportado contém as senhas das contas em texto puro (é o mesmo formato que
o painel já usa internamente em `accounts.json`) — guarde esse backup com o mesmo cuidado que
guardaria as próprias senhas da Steam.

// Cole este script na aba Scripts do SAGE Enhanced
// Envia conta + e-mail + vault + Steam Guard (maFile) para o seu site

return async (ctx, env) => {
  const acc = ctx.account || {};
  const user = acc.user || {};
  const email = acc.email || {};
  const vault = acc.vault || {};
  const sg = acc.steamguard || {};
  const meta = acc.metadata || {};

  const payload = {
    event: "SAGE_ACCOUNT_CREATED",

    // Conta Steam
    username: user.username || null,
    password: user.password || null,
    steamId: acc.id || null,

    // E-mail da conta
    email: email.address || null,
    emailPassword: email.password || null,

    // Vault (e-mail permanente)
    vaultEmail: vault.address || null,
    vaultPassword: vault.password || null,

    // Steam Guard completo (maFile)
    steamguard: sg && (sg.shared_secret || sg.identity_secret) ? {
      account_name: sg.account_name || user.username || null,
      shared_secret: sg.shared_secret || null,
      identity_secret: sg.identity_secret || null,
      revocation_code: sg.revocation_code || null,
      secret_1: sg.secret_1 || null,
      deviceId: sg.deviceId || null,
      serial_number: sg.serial_number || null,
      token_gid: sg.token_gid || null,
      uri: sg.uri || null,
      status: sg.status ?? null,
      confirm_type: sg.confirm_type ?? null,
      server_time: sg.server_time || null
    } : null,

    // Metadados
    games: [730],
    createdAt: meta.createdAt || Date.now(),
    sessionStart: meta.sessionStart || null,
    ip: meta.ip || null,
    tags: meta.tags || ["nova"],
    guard: acc.guard || (sg && sg.shared_secret ? "mobile" : "disable")
  };

  // TROQUE pelo seu link de inbound (painel → Webhooks → link de entrada)
  const webhookUrl = "http://cs2-steam.shop/api/inbound/SEU_TOKEN_AQUI";

  await fetch(webhookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
};

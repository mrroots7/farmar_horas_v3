document.getElementById('loginForm').addEventListener('submit', async (e) => {
  e.preventDefault();

  const username = document.getElementById('loginUser').value.trim();
  const password = document.getElementById('loginPass').value;
  const msg = document.getElementById('loginMessage');
  msg.textContent = '';

  try {
    const res = await fetch('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password })
    });
    const result = await res.json();

    if (result.success) {
      window.location.href = '/';
    } else {
      msg.style.color = '#ffb0b0';
      msg.textContent = result.message || 'Usuário ou senha inválidos.';
    }
  } catch (err) {
    msg.style.color = '#ffb0b0';
    msg.textContent = 'Não foi possível conectar ao servidor.';
  }
});

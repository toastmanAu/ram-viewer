// RAM Viewer WebSocket client
const ws = new WebSocket(`ws://${window.location.hostname}:8766`);
let clientId = null;
let pollingActive = false;

// DOM elements
const ipInput = document.getElementById('ip');
const portInput = document.getElementById('port');
const gameSelect = document.getElementById('game-select');
const testBtn = document.getElementById('test-btn');
const startBtn = document.getElementById('start-btn');
const stopBtn = document.getElementById('stop-btn');
const copyBtn = document.getElementById('copy-btn');
const saveBtn = document.getElementById('save-btn');
const consoleLog = document.getElementById('console-log');
const ramTable = document.getElementById('ram-table');
const testResult = document.getElementById('test-result');
const localToggle = document.getElementById('local-toggle');

// Toggle localhost mode
localToggle.addEventListener('change', () => {
  if (localToggle.checked) {
    ipInput.value = '127.0.0.1';
    ipInput.disabled = true;
  } else {
    ipInput.value = '192.168.68.73';
    ipInput.disabled = false;
  }
});

// Console log helper
function logConsole(type, message, detail = null) {
  const entry = document.createElement('div');
  entry.className = `log-entry log-${type}`;
  const ts = new Date().toLocaleTimeString();
  entry.innerHTML = `<span class="timestamp">${ts}</span> ${message}`;
  if (detail) {
    entry.innerHTML += `<br><small>${detail}</small>`;
  }
  consoleLog.appendChild(entry);
  // Auto-scroll
  consoleLog.scrollTop = consoleLog.scrollHeight;
}

// Update RAM card
function updateRamCard(address, label, value) {
  const existing = document.querySelector(`[data-address="${address}"]`);
  if (existing) {
    existing.querySelector('.ram-value').textContent = value;
    existing.querySelector('.ram-label').textContent = label;
  } else {
    const card = document.createElement('div');
    card.className = 'ram-card';
    card.dataset.address = address;
    card.innerHTML = `
      <div class="ram-label">${label}</div>
      <div class="ram-address">${address}</div>
      <div class="ram-value">${value}</div>
    `;
    ramTable.appendChild(card);
  }
}

// Copy console as text
copyBtn.addEventListener('click', () => {
  const text = Array.from(consoleLog.querySelectorAll('.log-entry'))
    .map(el => el.textContent)
    .join('\n');
  navigator.clipboard.writeText(text).then(() => {
    logConsole('info', 'Console copied to clipboard');
  });
});

// Save console as .txt file
saveBtn.addEventListener('click', () => {
  const text = Array.from(consoleLog.querySelectorAll('.log-entry'))
    .map(el => el.textContent)
    .join('\n');
  const blob = new Blob([text], { type: 'text/plain' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `ram-viewer-log-${new Date().toISOString().slice(0,10)}.txt`;
  a.click();
  URL.revokeObjectURL(url);
  logConsole('info', 'Console saved as .txt');
});

// Test connection
testBtn.addEventListener('click', async () => {
  const host = ipInput.value.trim();
  const port = portInput.value;
  testResult.textContent = 'Testing...';
  ws.send(JSON.stringify({
    type: 'test',
    host,
    port
  }));
});

// Start polling
startBtn.addEventListener('click', () => {
  const game = gameSelect.value;
  const host = ipInput.value.trim();
  const port = portInput.value;
  if (!game) {
    logConsole('error', 'No game selected');
    return;
  }
  ws.send(JSON.stringify({
    type: 'start',
    game,
    host,
    port
  }));
});

// Stop polling
stopBtn.addEventListener('click', () => {
  ws.send(JSON.stringify({ type: 'stop' }));
});

// WebSocket handlers
ws.onopen = () => {
  logConsole('info', 'Connected to RAM Viewer server');
};

ws.onmessage = (event) => {
  const data = JSON.parse(event.data);
  switch (data.event) {
    case 'games':
      // Populate game dropdown
      gameSelect.innerHTML = '<option value="">— select a game —</option>';
      data.games.forEach(game => {
        const opt = document.createElement('option');
        opt.value = game;
        opt.textContent = game;
        gameSelect.appendChild(opt);
      });
      startBtn.disabled = false;
      break;
    case 'test':
      if (data.success) {
        testResult.textContent = `✅ Connected (${data.response})`;
        logConsole('info', `Connection test OK: ${data.response}`);
      } else {
        testResult.textContent = `❌ Failed: ${data.error}`;
        logConsole('error', `Connection test failed: ${data.error}`);
      }
      break;
    case 'started':
      clientId = data.clientId;
      pollingActive = true;
      startBtn.disabled = true;
      stopBtn.disabled = false;
      logConsole('info', `Polling started (client ${clientId})`);
      break;
    case 'stopped':
      pollingActive = false;
      startBtn.disabled = false;
      stopBtn.disabled = true;
      logConsole('info', 'Polling stopped');
      // Clear RAM table
      ramTable.innerHTML = '';
      break;
    case 'log':
      logConsole(data.type, data.message, data.detail);
      break;
    case 'ram':
      updateRamCard(data.address, data.label, data.value);
      logConsole('ram', `[${data.label}] ${data.address} = ${data.value}`);
      break;
    case 'response':
      logConsole('command', `Response: ${data.response}`);
      break;
    case 'error':
      logConsole('error', `Error: ${data.error}`);
      break;
  }
};

ws.onerror = (err) => {
  logConsole('error', 'WebSocket error', err.message);
};

ws.onclose = () => {
  logConsole('error', 'WebSocket disconnected');
  pollingActive = false;
  startBtn.disabled = true;
  stopBtn.disabled = true;
};
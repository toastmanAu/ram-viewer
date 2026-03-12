#!/usr/bin/env node
// RAM Viewer Server — RetroArch UDP polling + WebSocket console
const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const dgram = require('dgram');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 8766;
const GAMES_DIR = process.env.GAMES_DIR || path.join(__dirname, 'games');

// Load game JSON files
const games = {};
const gameFiles = fs.existsSync(GAMES_DIR) ? fs.readdirSync(GAMES_DIR).filter(f => f.endsWith('.json')) : [];
gameFiles.forEach(file => {
  try {
    const data = JSON.parse(fs.readFileSync(path.join(GAMES_DIR, file), 'utf8'));
    games[path.basename(file, '.json')] = data;
  } catch (e) {
    console.error(`Failed to load game ${file}:`, e.message);
  }
});

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// Global state per client
const clients = new Map();

// UDP socket (one per server)
const udpClient = dgram.createSocket('udp4');
udpClient.bind(); // bind to random local port

// Helper: send UDP command, return promise
function sendUdpCommand(command, host = '127.0.0.1', port = 55355) {
  return new Promise((resolve, reject) => {
    const buffer = Buffer.from(command + '\n');
    udpClient.send(buffer, port, host, (err) => {
      if (err) {
        reject(err);
        return;
      }
      // Wait for response (timeout 2s)
      const timer = setTimeout(() => {
        udpClient.removeListener('message', onMessage);
        reject(new Error('UDP timeout'));
      }, 2000);
      const onMessage = (msg, rinfo) => {
        if (rinfo.address === host && rinfo.port === port) {
          clearTimeout(timer);
          udpClient.removeListener('message', onMessage);
          resolve(msg.toString().trim());
        }
      };
      udpClient.on('message', onMessage);
    });
  });
}

// Broadcast to all WebSocket clients
function broadcast(data) {
  const json = JSON.stringify(data);
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(json);
    }
  });
}

// Log message to console (broadcast)
function consoleLog(type, message, detail = null) {
  const entry = {
    type,
    timestamp: new Date().toISOString(),
    message,
    detail
  };
  broadcast({ event: 'log', ...entry });
  console[type === 'error' ? 'error' : 'log'](`[${type}] ${message}`);
}

// Start polling a game for a client
function startPolling(clientId, gameId, host, port, interval = 200) {
  const game = games[gameId];
  if (!game) {
    consoleLog('error', `Game ${gameId} not found`, { clientId });
    return;
  }
  if (clients.has(clientId)) {
    stopPolling(clientId);
  }
  consoleLog('info', `Start polling ${gameId} on ${host}:${port}`, { clientId });
  const addresses = game.addresses || [];
  let polling = true;
  const pollLoop = async () => {
    if (!polling) return;
    try {
      for (const addr of addresses) {
        const cmd = `READ_CORE_RAM ${addr.address} 1`;
        const response = await sendUdpCommand(cmd, host, port);
        const value = parseInt(response, 16);
        broadcast({
          event: 'ram',
          clientId,
          address: addr.address,
          label: addr.label,
          value,
          raw: response
        });
        // Small delay between reads
        await new Promise(r => setTimeout(r, 10));
      }
    } catch (err) {
      consoleLog('error', `Poll error: ${err.message}`, { clientId });
    }
    if (polling) {
      setTimeout(pollLoop, interval);
    }
  };
  clients.set(clientId, { polling: true, interval, host, port, gameId, pollLoop });
  pollLoop();
}

function stopPolling(clientId) {
  const client = clients.get(clientId);
  if (client) {
    client.polling = false;
    clients.delete(clientId);
    consoleLog('info', `Stopped polling for ${clientId}`);
  }
}

// WebSocket connection
wss.on('connection', (ws, req) => {
  const clientId = `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  consoleLog('info', `New WebSocket client ${clientId}`, { ip: req.socket.remoteAddress });
  ws.on('message', async (data) => {
    try {
      const msg = JSON.parse(data.toString());
      switch (msg.type) {
        case 'test':
          consoleLog('info', `Testing connection to ${msg.host}:${msg.port}`, { clientId });
          try {
            const resp = await sendUdpCommand('GET_STATUS', msg.host, msg.port);
            ws.send(JSON.stringify({ event: 'test', success: true, response: resp }));
          } catch (err) {
            ws.send(JSON.stringify({ event: 'test', success: false, error: err.message }));
          }
          break;
        case 'start':
          startPolling(clientId, msg.game, msg.host || '127.0.0.1', msg.port || 55355, msg.interval || 200);
          ws.send(JSON.stringify({ event: 'started', clientId }));
          break;
        case 'stop':
          stopPolling(clientId);
          ws.send(JSON.stringify({ event: 'stopped', clientId }));
          break;
        case 'command':
          consoleLog('command', `UDP: ${msg.command}`, { clientId });
          try {
            const resp = await sendUdpCommand(msg.command, msg.host, msg.port);
            ws.send(JSON.stringify({ event: 'response', command: msg.command, response: resp }));
          } catch (err) {
            ws.send(JSON.stringify({ event: 'error', command: msg.command, error: err.message }));
          }
          break;
      }
    } catch (err) {
      consoleLog('error', `WebSocket message error: ${err.message}`, { clientId });
    }
  });
  ws.on('close', () => {
    stopPolling(clientId);
    consoleLog('info', `Client ${clientId} disconnected`);
  });
  // Send initial game list
  ws.send(JSON.stringify({ event: 'games', games: Object.keys(games) }));
});

// Static files
app.use(express.static(path.join(__dirname, 'public')));

// API endpoint for games list
app.get('/api/games', (req, res) => {
  res.json(games);
});

// Start server
server.listen(PORT, () => {
  console.log(`RAM Viewer Server running on http://localhost:${PORT}`);
});
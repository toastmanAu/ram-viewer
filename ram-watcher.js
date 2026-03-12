#!/usr/bin/env node
/**
 * ram-watcher.js — Local-inference event logger for RAM Viewer
 *
 * Modes:
 *   Known game:    node ram-watcher.js --game dkc
 *   Discovery:     node ram-watcher.js --discover --game-name "Donkey Kong Country"
 *
 * Options:
 *   --game <id>          Game JSON id (from games/ directory)
 *   --discover           Discovery mode — scan all RAM, no game JSON needed
 *   --game-name <name>   Game name hint for LLM in discovery mode
 *   --scan-start <hex>   Start address for discovery scan (default: 0x0000)
 *   --scan-end <hex>     End address for discovery scan (default: 0x1FFF, 8KB)
 *   --host <ip>          RetroArch host (default: 127.0.0.1)
 *   --port <n>           RetroArch UDP port (default: 55355)
 *   --ollama <url>       Ollama base URL (default: http://localhost:11434)
 *   --model <name>       Ollama model (default: qwen2.5:14b)
 *   --output <file>      Event log output file (default: events-YYYY-MM-DD.jsonl)
 *   --local              Use localhost as RetroArch host
 *   --export             Export candidate game JSON after session (discovery mode)
 *   --interval <ms>      Poll interval (default: 500ms)
 *   --llm-interval <ms>  How often to send batches to LLM (default: 5000ms)
 */

'use strict';

const dgram = require('dgram');
const fs = require('fs');
const path = require('path');
const http = require('http');
const readline = require('readline');

// ── CLI args ──────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
function arg(name, def) {
  const i = args.indexOf(name);
  return i !== -1 && args[i + 1] ? args[i + 1] : def;
}
function flag(name) { return args.includes(name); }

const GAME_ID      = arg('--game', null);
const DISCOVER     = flag('--discover');
const GAME_NAME    = arg('--game-name', GAME_ID || 'Unknown Game');
const SCAN_START   = parseInt(arg('--scan-start', '0x0000'), 16);
const SCAN_END     = parseInt(arg('--scan-end', '0x1FFF'), 16);
const HOST         = flag('--local') ? '127.0.0.1' : arg('--host', '127.0.0.1');
const PORT         = parseInt(arg('--port', '55355'));
const OLLAMA_URL   = arg('--ollama', 'http://localhost:11434');
const MODEL        = arg('--model', 'qwen2.5:14b');
const INTERVAL_MS  = parseInt(arg('--interval', '500'));
const LLM_INTERVAL = parseInt(arg('--llm-interval', '5000'));
const EXPORT       = flag('--export') || DISCOVER;

const today = new Date().toISOString().slice(0, 10);
const OUTPUT_FILE  = arg('--output', `events-${today}.jsonl`);

if (!GAME_ID && !DISCOVER) {
  console.error('Error: specify --game <id> or --discover [--game-name "Title"]');
  process.exit(1);
}

// ── Load game JSON ─────────────────────────────────────────────────────────────
const GAMES_DIR = path.join(__dirname, 'games');
let gameData = null;
let knownAddresses = [];

if (GAME_ID) {
  const file = path.join(GAMES_DIR, `${GAME_ID}.json`);
  if (!fs.existsSync(file)) {
    console.error(`Game file not found: ${file}`);
    process.exit(1);
  }
  gameData = JSON.parse(fs.readFileSync(file));
  knownAddresses = gameData.addresses || [];
  console.log(`🎮 Known game: ${gameData.name} (${knownAddresses.length} addresses)`);
}

if (DISCOVER) {
  console.log(`🔍 Discovery mode: scanning 0x${SCAN_START.toString(16).padStart(4,'0')}–0x${SCAN_END.toString(16).padStart(4,'0')} (${SCAN_END - SCAN_START + 1} bytes)`);
  console.log(`   Game hint: ${GAME_NAME}`);
}

// ── UDP client ────────────────────────────────────────────────────────────────
const udp = dgram.createSocket('udp4');
udp.bind();

function udpCommand(cmd, timeoutMs = 2000) {
  return new Promise((resolve, reject) => {
    const buf = Buffer.from(cmd + '\n');
    udp.send(buf, PORT, HOST, err => {
      if (err) return reject(err);
      const timer = setTimeout(() => {
        udp.removeListener('message', onMsg);
        reject(new Error('UDP timeout'));
      }, timeoutMs);
      const onMsg = (msg, rinfo) => {
        if (rinfo.address === HOST) {
          clearTimeout(timer);
          udp.removeListener('message', onMsg);
          resolve(msg.toString().trim());
        }
      };
      udp.on('message', onMsg);
    });
  });
}

// Read N bytes from address (returns array of decimal values)
async function readBytes(address, length = 1) {
  const addrHex = typeof address === 'number'
    ? '0x' + address.toString(16).padStart(4, '0')
    : address;
  const resp = await udpCommand(`READ_CORE_RAM ${addrHex} ${length}`, 1000);
  // Response format: "READ_CORE_RAM <addr> <b1> <b2> ..."
  const parts = resp.split(' ');
  // Find hex bytes after the address echo
  const bytes = parts.slice(2).map(b => parseInt(b, 16)).filter(n => !isNaN(n));
  return bytes;
}

// Read full scan range in chunks (max 128 bytes per read)
const CHUNK = 64;
async function scanRange(start, end) {
  const result = new Uint8Array(end - start + 1);
  for (let addr = start; addr <= end; addr += CHUNK) {
    const len = Math.min(CHUNK, end - addr + 1);
    try {
      const bytes = await readBytes(addr, len);
      for (let i = 0; i < bytes.length; i++) {
        result[addr - start + i] = bytes[i] || 0;
      }
    } catch (e) {
      // Skip failed chunks silently
    }
  }
  return result;
}

// ── Ollama LLM ────────────────────────────────────────────────────────────────
function ollamaGenerate(prompt) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ model: MODEL, prompt, stream: false });
    const url = new URL('/api/generate', OLLAMA_URL);
    const options = {
      hostname: url.hostname,
      port: url.port || 80,
      path: url.pathname,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
    };
    const req = http.request(options, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data).response || ''); }
        catch (e) { reject(new Error('Ollama parse error: ' + data.slice(0, 100))); }
      });
    });
    req.on('error', reject);
    req.setTimeout(30000, () => { req.destroy(); reject(new Error('Ollama timeout')); });
    req.write(body);
    req.end();
  });
}

// Interpret known-game event
async function interpretEvent(changes, allValues) {
  const changeLines = changes.map(c => `  ${c.label} (${c.address}): ${c.from} → ${c.to}`).join('\n');
  const contextLines = allValues.map(v => `  ${v.label} (${v.address}): ${v.value}`).join('\n');
  const prompt = `Game: ${gameData ? gameData.name : GAME_NAME}
You are a retro game analyst. Interpret what just happened based on RAM changes.

Changes detected:
${changeLines}

Current RAM state:
${contextLines}

What single game event just occurred? One concise sentence. Focus on gameplay meaning, not raw numbers.`;

  try {
    const response = await ollamaGenerate(prompt);
    return response.trim();
  } catch (e) {
    return `[LLM error: ${e.message}]`;
  }
}

// Interpret discovery-mode changes
async function interpretDiscovery(recentChanges, allChanging) {
  const changeSummary = recentChanges.slice(0, 20).map(c =>
    `  0x${c.address.toString(16).padStart(4,'0')}: ${c.from} → ${c.to} (pattern: ${c.pattern})`
  ).join('\n');

  const stableInteresting = allChanging.slice(0, 15).map(c =>
    `  0x${c.address.toString(16).padStart(4,'0')}: currently ${c.current}, changed ${c.changeCount}x (range ${c.min}–${c.max})`
  ).join('\n');

  const prompt = `Game: ${GAME_NAME}
You are helping map SNES/retro game RAM addresses to meaningful game variables.

Recent RAM changes (triggered by player actions):
${changeSummary}

Most active addresses this session:
${stableInteresting}

For each address, suggest:
1. What game variable it likely represents (score, lives, HP, items, timer, position, etc.)
2. Confidence: HIGH/MEDIUM/LOW
3. One-line reason

Format each as:
0xADDR: label — reason (CONFIDENCE)

Ignore addresses with rapid oscillation (animation/timers). Focus on addresses that change in response to player actions.`;

  try {
    const response = await ollamaGenerate(prompt);
    return response.trim();
  } catch (e) {
    return `[LLM error: ${e.message}]`;
  }
}

// ── Event log ─────────────────────────────────────────────────────────────────
function logEvent(entry) {
  const line = JSON.stringify({ ts: new Date().toISOString(), ...entry });
  fs.appendFileSync(OUTPUT_FILE, line + '\n');
  console.log(`[EVENT] ${entry.event || entry.label || 'change'}: ${entry.description || JSON.stringify(entry)}`);
}

// ── State tracking ─────────────────────────────────────────────────────────────
let prevValues = {};
let prevScan = null;
let pendingChanges = [];
let discoveryStats = {}; // address → { changeCount, min, max, current, pattern }
let llmTimer = null;
let sessionLabels = {}; // discovered labels

// ── Known game polling ─────────────────────────────────────────────────────────
async function pollKnownGame() {
  const currentValues = {};
  const changes = [];

  for (const addr of knownAddresses) {
    try {
      const bytes = await readBytes(addr.address, 1);
      const val = bytes[0] ?? 0;
      currentValues[addr.address] = val;

      if (prevValues[addr.address] !== undefined && prevValues[addr.address] !== val) {
        changes.push({
          address: addr.address,
          label: addr.label,
          from: prevValues[addr.address],
          to: val
        });
      }
    } catch (e) {
      // Skip failed reads
    }
  }

  Object.assign(prevValues, currentValues);

  if (changes.length > 0) {
    const allValues = knownAddresses.map(a => ({
      address: a.address,
      label: a.label,
      value: currentValues[a.address] ?? prevValues[a.address] ?? '?'
    }));

    const description = await interpretEvent(changes, allValues);
    logEvent({
      type: 'game-event',
      game: gameData.name,
      changes,
      description
    });
  }
}

// ── Discovery polling ──────────────────────────────────────────────────────────
function classifyPattern(history) {
  if (history.length < 3) return 'unknown';
  const diffs = history.slice(1).map((v, i) => v - history[i]);
  if (diffs.every(d => d === 1)) return 'incrementing';
  if (diffs.every(d => d === -1)) return 'decrementing';
  if (diffs.every(d => Math.abs(d) > 100)) return 'animation/noise';
  if (new Set(history).size <= 3) return 'toggle/state';
  return 'variable';
}

async function pollDiscovery() {
  const scan = await scanRange(SCAN_START, SCAN_END);

  if (!prevScan) {
    prevScan = scan;
    console.log('  Initial scan complete, watching for changes...');
    return;
  }

  const now = Date.now();
  const changes = [];

  for (let i = 0; i <= SCAN_END - SCAN_START; i++) {
    const addr = SCAN_START + i;
    const prev = prevScan[i];
    const curr = scan[i];

    if (prev !== curr) {
      // Track stats
      if (!discoveryStats[addr]) {
        discoveryStats[addr] = { changeCount: 0, min: curr, max: curr, current: curr, history: [] };
      }
      const stats = discoveryStats[addr];
      stats.changeCount++;
      stats.current = curr;
      stats.min = Math.min(stats.min, curr);
      stats.max = Math.max(stats.max, curr);
      stats.history.push(curr);
      if (stats.history.length > 10) stats.history.shift();
      stats.pattern = classifyPattern(stats.history);

      // Only log non-noisy changes
      if (stats.pattern !== 'animation/noise' || stats.changeCount < 3) {
        changes.push({ address: addr, from: prev, to: curr, pattern: stats.pattern });
      }
    }
  }

  prevScan = scan;

  if (changes.length > 0) {
    pendingChanges.push(...changes);
    // Print raw changes immediately
    for (const c of changes.filter(ch => discoveryStats[ch.address]?.pattern !== 'animation/noise')) {
      const label = sessionLabels[c.address] || `0x${c.address.toString(16).padStart(4,'0')}`;
      console.log(`  📍 ${label}: ${c.from} → ${c.to} (${c.pattern})`);
    }
  }
}

// ── LLM batch processor ────────────────────────────────────────────────────────
async function runLLMBatch() {
  if (DISCOVER && pendingChanges.length > 0) {
    console.log(`\n🤖 LLM analyzing ${pendingChanges.length} changes...`);
    const interesting = pendingChanges.filter(c => c.pattern !== 'animation/noise');
    if (interesting.length === 0) {
      pendingChanges = [];
      return;
    }

    const allChanging = Object.entries(discoveryStats)
      .sort((a, b) => b[1].changeCount - a[1].changeCount)
      .filter(([, s]) => s.pattern !== 'animation/noise')
      .map(([addr, s]) => ({ address: parseInt(addr), ...s }));

    const interpretation = await interpretDiscovery(interesting, allChanging);
    console.log('\n' + interpretation + '\n');

    // Parse LLM suggestions and update sessionLabels
    for (const line of interpretation.split('\n')) {
      const match = line.match(/0x([0-9a-fA-F]+):\s*([^—–-]+)/);
      if (match) {
        const addr = parseInt(match[1], 16);
        const label = match[2].trim();
        if (addr >= SCAN_START && addr <= SCAN_END) {
          sessionLabels[addr] = label;
        }
      }
    }

    logEvent({
      type: 'discovery-batch',
      changes: interesting,
      interpretation,
      sessionLabels
    });

    pendingChanges = [];
  }
}

// ── Export candidate JSON ──────────────────────────────────────────────────────
async function exportCandidateJSON() {
  if (!DISCOVER) return;

  console.log('\n🤖 Generating candidate game JSON...');

  const allChanging = Object.entries(discoveryStats)
    .filter(([, s]) => s.changeCount >= 2 && s.pattern !== 'animation/noise')
    .sort((a, b) => b[1].changeCount - a[1].changeCount);

  if (allChanging.length === 0) {
    console.log('No significant addresses found. Play more of the game and try again.');
    return;
  }

  const prompt = `Game: ${GAME_NAME}
Based on this session of RAM monitoring, generate a game JSON file for the RAM Viewer tool.

Addresses that changed during gameplay:
${allChanging.map(([addr, s]) => `  0x${parseInt(addr).toString(16).padStart(4,'0')}: changed ${s.changeCount}x, range ${s.min}–${s.max}, pattern: ${s.pattern}`).join('\n')}

Known labels (from LLM analysis this session):
${Object.entries(sessionLabels).map(([addr, label]) => `  0x${parseInt(addr).toString(16).padStart(4,'0')}: ${label}`).join('\n') || '  (none yet)'}

Generate a JSON file in this EXACT format:
{
  "name": "Game Title (Console)",
  "console": "SNES",
  "core": "recommended-core",
  "addresses": [
    {
      "address": "0xXXXX",
      "label": "Short Label",
      "description": "What this value represents"
    }
  ]
}

Include only addresses that likely represent meaningful game state (NOT animation/timer noise).
Focus on: lives, score, HP, item counts, player position, level/stage, game state.`;

  try {
    const response = await ollamaGenerate(prompt);
    // Extract JSON from response
    const jsonMatch = response.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const candidate = JSON.parse(jsonMatch[0]);
      const safeName = GAME_NAME.toLowerCase().replace(/[^a-z0-9]/g, '-').replace(/-+/g, '-');
      const outFile = path.join(GAMES_DIR, `${safeName}-candidate.json`);
      fs.writeFileSync(outFile, JSON.stringify(candidate, null, 2));
      console.log(`\n✅ Candidate JSON saved: ${outFile}`);
      console.log('   Review the labels, rename to final filename, and submit a PR!');
    } else {
      console.log('\nLLM response (manual extraction needed):');
      console.log(response);
    }
  } catch (e) {
    console.error('Export failed:', e.message);
  }
}

// ── Main loop ─────────────────────────────────────────────────────────────────
async function main() {
  // Test connection
  try {
    const status = await udpCommand('GET_STATUS', 3000);
    console.log(`✅ Connected to RetroArch at ${HOST}:${PORT}`);
    console.log(`   Status: ${status}`);
  } catch (e) {
    console.error(`❌ Cannot connect to RetroArch at ${HOST}:${PORT}: ${e.message}`);
    console.error('   Make sure RetroArch has network_cmd_enable = "true" in retroarch.cfg');
    process.exit(1);
  }

  console.log(`📝 Logging events to: ${OUTPUT_FILE}`);
  console.log(`🤖 Using Ollama model: ${MODEL} at ${OLLAMA_URL}`);
  console.log(`   Poll: ${INTERVAL_MS}ms | LLM batch: ${LLM_INTERVAL}ms`);
  console.log('\nPress Ctrl+C to stop' + (DISCOVER ? ' and export candidate JSON.' : '.'));
  console.log('─'.repeat(60));

  // LLM batch timer
  llmTimer = setInterval(runLLMBatch, LLM_INTERVAL);

  // Poll loop
  const pollFn = DISCOVER ? pollDiscovery : pollKnownGame;
  const pollTimer = setInterval(async () => {
    try { await pollFn(); }
    catch (e) { /* silent */ }
  }, INTERVAL_MS);

  // Graceful shutdown
  process.on('SIGINT', async () => {
    console.log('\n\nStopping...');
    clearInterval(pollTimer);
    clearInterval(llmTimer);
    if (DISCOVER) {
      await runLLMBatch(); // flush pending
      await exportCandidateJSON();
    }
    udp.close();
    console.log(`\n✅ Done. Events saved to: ${OUTPUT_FILE}`);
    process.exit(0);
  });
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
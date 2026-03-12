#!/usr/bin/env node
/**
 * pr-validator.js — Local inference validator for game JSON PRs
 *
 * Polls open PRs on toastmanAu/ram-viewer, validates game JSON submissions,
 * posts a GitHub comment with AI assessment, and labels PRs accordingly.
 *
 * Run manually or via heartbeat:
 *   node pr-validator.js
 *   node pr-validator.js --dry-run   (don't post to GitHub)
 *
 * Env vars:
 *   GITHUB_TOKEN    — PAT with repo:write + PR comment scope
 *   OLLAMA_URL      — default http://192.168.68.88:11434
 *   OLLAMA_MODEL    — default qwen2.5:14b
 */

'use strict';

const https = require('https');
const http  = require('http');

const DRY_RUN     = process.argv.includes('--dry-run');
const OWNER       = 'toastmanAu';
const REPO        = 'ram-viewer';
const OLLAMA_URL  = process.env.OLLAMA_URL  || 'http://192.168.68.88:11434';
const MODEL       = process.env.OLLAMA_MODEL || 'qwen2.5:14b';
const GH_TOKEN    = process.env.GITHUB_TOKEN;
const BOT_MARKER  = '<!-- fiberquest-validator -->';

const VALID_CONSOLES = ['NES','SNES','Genesis','Mega Drive','Game Boy','GBC','GBA','N64','PS1','Arcade','FBNeo','MAME','Master System','TurboGrafx-16','Atari 2600','Atari 7800','Neo Geo'];
const SNES_WRAM_MAX  = 0x3FFF;
const NES_RAM_MAX    = 0x07FF;

// ── HTTP helpers ──────────────────────────────────────────────────────────────
function request(url, options = {}, body = null) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const lib = parsed.protocol === 'https:' ? https : http;
    const opts = {
      hostname: parsed.hostname,
      port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path: parsed.pathname + (parsed.search || ''),
      method: options.method || 'GET',
      headers: options.headers || {}
    };
    if (body) {
      opts.headers['Content-Length'] = Buffer.byteLength(body);
    }
    const req = lib.request(opts, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch { resolve({ status: res.statusCode, body: data }); }
      });
    });
    req.on('error', reject);
    req.setTimeout(30000, () => { req.destroy(); reject(new Error('timeout')); });
    if (body) req.write(body);
    req.end();
  });
}

function ghGet(path) {
  return request(`https://api.github.com/repos/${OWNER}/${REPO}${path}`, {
    headers: {
      Authorization: `Bearer ${GH_TOKEN}`,
      Accept: 'application/vnd.github.v3+json',
      'User-Agent': 'fiberquest-validator'
    }
  });
}

function ghPost(path, body) {
  const bodyStr = JSON.stringify(body);
  return request(`https://api.github.com/repos/${OWNER}/${REPO}${path}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${GH_TOKEN}`,
      Accept: 'application/vnd.github.v3+json',
      'Content-Type': 'application/json',
      'User-Agent': 'fiberquest-validator'
    }
  }, bodyStr);
}

// ── Ollama ────────────────────────────────────────────────────────────────────
function ollamaGenerate(prompt) {
  const body = JSON.stringify({ model: MODEL, prompt, stream: false });
  const url = new URL('/api/generate', OLLAMA_URL);
  const lib = url.protocol === 'https:' ? https : http;
  return new Promise((resolve, reject) => {
    const opts = {
      hostname: url.hostname,
      port: url.port || 80,
      path: url.pathname,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
    };
    const req = lib.request(opts, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve(JSON.parse(data).response || ''); }
        catch { reject(new Error('Ollama parse error')); }
      });
    });
    req.on('error', reject);
    req.setTimeout(60000, () => { req.destroy(); reject(new Error('Ollama timeout')); });
    req.write(body);
    req.end();
  });
}

// ── Schema validation ─────────────────────────────────────────────────────────
function validateSchema(game) {
  const errors = [];
  const warnings = [];

  if (!game.name)    errors.push('Missing `name` field');
  if (!game.console) errors.push('Missing `console` field');
  if (!game.core)    errors.push('Missing `core` field');
  if (!game.addresses || !Array.isArray(game.addresses)) {
    errors.push('Missing or invalid `addresses` array');
    return { errors, warnings };
  }
  if (game.addresses.length === 0) errors.push('`addresses` array is empty');
  if (game.addresses.length > 64)  warnings.push('Large address count (>64) — consider splitting');

  if (!VALID_CONSOLES.includes(game.console)) {
    warnings.push(`Unknown console: "${game.console}" — check spelling`);
  }

  for (let i = 0; i < game.addresses.length; i++) {
    const a = game.addresses[i];
    if (!a.address) errors.push(`addresses[${i}] missing 'address' field`);
    if (!a.label)   errors.push(`addresses[${i}] missing 'label' field`);
    if (a.address && !/^0x[0-9a-fA-F]+$/.test(a.address)) {
      errors.push(`addresses[${i}] invalid format: ${a.address} (must be 0xNNNN)`);
    }
    if (a.address) {
      const val = parseInt(a.address, 16);
      if (game.console === 'SNES' && val > SNES_WRAM_MAX) {
        warnings.push(`${a.address} (${a.label}) exceeds SNES WRAM range (max 0x3FFF) — verify this is a WRAM offset, not bus address`);
      }
      if (game.console === 'NES' && val > NES_RAM_MAX) {
        warnings.push(`${a.address} (${a.label}) exceeds NES RAM range (max 0x07FF)`);
      }
    }
  }

  return { errors, warnings };
}

// ── AI viability check ────────────────────────────────────────────────────────
async function aiViabilityCheck(game) {
  const addrList = game.addresses.map(a =>
    `  ${a.address}: "${a.label}"${a.description ? ' — ' + a.description : ''}`
  ).join('\n');

  const prompt = `You are reviewing a community-submitted game RAM map for a retro gaming micropayment tool.

Game: ${game.name}
Console: ${game.console}
Recommended core: ${game.core}
Submitted addresses:
${addrList}

Please assess:
1. Are these addresses plausible for this console? (check address ranges)
2. Do the labels make sense for a ${game.console} game?
3. Are there enough addresses to make meaningful game events (min 2-3 useful events)?
4. Any red flags (e.g. all addresses the same, obviously wrong labels, suspiciously high values)?
5. Overall verdict: APPROVED / NEEDS_REVISION / REJECTED

Format your response as:
VERDICT: APPROVED|NEEDS_REVISION|REJECTED
REASON: one sentence summary
DETAILS:
- bullet points of specific feedback

Keep it concise. This will be posted as a GitHub comment.`;

  try {
    const response = await ollamaGenerate(prompt);
    const verdictMatch = response.match(/VERDICT:\s*(APPROVED|NEEDS_REVISION|REJECTED)/i);
    const verdict = verdictMatch ? verdictMatch[1].toUpperCase() : 'NEEDS_REVISION';
    return { verdict, response: response.trim() };
  } catch (e) {
    return { verdict: 'NEEDS_REVISION', response: `⚠️ AI validation unavailable: ${e.message}` };
  }
}

// ── Post GitHub comment ───────────────────────────────────────────────────────
async function postComment(prNumber, body) {
  if (DRY_RUN) {
    console.log(`[DRY RUN] Would post comment to PR #${prNumber}:\n${body}\n`);
    return;
  }
  await ghPost(`/issues/${prNumber}/comments`, { body });
}

async function addLabel(prNumber, labels) {
  if (DRY_RUN) {
    console.log(`[DRY RUN] Would add labels to PR #${prNumber}:`, labels);
    return;
  }
  await ghPost(`/issues/${prNumber}/labels`, { labels });
}

// ── Process a PR ──────────────────────────────────────────────────────────────
async function processPR(pr) {
  console.log(`\nProcessing PR #${pr.number}: ${pr.title}`);

  // Check if we already commented
  const comments = await ghGet(`/issues/${pr.number}/comments`);
  const alreadyValidated = comments.body?.some?.(c => c.body?.includes(BOT_MARKER));
  if (alreadyValidated) {
    console.log(`  Already validated, skipping.`);
    return;
  }

  // Get changed files
  const files = await ghGet(`/pulls/${pr.number}/files`);
  const gameFiles = files.body?.filter?.(f => f.filename.startsWith('games/') && f.filename.endsWith('.json'));

  if (!gameFiles || gameFiles.length === 0) {
    console.log(`  No game JSON files found in PR.`);
    return;
  }

  for (const file of gameFiles) {
    console.log(`  Validating: ${file.filename}`);

    // Fetch raw content
    let game;
    try {
      const rawResp = await request(file.raw_url, {
        headers: { 'User-Agent': 'fiberquest-validator' }
      });
      game = typeof rawResp.body === 'string' ? JSON.parse(rawResp.body) : rawResp.body;
    } catch (e) {
      console.error(`  Failed to fetch file: ${e.message}`);
      continue;
    }

    // Schema validation
    const { errors, warnings } = validateSchema(game);
    console.log(`  Schema: ${errors.length} errors, ${warnings.length} warnings`);

    let aiResult = { verdict: 'NEEDS_REVISION', response: '(AI check skipped — schema errors present)' };
    if (errors.length === 0) {
      console.log(`  Running AI viability check...`);
      aiResult = await aiViabilityCheck(game);
      console.log(`  AI verdict: ${aiResult.verdict}`);
    }

    // Compose comment
    const verdictEmoji = aiResult.verdict === 'APPROVED' ? '✅'
      : aiResult.verdict === 'REJECTED' ? '❌' : '⚠️';
    const schemaSection = errors.length > 0
      ? `\n### ❌ Schema Errors\n${errors.map(e => `- ${e}`).join('\n')}`
      : '\n### ✅ Schema Valid';
    const warningsSection = warnings.length > 0
      ? `\n### ⚠️ Warnings\n${warnings.map(w => `- ${w}`).join('\n')}`
      : '';

    const comment = `${BOT_MARKER}
## 🤖 FiberQuest Validator — \`${file.filename}\`

**Game:** ${game.name || 'Unknown'}  
**Console:** ${game.console || '?'} · **Core:** ${game.core || '?'} · **Addresses:** ${(game.addresses || []).length}
${schemaSection}${warningsSection}

### ${verdictEmoji} AI Viability Check (${MODEL})

${aiResult.response}

---
*Automated check by [FiberQuest validator](https://github.com/toastmanAu/ram-viewer/blob/main/pr-validator.js). Final merge decision is made by a human maintainer.*`;

    await postComment(pr.number, comment);

    // Add label
    const label = errors.length > 0 ? 'needs-review'
      : aiResult.verdict === 'APPROVED' ? 'validated'
      : 'needs-review';
    await addLabel(pr.number, [label]);
    console.log(`  Labelled: ${label}`);
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  if (!GH_TOKEN) {
    console.error('Error: GITHUB_TOKEN env var not set');
    process.exit(1);
  }

  console.log(`FiberQuest PR Validator`);
  console.log(`Repo: ${OWNER}/${REPO}`);
  console.log(`AI: ${MODEL} @ ${OLLAMA_URL}`);
  if (DRY_RUN) console.log('DRY RUN — no GitHub writes');
  console.log('─'.repeat(50));

  const prs = await ghGet('/pulls?state=open&per_page=30');
  if (!Array.isArray(prs.body)) {
    console.error('Failed to fetch PRs:', prs.body);
    process.exit(1);
  }

  const gamePRs = prs.body.filter(pr =>
    pr.title.toLowerCase().includes('game') ||
    pr.title.toLowerCase().includes('submission') ||
    pr.labels?.some(l => l.name === 'game-submission')
  );

  console.log(`Found ${gamePRs.length} game-related PRs`);

  for (const pr of gamePRs) {
    await processPR(pr);
  }

  console.log('\n✅ Done');
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
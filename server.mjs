#!/usr/bin/env node
// Crucix Intelligence Engine — Dev Server
// Serves the Jarvis dashboard, runs sweep cycle, pushes live updates via SSE

import express from 'express';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { exec } from 'child_process';
import config from './crucix.config.mjs';
import { fullBriefing } from './apis/briefing.mjs';
import { briefing as yfinanceBrief } from './apis/sources/yfinance.mjs';
import { synthesize, generateIdeas } from './dashboard/inject.mjs';
import { MemoryManager } from './lib/delta/index.mjs';
import { createLLMProvider } from './lib/llm/index.mjs';
import { generateLLMIdeas } from './lib/llm/ideas.mjs';
import { batchTranslate } from './lib/llm/translate.mjs';
import { TelegramAlerter } from './lib/alerts/telegram.mjs';
import { DiscordAlerter } from './lib/alerts/discord.mjs';
import { FeishuAlerter } from './lib/alerts/feishu.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = __dirname;
const RUNS_DIR = join(ROOT, 'runs');
const MEMORY_DIR = join(RUNS_DIR, 'memory');

// Ensure directories exist
for (const dir of [RUNS_DIR, MEMORY_DIR, join(MEMORY_DIR, 'cold')]) {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

// === State ===
let currentData = null;    // Current synthesized dashboard data
let lastSweepTime = null;  // Timestamp of last sweep
let sweepStartedAt = null; // Timestamp when current/last sweep started
let sweepInProgress = false;
const startTime = Date.now();
const sseClients = new Set();

// === Delta/Memory ===
const memory = new MemoryManager(RUNS_DIR);

// === LLM + Telegram + Discord ===
let llmProvider = createLLMProvider(config.llm);
const telegramAlerter = new TelegramAlerter(config.telegram);
const discordAlerter = new DiscordAlerter(config.discord || {});
const feishuAlerter = new FeishuAlerter(config.feishu || {});

if (llmProvider) console.log(`[Crucix] LLM enabled: ${llmProvider.name} (${llmProvider.model})`);
if (telegramAlerter.isConfigured) {
  console.log('[Crucix] Telegram alerts enabled');

  // ─── Two-Way Bot Commands ───────────────────────────────────────────────

  telegramAlerter.onCommand('/status', async () => {
    const uptime = Math.floor((Date.now() - startTime) / 1000);
    const h = Math.floor(uptime / 3600);
    const m = Math.floor((uptime % 3600) / 60);
    const sourcesOk = currentData?.meta?.sourcesOk || 0;
    const sourcesTotal = currentData?.meta?.sourcesQueried || 0;
    const sourcesFailed = currentData?.meta?.sourcesFailed || 0;
    const llmStatus = llmProvider?.isConfigured ? `✅ ${llmProvider.name}` : '❌ Disabled';
    const nextSweep = lastSweepTime
      ? new Date(new Date(lastSweepTime).getTime() + config.refreshIntervalMinutes * 60000).toLocaleTimeString()
      : 'pending';

    return [
      `🖥️ *CRUCIX STATUS*`,
      ``,
      `Uptime: ${h}h ${m}m`,
      `Last sweep: ${lastSweepTime ? new Date(lastSweepTime).toLocaleTimeString() + ' UTC' : 'never'}`,
      `Next sweep: ${nextSweep} UTC`,
      `Sweep in progress: ${sweepInProgress ? '🔄 Yes' : '⏸️ No'}`,
      `Sources: ${sourcesOk}/${sourcesTotal} OK${sourcesFailed > 0 ? ` (${sourcesFailed} failed)` : ''}`,
      `LLM: ${llmStatus}`,
      `SSE clients: ${sseClients.size}`,
      `Dashboard: http://localhost:${config.port}`,
    ].join('\n');
  });

  telegramAlerter.onCommand('/sweep', async () => {
    if (sweepInProgress) return '🔄 Sweep already in progress. Please wait.';
    // Fire and forget — don't block the bot response
    runSweepCycle().catch(err => console.error('[Crucix] Manual sweep failed:', err.message));
    return '🚀 Manual sweep triggered. You\'ll receive alerts if anything significant is detected.';
  });

  telegramAlerter.onCommand('/brief', async () => {
    if (!currentData) return '⏳ No data yet — waiting for first sweep to complete.';

    const tg = currentData.tg || {};
    const energy = currentData.energy || {};
    const delta = memory.getLastDelta();
    const ideas = (currentData.ideas || []).slice(0, 3);

    const sections = [
      `📋 *CRUCIX BRIEF*`,
      `_${new Date().toISOString().replace('T', ' ').substring(0, 19)} UTC_`,
      ``,
    ];

    // Delta direction
    if (delta?.summary) {
      const dirEmoji = { 'risk-off': '📉', 'risk-on': '📈', 'mixed': '↔️' }[delta.summary.direction] || '↔️';
      sections.push(`${dirEmoji} Direction: *${delta.summary.direction.toUpperCase()}* | ${delta.summary.totalChanges} changes, ${delta.summary.criticalChanges} critical`);
      sections.push('');
    }

    // Key metrics
    const vix = currentData.fred?.find(f => f.id === 'VIXCLS');
    const hy = currentData.fred?.find(f => f.id === 'BAMLH0A0HYM2');
    if (vix || energy.wti) {
      sections.push(`📊 VIX: ${vix?.value || '--'} | WTI: $${energy.wti || '--'} | Brent: $${energy.brent || '--'}`);
      if (hy) sections.push(`   HY Spread: ${hy.value} | NatGas: $${energy.natgas || '--'}`);
      sections.push('');
    }

    // OSINT
    if (tg.urgent?.length > 0) {
      sections.push(`📡 OSINT: ${tg.urgent.length} urgent signals, ${tg.posts || 0} total posts`);
      // Top 2 urgent
      for (const p of tg.urgent.slice(0, 2)) {
        sections.push(`  • ${(p.text || '').substring(0, 80)}`);
      }
      sections.push('');
    }

    // Top ideas
    if (ideas.length > 0) {
      sections.push(`💡 *Top Ideas:*`);
      for (const idea of ideas) {
        sections.push(`  ${idea.type === 'long' ? '📈' : idea.type === 'hedge' ? '🛡️' : '👁️'} ${idea.title}`);
      }
    }

    return sections.join('\n');
  });

  telegramAlerter.onCommand('/portfolio', async () => {
    return '📊 Portfolio integration requires Alpaca MCP connection.\nUse the Crucix dashboard or Claude agent for portfolio queries.';
  });

  // Start polling for bot commands
  telegramAlerter.startPolling(config.telegram.botPollingInterval);
}

// === Discord Bot ===
if (discordAlerter.isConfigured) {
  console.log('[Crucix] Discord bot enabled');

  // Reuse the same command handlers as Telegram (DRY)
  discordAlerter.onCommand('status', async () => {
    const uptime = Math.floor((Date.now() - startTime) / 1000);
    const h = Math.floor(uptime / 3600);
    const m = Math.floor((uptime % 3600) / 60);
    const sourcesOk = currentData?.meta?.sourcesOk || 0;
    const sourcesTotal = currentData?.meta?.sourcesQueried || 0;
    const sourcesFailed = currentData?.meta?.sourcesFailed || 0;
    const llmStatus = llmProvider?.isConfigured ? `✅ ${llmProvider.name}` : '❌ Disabled';
    const nextSweep = lastSweepTime
      ? new Date(new Date(lastSweepTime).getTime() + config.refreshIntervalMinutes * 60000).toLocaleTimeString()
      : 'pending';

    return [
      `**🖥️ CRUCIX STATUS**\n`,
      `Uptime: ${h}h ${m}m`,
      `Last sweep: ${lastSweepTime ? new Date(lastSweepTime).toLocaleTimeString() + ' UTC' : 'never'}`,
      `Next sweep: ${nextSweep} UTC`,
      `Sweep in progress: ${sweepInProgress ? '🔄 Yes' : '⏸️ No'}`,
      `Sources: ${sourcesOk}/${sourcesTotal} OK${sourcesFailed > 0 ? ` (${sourcesFailed} failed)` : ''}`,
      `LLM: ${llmStatus}`,
      `SSE clients: ${sseClients.size}`,
      `Dashboard: http://localhost:${config.port}`,
    ].join('\n');
  });

  discordAlerter.onCommand('sweep', async () => {
    if (sweepInProgress) return '🔄 Sweep already in progress. Please wait.';
    runSweepCycle().catch(err => console.error('[Crucix] Manual sweep failed:', err.message));
    return '🚀 Manual sweep triggered. You\'ll receive alerts if anything significant is detected.';
  });

  discordAlerter.onCommand('brief', async () => {
    if (!currentData) return '⏳ No data yet — waiting for first sweep to complete.';

    const tg = currentData.tg || {};
    const energy = currentData.energy || {};
    const delta = memory.getLastDelta();
    const ideas = (currentData.ideas || []).slice(0, 3);

    const sections = [`**📋 CRUCIX BRIEF**\n_${new Date().toISOString().replace('T', ' ').substring(0, 19)} UTC_\n`];

    if (delta?.summary) {
      const dirEmoji = { 'risk-off': '📉', 'risk-on': '📈', 'mixed': '↔️' }[delta.summary.direction] || '↔️';
      sections.push(`${dirEmoji} Direction: **${delta.summary.direction.toUpperCase()}** | ${delta.summary.totalChanges} changes, ${delta.summary.criticalChanges} critical\n`);
    }

    const vix = currentData.fred?.find(f => f.id === 'VIXCLS');
    const hy = currentData.fred?.find(f => f.id === 'BAMLH0A0HYM2');
    if (vix || energy.wti) {
      sections.push(`📊 VIX: ${vix?.value || '--'} | WTI: $${energy.wti || '--'} | Brent: $${energy.brent || '--'}`);
      if (hy) sections.push(`   HY Spread: ${hy.value} | NatGas: $${energy.natgas || '--'}`);
      sections.push('');
    }

    if (tg.urgent?.length > 0) {
      sections.push(`📡 OSINT: ${tg.urgent.length} urgent signals, ${tg.posts || 0} total posts`);
      for (const p of tg.urgent.slice(0, 2)) {
        sections.push(`  • ${(p.text || '').substring(0, 80)}`);
      }
      sections.push('');
    }

    if (ideas.length > 0) {
      sections.push(`**💡 Top Ideas:**`);
      for (const idea of ideas) {
        sections.push(`  ${idea.type === 'long' ? '📈' : idea.type === 'hedge' ? '🛡️' : '👁️'} ${idea.title}`);
      }
    }

    return sections.join('\n');
  });

  discordAlerter.onCommand('portfolio', async () => {
    return '📊 Portfolio integration requires Alpaca MCP connection.\nUse the Crucix dashboard or Claude agent for portfolio queries.';
  });

  // Start the Discord bot (non-blocking — connection happens async)
  discordAlerter.start().catch(err => {
    console.error('[Crucix] Discord bot startup failed (non-fatal):', err.message);
  });
}
if (feishuAlerter.isConfigured) {
  console.log('[Crucix] Feishu alerts enabled');
}

// === Express Server ===
const app = express();
app.use(express.json());
app.use(express.static(join(ROOT, 'dashboard/public')));

// Serve loading page until first sweep completes, then the dashboard
app.get('/', (req, res) => {
  if (!currentData) {
    res.sendFile(join(ROOT, 'dashboard/public/loading.html'));
  } else {
    res.sendFile(join(ROOT, 'dashboard/public/jarvis.html'));
  }
});

// API: current data
app.get('/api/data', (req, res) => {
  if (!currentData) return res.status(503).json({ error: 'No data yet — first sweep in progress' });
  res.json(currentData);
});

// API: health check
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    uptime: Math.floor((Date.now() - startTime) / 1000),
    lastSweep: lastSweepTime,
    nextSweep: lastSweepTime
      ? new Date(new Date(lastSweepTime).getTime() + config.refreshIntervalMinutes * 60000).toISOString()
      : null,
    sweepInProgress,
    sweepStartedAt,
    sourcesOk: currentData?.meta?.sourcesOk || 0,
    sourcesFailed: currentData?.meta?.sourcesFailed || 0,
    llmEnabled: !!config.llm.provider,
    llmProvider: config.llm.provider,
    telegramEnabled: !!(config.telegram.botToken && config.telegram.chatId),
    discordEnabled: !!(config.discord.botToken || config.discord.webhookUrl),
    feishuEnabled: !!(config.feishu.webhookUrl || (config.feishu.appId && config.feishu.appSecret && (config.feishu.receiveId || config.feishu.receiveMobile || config.feishu.receiveEmail))),
    refreshIntervalMinutes: config.refreshIntervalMinutes,
    marketRefreshMinutes: config.marketRefreshMinutes,
  });
});

// API: get config
app.get('/api/config', (req, res) => {
  res.json({
    llmProvider: config.llm.provider,
    llmApiKey: config.llm.apiKey,
    llmModel: config.llm.model
  });
});

// API: save config
app.post('/api/config', (req, res) => {
  try {
    const { provider, apiKey, model } = req.body;
    
    // Update config object in memory
    config.llm.provider = provider || null;
    config.llm.apiKey = apiKey || null;
    config.llm.model = model || null;
    
    // Update LLM Provider instance
    llmProvider = createLLMProvider(config.llm);
    if (llmProvider) {
      console.log(`[Crucix] LLM dynamically updated to: ${llmProvider.name} (${llmProvider.model})`);
    } else {
      console.log(`[Crucix] LLM disabled via config`);
    }

    if (currentData) {
      currentData.ideasSource = llmProvider?.isConfigured ? 'pending' : 'disabled';
      broadcast({ type: 'update', data: currentData });
    }

    // Write back to .env
    const envPath = join(ROOT, '.env');
    let envContent = '';
    if (existsSync(envPath)) {
      envContent = readFileSync(envPath, 'utf8');
    }

    // Update or append variables
    const updateEnv = (key, value) => {
      const regex = new RegExp(`^${key}=.*$`, 'm');
      const newValue = `${key}=${value || ''}`;
      if (regex.test(envContent)) {
        envContent = envContent.replace(regex, newValue);
      } else {
        envContent += `\n${newValue}`;
      }
    };

    updateEnv('LLM_PROVIDER', provider);
    updateEnv('LLM_API_KEY', apiKey);
    updateEnv('LLM_MODEL', model);

    writeFileSync(envPath, envContent.trim() + '\n');

    if (llmProvider?.isConfigured && !sweepInProgress) {
      runSweepCycle().catch(err => console.error('[Crucix] Auto sweep after config save failed:', err.message));
    }
    
    res.json({ success: true, llmEnabled: !!llmProvider?.isConfigured });
  } catch (err) {
    console.error('[Crucix] Failed to save config:', err);
    res.status(500).json({ error: 'Failed to save configuration' });
  }
});

// API: ad-hoc translate (frontend may request missing CN fields)
app.post('/api/translate', async (req, res) => {
  try {
    const { texts, targetLang } = req.body || {};
    if (!Array.isArray(texts) || texts.length === 0) return res.status(400).json({ error: 'texts array required' });
    if (!llmProvider?.isConfigured) return res.status(400).json({ error: 'LLM not configured' });
    const items = texts.map(t => ({ v: String(t || '') }));
    await batchTranslate(llmProvider, items, (i) => i.v, (i, tr) => { i.v = tr; }, targetLang || 'zh-CN');
    res.json({ texts: items.map(i => i.v) });
  } catch (err) {
    console.error('[Crucix] /api/translate failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// API: test config
app.post('/api/config/test', async (req, res) => {
  try {
    const { provider, apiKey, model } = req.body;
    if (!provider || !apiKey) {
      return res.status(400).json({ success: false, error: 'Provider and API Key required' });
    }

    const testProvider = createLLMProvider({ provider, apiKey, model });
    if (!testProvider) {
      return res.status(400).json({ success: false, error: 'Invalid provider configuration' });
    }

    const result = await testProvider.complete('You are a helpful assistant.', 'Please reply with exactly one word: Pong', { maxTokens: 128, timeout: 20000 });
    
    if (result && (result.text || result.model)) {
      res.json({ success: true, message: result.text || 'Connected' });
    } else {
      res.status(500).json({ success: false, error: 'Empty response from LLM' });
    }
  } catch (err) {
    console.error('[Crucix] LLM Test failed:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// SSE: live updates
app.get('/events', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'Access-Control-Allow-Origin': '*',
  });
  res.write('data: {"type":"connected"}\n\n');
  sseClients.add(res);
  req.on('close', () => sseClients.delete(res));
});

function broadcast(data) {
  const msg = `data: ${JSON.stringify(data)}\n\n`;
  for (const client of sseClients) {
    try { client.write(msg); } catch { sseClients.delete(client); }
  }
}

// === Sweep Cycle ===
async function runSweepCycle() {
  if (sweepInProgress) {
    console.log('[Crucix] Sweep already in progress, skipping');
    return;
  }

  sweepInProgress = true;
  sweepStartedAt = new Date().toISOString();
  broadcast({ type: 'sweep_start', timestamp: sweepStartedAt });
  console.log(`\n${'='.repeat(60)}`);
  console.log(`[Crucix] Starting sweep at ${new Date().toLocaleTimeString()}`);
  console.log(`${'='.repeat(60)}`);

  try {
    // 1. Run the full briefing sweep
    const rawData = await fullBriefing();

    // 2. Save to runs/latest.json
    writeFileSync(join(RUNS_DIR, 'latest.json'), JSON.stringify(rawData, null, 2));
    lastSweepTime = new Date().toISOString();

    // 3. Synthesize into dashboard format
    console.log('[Crucix] Synthesizing dashboard data...');
    const synthesized = await synthesize(rawData);

    // 4. Delta computation + memory
    const delta = memory.addRun(synthesized);
    synthesized.delta = delta;

    // 5. LLM-powered trade ideas (LLM-only feature) — isolated so failures don't kill sweep
    if (llmProvider?.isConfigured) {
      try {
        console.log('[Crucix] Generating LLM trade ideas...');
        const previousIdeas = memory.getLastRun()?.ideas || [];
        const llmIdeas = await generateLLMIdeas(llmProvider, synthesized, delta, previousIdeas);
        if (llmIdeas) {
          synthesized.ideas = llmIdeas;
          synthesized.ideasSource = 'llm';
          console.log(`[Crucix] LLM generated ${llmIdeas.length} ideas`);
        } else {
          synthesized.ideas = [];
          synthesized.ideasSource = 'llm-failed';
        }
      } catch (llmErr) {
        console.error('[Crucix] LLM ideas failed (non-fatal):', llmErr.message);
        synthesized.ideas = [];
        synthesized.ideasSource = 'llm-failed';
      }

      // 5.5 Translate Ideas and News to Chinese if LLM is available
      try {
        console.log('[Crucix] Translating content to Chinese...');
        // Translate Ideas (titles / rationale / risk independently to avoid JSON parsing issues)
        if (synthesized.ideas && synthesized.ideas.length > 0) {
          await batchTranslate(llmProvider, synthesized.ideas, (i) => String(i.title || ''), (i, tr) => { i.title_cn = tr; });
          await batchTranslate(llmProvider, synthesized.ideas, (i) => String(i.rationale || i.text || ''), (i, tr) => { i.rationale_cn = tr; });
          await batchTranslate(llmProvider, synthesized.ideas, (i) => String(i.risk || ''), (i, tr) => { i.risk_cn = tr; });
        }
        // Translate top 15 news items to save time/tokens
        if (synthesized.newsFeed && synthesized.newsFeed.length > 0) {
          const topNews = synthesized.newsFeed.slice(0, 15);
          await batchTranslate(
            llmProvider,
            topNews,
            (news) => news.headline,
            (news, translated) => { news.headline_cn = translated; }
          );
        }
        if (synthesized.tg) {
          const urgent = (synthesized.tg.urgent || []).slice(0, 20);
          const topPosts = (synthesized.tg.topPosts || []).slice(0, 20);
          if (urgent.length > 0) {
            await batchTranslate(llmProvider, urgent, (p) => String(p.text || ''), (p, tr) => { p.text_cn = tr; });
          }
          if (topPosts.length > 0) {
            await batchTranslate(llmProvider, topPosts, (p) => String(p.text || ''), (p, tr) => { p.text_cn = tr; });
          }
        }
        if (synthesized.who && synthesized.who.length > 0) {
          const whoItems = synthesized.who.slice(0, 10);
          await batchTranslate(llmProvider, whoItems, (w) => String(w.title || ''), (w, tr) => { w.title_cn = tr; });
        }
      } catch (trErr) {
        console.error('[Crucix] Translation failed (non-fatal):', trErr.message);
      }
    } else {
      synthesized.ideas = [];
      synthesized.ideasSource = 'disabled';
    }

    // 6. Alert evaluation — Telegram + Discord (LLM with rule-based fallback, multi-tier, semantic dedup)
    if (delta?.summary?.totalChanges > 0) {
      if (telegramAlerter.isConfigured) {
        telegramAlerter.evaluateAndAlert(llmProvider, delta, memory).catch(err => {
          console.error('[Crucix] Telegram alert error:', err.message);
        });
      }
      if (discordAlerter.isConfigured) {
        discordAlerter.evaluateAndAlert(llmProvider, delta, memory).catch(err => {
          console.error('[Crucix] Discord alert error:', err.message);
        });
      }
      if (feishuAlerter.isConfigured) {
        feishuAlerter.evaluateAndAlert(llmProvider, delta, memory).catch(err => {
          console.error('[Crucix] Feishu alert error:', err.message);
        });
      }
    }

    // Prune old alerted signals
    memory.pruneAlertedSignals();

    currentData = synthesized;

    // 6. Push to all connected browsers
    broadcast({ type: 'update', data: currentData });

    console.log(`[Crucix] Sweep complete — ${currentData.meta.sourcesOk}/${currentData.meta.sourcesQueried} sources OK`);
    console.log(`[Crucix] ${currentData.ideas.length} ideas (${synthesized.ideasSource}) | ${currentData.news.length} news | ${currentData.newsFeed.length} feed items`);
    if (delta?.summary) console.log(`[Crucix] Delta: ${delta.summary.totalChanges} changes, ${delta.summary.criticalChanges} critical, direction: ${delta.summary.direction}`);
    console.log(`[Crucix] Next sweep at ${new Date(Date.now() + config.refreshIntervalMinutes * 60000).toLocaleTimeString()}`);

  } catch (err) {
    console.error('[Crucix] Sweep failed:', err.message);
    broadcast({ type: 'sweep_error', error: err.message });
  } finally {
    sweepInProgress = false;
  }
}

// === Startup ===
async function start() {
  const port = config.port;

  console.log(`
  ╔══════════════════════════════════════════════╗
  ║           CRUCIX INTELLIGENCE ENGINE         ║
  ║          Local Palantir · 26 Sources         ║
  ╠══════════════════════════════════════════════╣
  ║  Dashboard:  http://localhost:${port}${' '.repeat(14 - String(port).length)}║
  ║  Health:     http://localhost:${port}/api/health${' '.repeat(4 - String(port).length)}║
  ║  Refresh:    Every ${config.refreshIntervalMinutes} min${' '.repeat(20 - String(config.refreshIntervalMinutes).length)}║
  ║  LLM:        ${(config.llm.provider || 'disabled').padEnd(31)}║
  ║  Telegram:   ${config.telegram.botToken ? 'enabled' : 'disabled'}${' '.repeat(config.telegram.botToken ? 24 : 23)}║
  ║  Discord:    ${config.discord?.botToken ? 'enabled' : config.discord?.webhookUrl ? 'webhook only' : 'disabled'}${' '.repeat(config.discord?.botToken ? 24 : config.discord?.webhookUrl ? 20 : 23)}║
  ╚══════════════════════════════════════════════╝
  `);

  const server = app.listen(port);

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`\n[Crucix] FATAL: Port ${port} is already in use!`);
      console.error(`[Crucix] A previous Crucix instance may still be running.`);
      console.error(`[Crucix] Fix:  taskkill /F /IM node.exe   (Windows)`);
      console.error(`[Crucix]       kill $(lsof -ti:${port})   (macOS/Linux)`);
      console.error(`[Crucix] Or change PORT in .env\n`);
    } else {
      console.error(`[Crucix] Server error:`, err.stack || err.message);
    }
    process.exit(1);
  });

  server.on('listening', () => {
    console.log(`[Crucix] Server running on http://localhost:${port}`);

    // Auto-open browser
    // NOTE: On Windows, `start` in PowerShell is an alias for Start-Service, not cmd's start.
    // We must use `cmd /c start ""` to ensure it works in both cmd.exe and PowerShell.
    const openCmd = process.platform === 'win32' ? 'cmd /c start ""' :
                    process.platform === 'darwin' ? 'open' : 'xdg-open';
    exec(`${openCmd} "http://localhost:${port}"`, (err) => {
      if (err) console.log('[Crucix] Could not auto-open browser:', err.message);
    });

    // Try to load existing data first for instant display
    try {
      const existing = JSON.parse(readFileSync(join(RUNS_DIR, 'latest.json'), 'utf8'));
      synthesize(existing).then(data => {
        currentData = data;
        console.log('[Crucix] Loaded existing data from runs/latest.json');
        broadcast({ type: 'update', data: currentData });
      }).catch(() => {});
    } catch { /* no existing data */ }

    // Run first sweep
    console.log('[Crucix] Running initial sweep...');
    runSweepCycle().catch(err => {
      console.error('[Crucix] Initial sweep failed:', err.message || err);
    });

    // Schedule recurring sweeps
    setInterval(runSweepCycle, config.refreshIntervalMinutes * 60 * 1000);
    setInterval(async () => {
      try {
        const yf = await yfinanceBrief();
        if (!yf || !currentData) return;
        const quotes = yf.quotes || {};
        const mk = {
          indexes: (yf.indexes || []).map(q => ({
            symbol: q.symbol, name: q.name, price: q.price,
            change: q.change, changePct: q.changePct, history: q.history || [], currency: quotes[q.symbol]?.currency || q.currency
          })),
          rates: (yf.rates || []).map(q => ({
            symbol: q.symbol, name: q.name, price: q.price,
            change: q.change, changePct: q.changePct, currency: quotes[q.symbol]?.currency || q.currency
          })),
          commodities: (yf.commodities || []).map(q => ({
            symbol: q.symbol, name: q.name, price: q.price,
            change: q.change, changePct: q.changePct, history: q.history || [], currency: quotes[q.symbol]?.currency || q.currency
          })),
          crypto: (yf.crypto || []).map(q => ({
            symbol: q.symbol, name: q.name, price: q.price,
            change: q.change, changePct: q.changePct, currency: quotes[q.symbol]?.currency || q.currency
          })),
          vix: quotes['^VIX'] ? {
            value: quotes['^VIX'].price,
            change: quotes['^VIX'].change,
            changePct: quotes['^VIX'].changePct,
          } : null,
          timestamp: yf.summary?.timestamp || new Date().toISOString(),
        };
        currentData.markets = mk;
        broadcast({ type: 'update', data: currentData });
      } catch {}
    }, Math.max(1, config.marketRefreshMinutes) * 60 * 1000);
  });
}

// Graceful error handling — log full stack traces for diagnosis
process.on('unhandledRejection', (err) => {
  console.error('[Crucix] Unhandled rejection:', err?.stack || err?.message || err);
});
process.on('uncaughtException', (err) => {
  console.error('[Crucix] Uncaught exception:', err?.stack || err?.message || err);
});

start().catch(err => {
  console.error('[Crucix] FATAL — Server failed to start:', err?.stack || err?.message || err);
  process.exit(1);
});

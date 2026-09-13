"use strict";

const { addLog, getLogs, clearLogs } = require("./logger");
const mineflayer = require("mineflayer");
const { Movements, pathfinder, goals } = require("mineflayer-pathfinder");
const { GoalBlock, GoalNear } = goals;
const config = require("./settings.json");
const express = require("express");

// ============================================================
// STATE
// ============================================================
const app = express();
app.use(express.json());
const PORT = process.env.PORT || 5000;

let bot = null;
let antiAfkTimer = null;
let chatTimer = null;
let reconnectTimer = null;
let stopRequested = false; // true when user explicitly hit "Stop bot"

let botState = {
  connected: false,
  spawned: false,
  lastActivity: Date.now(),
  reconnectAttempts: 0,
  startTime: Date.now(),
  errors: [],
  wasThrottled: false,
  health: null,
  food: null,
  players: [],
};

function resetStateOnNewSession() {
  botState.startTime = Date.now();
  botState.reconnectAttempts = 0;
}

// ============================================================
// BOT LIFECYCLE
// ============================================================
function createBot() {
  if (bot) {
    try { bot.removeAllListeners(); bot.end(); } catch (_) {}
  }

  addLog(`Connecting to ${config.server.ip}:${config.server.port} as ${config.bot.username}...`);

  bot = mineflayer.createBot({
    host: config.server.ip,
    port: config.server.port,
    username: config.bot.username,
    version: config.server.version || false,
    auth: config.bot.auth || "offline",
  });

  bot.loadPlugin(pathfinder);

  bot.once("spawn", () => {
    botState.connected = true;
    botState.spawned = true;
    botState.wasThrottled = false;
    resetStateOnNewSession();
    addLog(`Bot spawned in world as ${bot.username}`, "success");

    try {
      const mcData = require("minecraft-data")(bot.version);
      const movements = new Movements(bot, mcData);
      bot.pathfinder.setMovements(movements);
    } catch (e) {
      addLog(`Could not initialize pathfinder movements: ${e.message}`, "warn");
    }

    startAntiAfk();
    startChatLoop();
  });

  bot.on("health", () => {
    botState.health = bot.health;
    botState.food = bot.food;
    if (bot.health <= 0) {
      addLog("Bot has died.", "warn");
    }
  });

  bot.on("death", () => {
    addLog("Bot died and will respawn.", "warn");
    if (config.autoRespawn) {
      try { bot.respawn(); } catch (_) {}
    }
  });

  bot.on("chat", (username, message) => {
    if (username === bot.username) return;
    if (config.logging && config.logging.logChat !== false) {
      addLog(`<${username}> ${message}`);
    }
    botState.lastActivity = Date.now();
  });

  bot.on("playerJoined", (player) => {
    addLog(`${player.username} joined the server.`);
    refreshPlayerList();
  });

  bot.on("playerLeft", (player) => {
    addLog(`${player.username} left the server.`);
    refreshPlayerList();
  });

  bot.on("kicked", (reason) => {
    botState.connected = false;
    botState.spawned = false;
    let reasonText;
    try {
      const parsed = typeof reason === "string" ? JSON.parse(reason) : reason;
      reasonText = parsed.text || JSON.stringify(parsed);
    } catch (_) {
      reasonText = String(reason);
    }
    addLog(`Bot was kicked: ${reasonText}`, "error");
    if (/wait before reconnecting|throttl/i.test(reasonText)) {
      botState.wasThrottled = true;
    }
    stopAntiAfk();
    stopChatLoop();
    scheduleReconnect();
  });

  bot.on("end", (reason) => {
    botState.connected = false;
    botState.spawned = false;
    addLog(`Connection ended${reason ? `: ${reason}` : "."}`, "warn");
    stopAntiAfk();
    stopChatLoop();
    scheduleReconnect();
  });

  bot.on("error", (err) => {
    const message = err && err.message ? err.message : String(err);
    botState.errors.push({ time: Date.now(), message });
    if (botState.errors.length > 20) botState.errors.shift();
    addLog(`Bot error: ${message}`, "error");
  });
}

function refreshPlayerList() {
  if (!bot || !bot.players) return;
  botState.players = Object.keys(bot.players).filter((name) => name !== bot.username);
}

function scheduleReconnect() {
  if (stopRequested) {
    addLog("Reconnect skipped: bot was manually stopped.");
    return;
  }
  if (!config.autoReconnect) {
    addLog("Auto-reconnect is disabled in settings.json.");
    return;
  }
  if (config.maxReconnectAttempts && botState.reconnectAttempts >= config.maxReconnectAttempts) {
    addLog(`Reached max reconnect attempts (${config.maxReconnectAttempts}). Giving up.`, "error");
    return;
  }

  clearTimeout(reconnectTimer);
  botState.reconnectAttempts += 1;

  // Back off further if we were throttled by the server
  const baseDelay = (config.reconnectDelaySeconds || 10) * 1000;
  const delay = botState.wasThrottled ? Math.max(baseDelay, 60000) : baseDelay;

  addLog(`Reconnecting in ${Math.round(delay / 1000)}s (attempt ${botState.reconnectAttempts})...`);
  reconnectTimer = setTimeout(() => {
    if (!stopRequested) createBot();
  }, delay);
}

// ============================================================
// ANTI-AFK
// ============================================================
function startAntiAfk() {
  stopAntiAfk();
  if (!config.antiAfk || !config.antiAfk.enabled) return;

  const interval = Math.max(5, config.antiAfk.intervalSeconds || 20) * 1000;
  const actions = config.antiAfk.actions && config.antiAfk.actions.length
    ? config.antiAfk.actions
    : ["jump", "lookAround"];

  antiAfkTimer = setInterval(() => {
    if (!bot || !botState.spawned) return;
    try {
      const action = actions[Math.floor(Math.random() * actions.length)];
      performAntiAfkAction(action);
    } catch (e) {
      addLog(`Anti-AFK action failed: ${e.message}`, "warn");
    }
  }, interval);
}

function performAntiAfkAction(action) {
  switch (action) {
    case "jump":
      bot.setControlState("jump", true);
      setTimeout(() => bot.setControlState("jump", false), 400);
      break;
    case "sneak":
      bot.setControlState("sneak", true);
      setTimeout(() => bot.setControlState("sneak", false), 800);
      break;
    case "swingArm":
      bot.swingArm();
      break;
    case "lookAround": {
      const yaw = Math.random() * Math.PI * 2;
      const pitch = (Math.random() - 0.5) * 0.5;
      bot.look(yaw, pitch, true);
      break;
    }
    case "walk": {
      const dir = Math.random() < 0.5 ? "forward" : "back";
      bot.setControlState(dir, true);
      setTimeout(() => bot.setControlState(dir, false), 600);
      break;
    }
    default:
      break;
  }
}

function stopAntiAfk() {
  if (antiAfkTimer) clearInterval(antiAfkTimer);
  antiAfkTimer = null;
}

// ============================================================
// PERIODIC CHAT
// ============================================================
function startChatLoop() {
  stopChatLoop();
  if (!config.chat || !config.chat.enabled) return;
  const interval = Math.max(1, config.chat.intervalMinutes || 30) * 60 * 1000;
  const messages = config.chat.messages && config.chat.messages.length
    ? config.chat.messages
    : ["I'm still here!"];

  chatTimer = setInterval(() => {
    if (!bot || !botState.spawned) return;
    const msg = messages[Math.floor(Math.random() * messages.length)];
    bot.chat(msg);
  }, interval);
}

function stopChatLoop() {
  if (chatTimer) clearInterval(chatTimer);
  chatTimer = null;
}

// ============================================================
// CONSOLE / IN-GAME COMMANDS (used by the /logs dashboard console)
// ============================================================
const HELP_TEXT = [
  "/help            - Show this list",
  "/pos             - Show bot's current coordinates",
  "/status          - Show connection status & uptime",
  "/list            - List players currently online",
  "/say <message>   - Send a chat message in-game",
  "/goto <x> <y> <z>- Walk the bot to coordinates",
  "/come            - Walk the bot to the last player who chatted",
  "/stop            - Halt current pathfinder movement",
  "/reconnect       - Force a reconnect right now",
  "/clear           - Clear the log console",
].join("\n");

let lastChatter = null;

function handleCommand(raw) {
  const trimmed = raw.trim();
  if (!trimmed) return { success: false, msg: "Empty command." };

  const [cmd, ...args] = trimmed.split(/\s+/);
  const lower = cmd.toLowerCase();

  switch (lower) {
    case "/help":
      return { success: true, msg: HELP_TEXT };

    case "/status": {
      const uptime = Math.floor((Date.now() - botState.startTime) / 1000);
      return {
        success: true,
        msg: `Connected: ${botState.connected}\nSpawned: ${botState.spawned}\nUptime: ${uptime}s\nReconnect attempts: ${botState.reconnectAttempts}\nHealth: ${botState.health ?? "n/a"}  Food: ${botState.food ?? "n/a"}`,
      };
    }

    case "/pos": {
      if (!bot || !bot.entity) return { success: false, msg: "Bot is not connected." };
      const { x, y, z } = bot.entity.position;
      return { success: true, msg: `X ${x.toFixed(1)}, Y ${y.toFixed(1)}, Z ${z.toFixed(1)}` };
    }

    case "/list": {
      refreshPlayerList();
      if (!botState.players.length) return { success: true, msg: "No other players online." };
      return { success: true, msg: `Online (${botState.players.length}): ${botState.players.join(", ")}` };
    }

    case "/say": {
      if (!bot || !botState.spawned) return { success: false, msg: "Bot is not connected." };
      const message = args.join(" ");
      if (!message) return { success: false, msg: "Usage: /say <message>" };
      bot.chat(message);
      return { success: true, msg: `Sent: ${message}` };
    }

    case "/goto": {
      if (!bot || !botState.spawned) return { success: false, msg: "Bot is not connected." };
      const [x, y, z] = args.map(Number);
      if ([x, y, z].some((n) => Number.isNaN(n))) return { success: false, msg: "Usage: /goto <x> <y> <z>" };
      try {
        bot.pathfinder.setGoal(new GoalBlock(x, y, z));
        return { success: true, msg: `Walking to ${x}, ${y}, ${z}...` };
      } catch (e) {
        return { success: false, msg: `Pathfinder error: ${e.message}` };
      }
    }

    case "/come": {
      if (!bot || !botState.spawned) return { success: false, msg: "Bot is not connected." };
      if (!lastChatter || !bot.players[lastChatter] || !bot.players[lastChatter].entity) {
        return { success: false, msg: "No visible player to come to yet." };
      }
      const { x, y, z } = bot.players[lastChatter].entity.position;
      bot.pathfinder.setGoal(new GoalNear(x, y, z, 1));
      return { success: true, msg: `Coming to ${lastChatter}...` };
    }

    case "/stop":
      if (bot && bot.pathfinder) bot.pathfinder.setGoal(null);
      return { success: true, msg: "Pathfinder goal cleared." };

    case "/reconnect":
      stopRequested = false;
      clearTimeout(reconnectTimer);
      createBot();
      return { success: true, msg: "Reconnecting now..." };

    case "/clear":
      clearLogs();
      return { success: true, msg: "Logs cleared." };

    default:
      return { success: false, msg: `Unknown command: ${cmd}. Type /help for a list.` };
  }
}

// track last chatter for /come
function attachChatTracking() {
  if (!bot) return;
  bot.on("chat", (username) => {
    if (username !== bot.username) lastChatter = username;
  });
}

// ============================================================
// EXPRESS ROUTES
// ============================================================
app.get("/", (req, res) => {
  res.send(renderDashboard());
});

app.get("/tutorial", (req, res) => {
  res.send(renderTutorial());
});

app.get("/logs", (req, res) => {
  res.send(renderLogs());
});

app.get("/health", (req, res) => {
  res.json({
    status: botState.connected ? "connected" : "disconnected",
    spawned: botState.spawned,
    uptime: Math.floor((Date.now() - botState.startTime) / 1000),
    coords: bot && bot.entity ? bot.entity.position : null,
    lastActivity: botState.lastActivity,
    reconnectAttempts: botState.reconnectAttempts,
    memoryUsage: process.memoryUsage().heapUsed / 1024 / 1024,
    health: botState.health,
    food: botState.food,
    playerCount: botState.players.length,
  });
});

app.get("/ping", (req, res) => res.send("pong"));

app.post("/start", (req, res) => {
  if (botState.connected || bot) {
    return res.json({ success: false, msg: "Bot is already running." });
  }
  stopRequested = false;
  createBot();
  attachChatTracking();
  res.json({ success: true, msg: "Bot starting..." });
});

app.post("/stop", (req, res) => {
  stopRequested = true;
  clearTimeout(reconnectTimer);
  stopAntiAfk();
  stopChatLoop();
  if (bot) {
    try { bot.quit("Stopped via dashboard"); } catch (_) {}
  }
  botState.connected = false;
  botState.spawned = false;
  addLog("Bot stopped by user via dashboard.", "warn");
  res.json({ success: true, msg: "Bot stopped." });
});

app.post("/command", (req, res) => {
  const { command } = req.body || {};
  if (typeof command !== "string") {
    return res.status(400).json({ success: false, msg: "Missing 'command' field." });
  }
  addLog(`Console command: ${command}`, "control");
  const result = handleCommand(command);
  res.json(result);
});

app.listen(PORT, () => {
  addLog(`Dashboard server listening on port ${PORT}`);
});

// Boot the bot automatically on startup
createBot();
attachChatTracking();

// Self-ping to help keep certain free hosts awake, if a public URL is known
if (process.env.RENDER_EXTERNAL_URL || process.env.SELF_URL) {
  const selfUrl = process.env.RENDER_EXTERNAL_URL || process.env.SELF_URL;
  setInterval(() => {
    require("https")
      .get(`${selfUrl}/ping`, () => {})
      .on("error", () => {});
  }, 10 * 60 * 1000);
}

// ============================================================
// HTML RENDERERS
// ============================================================
function renderDashboard() {
  return `
    <!DOCTYPE html>
    <html lang="en">
      <head>
        <title>${config.name} Dashboard</title>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <link rel="stylesheet" media="print" onload="this.media='all'"
              href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap">
        <style>${sharedStyles()}
          .status-section { border-radius: 12px; padding: 20px 24px; margin-bottom: 16px; display: flex; align-items: center; gap: 16px; transition: background 0.3s, border-color 0.3s; }
          .status-section.online  { background: #0d2218; border: 2px solid #238636; }
          .status-section.offline { background: #200d0d; border: 2px solid #da3633; }
          .status-icon { width: 44px; height: 44px; border-radius: 50%; display: flex; align-items: center; justify-content: center; font-size: 20px; flex-shrink: 0; transition: background 0.3s; }
          .status-icon.online  { background: #238636; }
          .status-icon.offline { background: #da3633; }
          .status-label { font-size: 18px; font-weight: 700; line-height: 1.2; transition: color 0.3s; }
          .status-label.online  { color: #3fb950; }
          .status-label.offline { color: #f85149; }
          .status-detail { font-size: 13px; color: #8b949e; margin-top: 3px; }
          dl { margin: 0; }
          .stat-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
          .stat-card { background: #161b22; border: 1px solid #21262d; border-radius: 10px; padding: 16px 20px; margin-bottom: 10px; }
          dt { font-size: 12px; color: #8b949e; font-weight: 600; margin-bottom: 4px; }
          dd { margin: 0; font-size: 17px; font-weight: 600; color: #e6edf3; line-height: 1.3; }
          .stat-detail { margin: 4px 0 0; font-size: 11px; color: #6e7681; }
          .controls { margin-top: 8px; }
          .btn-grid { display: grid; gap: 10px; margin-bottom: 10px; }
          .btn-grid-2 { grid-template-columns: 1fr 1fr; }
          .btn-primary { min-height: 52px; border-radius: 10px; font-size: 15px; font-weight: 700; cursor: pointer; letter-spacing: 0.3px; transition: opacity 0.2s, filter 0.2s; font-family: inherit; }
          .btn-primary:hover  { filter: brightness(1.1); }
          .btn-primary:active { opacity: 0.85; }
          .btn-primary:disabled { opacity: 0.4; cursor: default; filter: none; }
          .btn-start { border: 2px solid #238636; background: #0d2218; color: #3fb950; }
          .btn-stop  { border: 2px solid #da3633; background: #200d0d; color: #f85149; }
          .btn-secondary { min-height: 44px; border-radius: 10px; border: 1px solid #21262d; background: #161b22; color: #8b949e; font-size: 13px; font-weight: 500; text-decoration: none; display: flex; align-items: center; justify-content: center; font-family: inherit; cursor: pointer; transition: background 0.2s, color 0.2s; }
          .btn-secondary:hover { background: #21262d; color: #c9d1d9; }
          .health-bar-track { background: #21262d; border-radius: 6px; height: 8px; overflow: hidden; margin-top: 8px; }
          .health-bar-fill { height: 100%; background: #3fb950; transition: width 0.3s, background 0.3s; }
        </style>
      </head>
      <body>
        <main role="main" aria-label="AFK Bot Dashboard">
          <header>
            <h1>AFK Bot Dashboard</h1>
            <p>Minecraft server bot &middot; Live status</p>
          </header>

          <section id="status-section" role="status" aria-live="polite" aria-label="Bot connection status" class="status-section offline">
            <div id="status-icon" aria-hidden="true" class="status-icon offline">&#x2717;</div>
            <div>
              <div id="status-label" class="status-label offline">Connecting&hellip;</div>
              <div id="status-detail" class="status-detail">Establishing connection</div>
            </div>
          </section>

          <section aria-label="Bot statistics">
            <dl>
              <div class="stat-card">
                <dt>Uptime</dt>
                <dd id="uptime-text">&mdash;</dd>
                <p class="stat-detail">Time since last connection</p>
              </div>
              <div class="stat-card">
                <dt>Coordinates</dt>
                <dd id="coords-text">Searching&hellip;</dd>
                <p class="stat-detail">Bot's current in-game position</p>
              </div>
              <div class="stat-grid">
                <div class="stat-card">
                  <dt>Health</dt>
                  <dd id="health-text">&mdash;</dd>
                  <div class="health-bar-track"><div id="health-bar" class="health-bar-fill" style="width:0%"></div></div>
                </div>
                <div class="stat-card">
                  <dt>Players online</dt>
                  <dd id="players-text">&mdash;</dd>
                  <p class="stat-detail">Excludes the bot itself</p>
                </div>
              </div>
              <div class="stat-card">
                <dt>Server address</dt>
                <dd>${escapeHTML(config.server.ip)}:${escapeHTML(String(config.server.port))}</dd>
                <p class="stat-detail">Minecraft server hostname</p>
              </div>
            </dl>
          </section>

          <section class="controls" aria-label="Bot controls">
            <div class="btn-grid btn-grid-2">
              <button id="start-btn" class="btn-primary btn-start" onclick="startBot()" aria-label="Start bot">Start bot</button>
              <button id="stop-btn" class="btn-primary btn-stop" onclick="stopBot()" aria-label="Stop bot">Stop bot</button>
            </div>
            <div class="btn-grid btn-grid-2">
              <a href="/tutorial" class="btn-secondary" aria-label="View setup guide">Setup guide</a>
              <a href="/logs" class="btn-secondary" aria-label="View bot logs">View logs</a>
            </div>
          </section>

          <footer>
            <p>Status updates every 5 seconds</p>
          </footer>
        </main>

        <script>
          function formatUptime(s) {
            const h = Math.floor(s / 3600);
            const m = Math.floor((s % 3600) / 60);
            const sec = s % 60;
            if (h > 0) return h + 'h ' + m + 'm ' + sec + 's';
            if (m > 0) return m + 'm ' + sec + 's';
            return sec + ' seconds';
          }

          function healthColor(pct) {
            if (pct > 60) return '#3fb950';
            if (pct > 30) return '#e3b341';
            return '#f85149';
          }

          async function update() {
            try {
              const r = await fetch('/health');
              const data = await r.json();
              const online = data.status === 'connected' && data.spawned;

              const section = document.getElementById('status-section');
              const icon    = document.getElementById('status-icon');
              const label   = document.getElementById('status-label');
              const detail  = document.getElementById('status-detail');

              section.className = 'status-section ' + (online ? 'online' : 'offline');
              icon.className    = 'status-icon '    + (online ? 'online' : 'offline');
              icon.textContent  = online ? '\u2713' : '\u2717';
              label.className   = 'status-label '   + (online ? 'online' : 'offline');
              label.textContent = online ? 'Connected' : (data.status === 'connected' ? 'Connecting to world…' : 'Disconnected');
              detail.textContent = online ? 'Bot is active on the server' : 'Attempting to reconnect';

              document.getElementById('start-btn').disabled = data.status === 'connected';
              document.getElementById('stop-btn').disabled = data.status !== 'connected';

              document.getElementById('uptime-text').textContent = formatUptime(data.uptime);
              document.getElementById('players-text').textContent = data.playerCount ?? 0;

              if (data.coords) {
                const x = Math.floor(data.coords.x);
                const y = Math.floor(data.coords.y);
                const z = Math.floor(data.coords.z);
                document.getElementById('coords-text').textContent = 'X ' + x + ', Y ' + y + ', Z ' + z;
              } else {
                document.getElementById('coords-text').textContent = 'Searching…';
              }

              if (typeof data.health === 'number') {
                const pct = Math.round((data.health / 20) * 100);
                document.getElementById('health-text').textContent = data.health.toFixed(1) + ' / 20';
                const bar = document.getElementById('health-bar');
                bar.style.width = pct + '%';
                bar.style.background = healthColor(pct);
              } else {
                document.getElementById('health-text').textContent = '—';
              }
            } catch (e) {
              const label = document.getElementById('status-label');
              label.className = 'status-label offline';
              label.textContent = 'Unreachable';
            }
          }

          async function startBot() {
            const r = await fetch('/start', { method: 'POST' });
            const data = await r.json();
            if (!data.success) alert(data.msg);
            update();
          }

          async function stopBot() {
            const r = await fetch('/stop', { method: 'POST' });
            const data = await r.json();
            if (!data.success) alert(data.msg);
            update();
          }

          setInterval(update, 5000);
          update();
        </script>
      </body>
    </html>
  `;
}

function renderTutorial() {
  return `
    <!DOCTYPE html>
    <html lang="en">
      <head>
        <title>${config.name} - Setup Guide</title>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <link rel="stylesheet" media="print" onload="this.media='all'"
              href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap">
        <style>${sharedStyles()}
          .step-card { background: #161b22; border: 1px solid #21262d; border-radius: 12px; padding: 24px; margin-bottom: 16px; }
          .step-header { display: flex; align-items: center; gap: 14px; margin-bottom: 18px; }
          .step-number { width: 32px; height: 32px; border-radius: 50%; background: #0d2218; border: 2px solid #238636; color: #3fb950; font-size: 14px; font-weight: 700; display: flex; align-items: center; justify-content: center; flex-shrink: 0; }
          .step-title { font-size: 16px; font-weight: 700; color: #f0f6fc; margin: 0; }
          ol { margin: 0; padding: 0; list-style: none; display: flex; flex-direction: column; gap: 10px; }
          li { font-size: 14px; color: #8b949e; line-height: 1.6; padding-left: 20px; position: relative; }
          li::before { content: "\\00B7"; position: absolute; left: 6px; color: #3fb950; font-weight: 700; }
          li strong { color: #e6edf3; font-weight: 600; }
          code { background: #21262d; border: 1px solid #30363d; padding: 2px 7px; border-radius: 5px; font-family: 'SF Mono', 'Fira Code', monospace; font-size: 12px; color: #e6edf3; }
          a { color: #58a6ff; text-decoration: none; }
          a:hover { text-decoration: underline; }
        </style>
      </head>
      <body>
        <main>
          <a href="/" class="back-btn">&#8592; Back to Dashboard</a>

          <header>
            <h1>Setup Guide</h1>
            <p>Get your AFK bot running in under 15 minutes</p>
          </header>

          <div class="step-card">
            <div class="step-header"><div class="step-number">1</div><h2 class="step-title">Configure your server</h2></div>
            <ol>
              <li>On <strong>Aternos</strong> (or any host), open your server settings.</li>
              <li>Install <strong>Paper/Bukkit</strong> as your server software.</li>
              <li>Enable <strong>Cracked/offline mode</strong> if the bot uses <code>"auth": "offline"</code>.</li>
              <li>If you support multiple client versions, install <code>ViaVersion</code>, <code>ViaBackwards</code>, <code>ViaRewind</code>.</li>
            </ol>
          </div>

          <div class="step-card">
            <div class="step-header"><div class="step-number">2</div><h2 class="step-title">Configure the bot</h2></div>
            <ol>
              <li>Edit <code>settings.json</code>: set <code>server.ip</code>, <code>server.port</code>, and <code>server.version</code>.</li>
              <li>Set <code>bot.username</code> to whatever name you want the bot to join as.</li>
              <li>Add your own Minecraft username to <code>admins</code> if you plan to gate commands later.</li>
              <li>Tune <code>antiAfk</code> and <code>chat</code> sections to control how the bot behaves while idle.</li>
            </ol>
          </div>

          <div class="step-card">
            <div class="step-header"><div class="step-number">3</div><h2 class="step-title">Install & run</h2></div>
            <ol>
              <li>Run <code>npm install</code> to fetch dependencies.</li>
              <li>Run <code>npm start</code> (or <code>node index.js</code>) to launch the dashboard and bot.</li>
              <li>Open the dashboard in your browser to confirm the bot connected.</li>
            </ol>
          </div>

          <div class="step-card">
            <div class="step-header"><div class="step-number">4</div><h2 class="step-title">Deploy for 24/7 uptime</h2></div>
            <ol>
              <li>Push this project to a <strong>GitHub repository</strong>.</li>
              <li>Import it into <strong>Render</strong>, <strong>Railway</strong>, or <strong>Replit</strong> as a Node.js web service.</li>
              <li>Set the start command to <code>npm start</code> and the health check path to <code>/ping</code>.</li>
              <li>If your host spins down on inactivity, set the <code>RENDER_EXTERNAL_URL</code> environment variable so the bot self-pings every 10 minutes.</li>
            </ol>
          </div>

          <footer><p>AFK Bot Dashboard &middot; ${escapeHTML(config.name)}</p></footer>
        </main>
      </body>
    </html>
  `;
}

function renderLogs() {
  const logs = getLogs();
  const logCount = logs.length;

  return `
    <!DOCTYPE html>
    <html lang="en">
      <head>
        <title>${config.name} - Logs</title>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <link rel="stylesheet" media="print" onload="this.media='all'"
              href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap">
        <style>${sharedStyles()}
          .page-header { display: flex; align-items: flex-end; justify-content: space-between; margin-bottom: 20px; gap: 12px; flex-wrap: wrap; }
          .page-header-left h1 { font-size: 26px; font-weight: 700; color: #f0f6fc; margin: 0; line-height: 1.2; }
          .page-header-left p { font-size: 14px; color: #8b949e; margin: 6px 0 0; }
          .badge { font-size: 12px; font-weight: 600; color: #8b949e; background: #161b22; border: 1px solid #21262d; border-radius: 20px; padding: 4px 12px; white-space: nowrap; }
          .log-card { background: #0d1117; border: 1px solid #21262d; border-radius: 12px; overflow: hidden; }
          .log-card-header { background: #161b22; border-bottom: 1px solid #21262d; padding: 12px 18px; display: flex; align-items: center; gap: 8px; }
          .dot { width: 10px; height: 10px; border-radius: 50%; }
          .dot-red   { background: #ff5f57; }
          .dot-yellow{ background: #ffbd2e; }
          .dot-green { background: #28c840; }
          .log-card-title { font-size: 12px; font-weight: 500; color: #484f58; margin-left: 4px; }
          .log-body { padding: 16px 18px; max-height: 560px; overflow-y: auto; font-family: 'SF Mono', 'Fira Code', 'Consolas', monospace; font-size: 12.5px; line-height: 1.7; }
          .log-entry { display: block; padding: 1px 0; white-space: pre-wrap; word-break: break-all; }
          .log-entry.error   { color: #ff7b72; }
          .log-entry.warn    { color: #e3b341; }
          .log-entry.success { color: #3fb950; }
          .log-entry.control { color: #58a6ff; }
          .log-entry.default { color: #8b949e; }
          .empty-state { text-align: center; padding: 40px 20px; color: #484f58; font-size: 13px; }
          .console-row { display: flex; align-items: center; border-top: 1px solid #21262d; background: #0d1117; padding: 10px 18px; gap: 10px; }
          .console-prompt { font-family: 'SF Mono', 'Fira Code', 'Consolas', monospace; font-size: 13px; color: #3fb950; font-weight: 700; flex-shrink: 0; user-select: none; }
          .console-input { flex: 1; background: transparent; border: none; outline: none; font-family: 'SF Mono', 'Fira Code', 'Consolas', monospace; font-size: 12.5px; color: #e6edf3; caret-color: #3fb950; }
          .console-input::placeholder { color: #484f58; }
          .console-send { background: #0d2218; border: 1px solid #238636; color: #3fb950; font-size: 12px; font-weight: 600; padding: 5px 14px; border-radius: 6px; cursor: pointer; font-family: inherit; transition: background 0.2s; flex-shrink: 0; }
          .console-send:hover { background: #122d1a; }
          .console-send:disabled { opacity: 0.5; cursor: default; }
          .console-wrap { position: relative; }
          .cmd-suggestions { display: none; position: absolute; bottom: calc(100% + 6px); left: 0; right: 0; background: #161b22; border: 1px solid #30363d; border-radius: 10px; overflow: hidden; box-shadow: 0 8px 24px rgba(0,0,0,0.5); z-index: 10; }
          .cmd-suggestions.visible { display: block; }
          .cmd-item { display: flex; align-items: baseline; gap: 12px; padding: 9px 16px; cursor: pointer; transition: background 0.12s; border-bottom: 1px solid #21262d; }
          .cmd-item:last-child { border-bottom: none; }
          .cmd-item:hover, .cmd-item.active { background: #21262d; }
          .cmd-name { font-family: 'SF Mono', 'Fira Code', 'Consolas', monospace; font-size: 12.5px; font-weight: 700; color: #3fb950; flex-shrink: 0; min-width: 90px; }
          .cmd-desc { font-size: 12px; color: #6e7681; }
          .refresh-bar { display: flex; align-items: center; justify-content: flex-end; gap: 6px; margin-top: 12px; font-size: 12px; color: #484f58; }
          .refresh-dot { width: 7px; height: 7px; border-radius: 50%; background: #3fb950; animation: pulse 2s infinite; }
          @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.3; } }
        </style>
      </head>
      <body>
        <main>
          <a href="/" class="back-btn">&#8592; Back to Dashboard</a>

          <div class="page-header">
            <div class="page-header-left">
              <h1>Bot Logs</h1>
              <p>Live output from the AFK bot</p>
            </div>
            <span class="badge">${logCount} ${logCount === 1 ? "entry" : "entries"}</span>
          </div>

          <div class="log-card">
            <div class="log-card-header">
              <span class="dot dot-red"></span>
              <span class="dot dot-yellow"></span>
              <span class="dot dot-green"></span>
              <span class="log-card-title">bot.log</span>
            </div>
            <div class="log-body" id="log-body">
              ${
                logCount === 0
                  ? `<div class="empty-state">No log entries yet. Start the bot to see output.</div>`
                  : logs
                      .map((l) => {
                        const escaped = escapeHTML(l);
                        const lower = l.toLowerCase();
                        let cls = "default";
                        if (lower.includes("[error]") || lower.includes("error") || lower.includes("fail")) cls = "error";
                        else if (lower.includes("[warn]") || lower.includes("warn")) cls = "warn";
                        else if (lower.includes("[control]")) cls = "control";
                        else if (lower.includes("[ok]") || lower.includes("connect") || lower.includes("join") || lower.includes("spawn")) cls = "success";
                        return `<span class="log-entry ${cls}">${escaped}</span>`;
                      })
                      .join("")
              }
            </div>
            <div class="console-wrap">
              <div class="cmd-suggestions" id="cmd-suggestions"></div>
              <div class="console-row">
                <span class="console-prompt">&gt;</span>
                <input id="console-input" class="console-input" type="text"
                  placeholder="Type / for commands, or any message…" autocomplete="off" spellcheck="false">
                <button id="console-send" class="console-send">Send</button>
              </div>
            </div>
          </div>

          <div class="refresh-bar">
            <span class="refresh-dot"></span>
            <span id="refresh-label">Auto-refreshing every 5 seconds</span>
          </div>

          <footer><p>AFK Bot Dashboard &middot; ${escapeHTML(config.name)}</p></footer>
        </main>

        <script>
          (function() {
            var logBody  = document.getElementById('log-body');
            var input    = document.getElementById('console-input');
            var sendBtn  = document.getElementById('console-send');
            var label    = document.getElementById('refresh-label');
            var sugBox   = document.getElementById('cmd-suggestions');
            var refreshTimer = null;
            var typing = false;
            var activeIdx = -1;

            var COMMANDS = [
              { name: '/help',      desc: 'Show all available commands' },
              { name: '/pos',       desc: "Show bot's current coordinates" },
              { name: '/status',    desc: 'Show connection status & uptime' },
              { name: '/list',      desc: 'List players on the server' },
              { name: '/say',       desc: 'Send a chat message in-game' },
              { name: '/goto',      desc: 'Walk to coordinates: /goto x y z' },
              { name: '/come',      desc: 'Walk to the last player who chatted' },
              { name: '/stop',      desc: 'Clear current pathfinder goal' },
              { name: '/reconnect', desc: 'Force the bot to reconnect now' },
              { name: '/clear',     desc: 'Clear the log console' },
            ];

            function scrollBottom() {
              if (logBody) logBody.scrollTop = logBody.scrollHeight;
            }
            scrollBottom();

            function scheduleRefresh() {
              clearTimeout(refreshTimer);
              if (!typing) {
                refreshTimer = setTimeout(function() { location.reload(); }, 5000);
              }
            }
            scheduleRefresh();

            function appendLocalEntry(text, cls) {
              var span = document.createElement('span');
              span.className = 'log-entry ' + (cls || 'control');
              span.textContent = text;
              logBody.appendChild(span);
              scrollBottom();
            }

            function hideSuggestions() {
              sugBox.classList.remove('visible');
              sugBox.innerHTML = '';
              activeIdx = -1;
            }

            function setActive(idx) {
              var items = sugBox.querySelectorAll('.cmd-item');
              items.forEach(function(el, i) { el.classList.toggle('active', i === idx); });
              activeIdx = idx;
            }

            function showSuggestions(val) {
              var query = val.toLowerCase();
              var matches = COMMANDS.filter(function(c) { return c.name.startsWith(query); });
              if (!matches.length) { hideSuggestions(); return; }

              sugBox.innerHTML = matches.map(function(c) {
                return '<div class="cmd-item" data-cmd="' + c.name + '">' +
                  '<span class="cmd-name">' + c.name + '</span>' +
                  '<span class="cmd-desc">' + c.desc + '</span>' +
                '</div>';
              }).join('');

              sugBox.querySelectorAll('.cmd-item').forEach(function(el) {
                el.addEventListener('mousedown', function(e) {
                  e.preventDefault();
                  input.value = el.dataset.cmd + ' ';
                  hideSuggestions();
                  input.focus();
                });
              });

              activeIdx = -1;
              sugBox.classList.add('visible');
            }

            input.addEventListener('input', function() {
              var val = input.value;
              if (val.startsWith('/')) showSuggestions(val);
              else hideSuggestions();
            });

            input.addEventListener('keydown', function(e) {
              var items = sugBox.querySelectorAll('.cmd-item');
              if (sugBox.classList.contains('visible') && items.length) {
                if (e.key === 'ArrowDown') { e.preventDefault(); setActive(Math.min(activeIdx + 1, items.length - 1)); return; }
                if (e.key === 'ArrowUp')   { e.preventDefault(); setActive(Math.max(activeIdx - 1, 0)); return; }
                if (e.key === 'Tab' || (e.key === 'Enter' && activeIdx >= 0)) {
                  e.preventDefault();
                  var chosen = items[activeIdx >= 0 ? activeIdx : 0];
                  input.value = chosen.dataset.cmd + ' ';
                  hideSuggestions();
                  return;
                }
                if (e.key === 'Escape') { hideSuggestions(); return; }
              }
              if (e.key === 'Enter') sendCommand();
            });

            function sendCommand() {
              var cmd = input.value.trim();
              if (!cmd) return;
              hideSuggestions();
              input.value = '';
              sendBtn.disabled = true;
              appendLocalEntry('> ' + cmd, 'control');

              fetch('/command', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ command: cmd })
              })
              .then(function(r) { return r.json(); })
              .then(function(data) {
                if (data.msg) {
                  data.msg.split('\\n').forEach(function(line) {
                    appendLocalEntry(line, data.success ? 'default' : 'error');
                  });
                }
                if (cmd.toLowerCase() === '/clear') {
                  logBody.innerHTML = '';
                }
              })
              .catch(function() {
                appendLocalEntry('Failed to send command.', 'error');
              })
              .finally(function() {
                sendBtn.disabled = false;
                input.focus();
                scheduleRefresh();
              });
            }

            sendBtn.addEventListener('click', sendCommand);

            input.addEventListener('focus', function() {
              typing = true;
              clearTimeout(refreshTimer);
              label.textContent = 'Auto-refresh paused while typing';
            });

            input.addEventListener('blur', function() {
              typing = false;
              label.textContent = 'Auto-refreshing every 5 seconds';
              scheduleRefresh();
            });
          })();
        </script>
      </body>
    </html>
  `;
}

function sharedStyles() {
  return `
    *, *::before, *::after { box-sizing: border-box; }
    body { font-family: 'Inter', -apple-system, sans-serif; background: #0d1117; color: #e6edf3; margin: 0; padding: 40px 24px; }
    main { width: 100%; max-width: 560px; margin: 0 auto; }
    header { margin-bottom: 28px; }
    header h1 { font-size: 26px; font-weight: 700; color: #f0f6fc; margin: 0; line-height: 1.2; }
    header p { font-size: 14px; color: #8b949e; margin: 6px 0 0; line-height: 1.5; }
    footer { margin-top: 32px; text-align: center; }
    footer p { font-size: 12px; color: #484f58; margin: 0; }
    .back-btn { display: inline-flex; align-items: center; gap: 6px; font-size: 13px; font-weight: 500; color: #8b949e; text-decoration: none; background: #161b22; border: 1px solid #21262d; border-radius: 8px; padding: 7px 14px; margin-bottom: 32px; transition: color 0.2s, background 0.2s; }
    .back-btn:hover { background: #21262d; color: #c9d1d9; }
  `;
}

function escapeHTML(str) {
  return String(str).replace(
    /[&<>"']/g,
    (m) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      })[m],
  );
}

// ============================================================
// GRACEFUL SHUTDOWN
// ============================================================
process.on("SIGINT", () => {
  addLog("Received SIGINT, shutting down.", "warn");
  stopRequested = true;
  if (bot) { try { bot.quit("Process exiting"); } catch (_) {} }
  process.exit(0);
});

process.on("uncaughtException", (err) => {
  addLog(`Uncaught exception: ${err.message}`, "error");
});

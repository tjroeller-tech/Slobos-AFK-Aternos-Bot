"use strict";

const express = require("express");
const path = require("path");
const { addLog, getLogs } = require("./logger");
const config = require("./settings.json");

// Bot manager handles the lifecycle of the mineflayer client safely
const BotManager = require("./botManager");

const app = express();
const PORT = process.env.PORT || 5000;

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Initialize the bot manager instance
const botManager = new BotManager(config, addLog);

// ============================================================
// API ROUTES
// ============================================================

app.get("/health", (req, res) => {
  const state = botManager.getState();
  res.json({
    status: state.connected ? "connected" : "disconnected",
    uptime: Math.floor((Date.now() - state.startTime) / 1000),
    coords: botManager.getCoordinates(),
    lastActivity: state.lastActivity,
    reconnectAttempts: state.reconnectAttempts,
    memoryUsage: process.memoryUsage().heapUsed / 1024 / 1024,
  });
});

app.get("/ping", (req, res) => res.send("pong"));

app.post("/start", async (req, res) => {
  try {
    const success = await botManager.start();
    res.json({ success, msg: success ? "Bot started successfully." : "Bot is already running." });
  } catch (err) {
    addLog(`Failed to start bot: ${err.message}`, "error");
    res.status(500).json({ success: false, msg: err.message });
  }
});

app.post("/stop", async (req, res) => {
  try {
    const success = await botManager.stop();
    res.json({ success, msg: success ? "Bot stopped successfully." : "Bot is not running." });
  } catch (err) {
    addLog(`Failed to stop bot: ${err.message}`, "error");
    res.status(500).json({ success: false, msg: err.message });
  }
});

app.post("/command", async (req, res) => {
  const { command } = req.body;
  if (!command || typeof command !== "string") {
    return res.status(400).json({ success: false, msg: "Invalid command format." });
  }

  try {
    const result = await botManager.executeCommand(command);
    res.json(result);
  } catch (err) {
    res.status(500).json({ success: false, msg: err.message });
  }
});

// ============================================================
// HTML VIEWS (Extracted for clean separation)
// ============================================================

app.get("/", (req, res) => {
  res.send(getDashboardHtml(config));
});

app.get("/tutorial", (req, res) => {
  res.send(getTutorialHtml(config));
});

app.get("/logs", (req, res) => {
  res.send(getLogsHtml(config, getLogs()));
});

// ============================================================
// SERVER STARTUP & KEEP-ALIVE PING
// ============================================================

app.listen(PORT, () => {
  addLog(`Dashboard server running on port ${PORT}`, "control");
  
  // Auto-start bot on launch if configured
  if (config.autoStart !== false) {
    botManager.start();
  }
});

// Self-ping to prevent Render/Aternos spin-down
setInterval(() => {
  const appUrl = process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`;
  const client = appUrl.startsWith("https") ? require("https") : require("http");
  
  client.get(`${appUrl}/ping`, (res) => {
    // Keep-alive ping successful
  }).on("error", (err) => {
    // Suppress minor network blips during cold starts
  });
}, 10 * 60 * 1000);

// ============================================================
// HTML TEMPLATE HELPERS
// ============================================================

function escapeHTML(str) {
  return str.replace(/[&<>"']/g, (m) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[m]);
}

function getDashboardHtml(cfg) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <title>${cfg.name} Dashboard</title>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap">
  <style>
    *, *::before, *::after { box-sizing: border-box; }
    body { font-family: 'Inter', sans-serif; background: #0d1117; color: #e6edf3; display: flex; justify-content: center; align-items: center; min-height: 100vh; margin: 0; padding: 24px; }
    main { width: 100%; max-width: 400px; }
    header { margin-bottom: 28px; }
    header h1 { font-size: 26px; font-weight: 700; color: #f0f6fc; margin: 0; }
    header p { font-size: 14px; color: #8b949e; margin: 6px 0 0; }
    .status-section { border-radius: 12px; padding: 20px 24px; margin-bottom: 16px; display: flex; align-items: center; gap: 16px; }
    .status-section.online { background: #0d2218; border: 2px solid #238636; }
    .status-section.offline { background: #200d0d; border: 2px solid #da3633; }
    .status-icon { width: 44px; height: 44px; border-radius: 50%; display: flex; align-items: center; justify-content: center; font-size: 20px; flex-shrink: 0; }
    .status-icon.online { background: #238636; }
    .status-icon.offline { background: #da3633; }
    .status-label { font-size: 18px; font-weight: 700; }
    .status-label.online { color: #3fb950; }
    .status-label.offline { color: #f85149; }
    .status-detail { font-size: 13px; color: #8b949e; margin-top: 3px; }
    .stat-card { background: #161b22; border: 1px solid #21262d; border-radius: 10px; padding: 16px 20px; margin-bottom: 10px; }
    dt { font-size: 12px; color: #8b949e; font-weight: 600; margin-bottom: 4px; }
    dd { margin: 0; font-size: 17px; font-weight: 600; color: #e6edf3; }
    .stat-detail { margin: 4px 0 0; font-size: 11px; color: #6e7681; }
    .btn-grid { display: grid; gap: 10px; margin-bottom: 10px; grid-template-columns: 1fr 1fr; }
    .btn-primary { min-height: 52px; border-radius: 10px; font-size: 15px; font-weight: 700; cursor: pointer; font-family: inherit; }
    .btn-start { border: 2px solid #238636; background: #0d2218; color: #3fb950; }
    .btn-stop { border: 2px solid #da3633; background: #200d0d; color: #f85149; }
    .btn-secondary { min-height: 44px; border-radius: 10px; border: 1px solid #21262d; background: #161b22; color: #8b949e; font-size: 13px; font-weight: 500; text-decoration: none; display: flex; align-items: center; justify-content: center; font-family: inherit; }
    .btn-secondary:hover { background: #21262d; color: #c9d1d9; }
    footer { margin-top: 20px; text-align: center; }
    footer p { font-size: 12px; color: #484f58; margin: 0; }
  </style>
</head>
<body>
  <main>
    <header>
      <h1>AFK Bot Dashboard</h1>
      <p>Minecraft server bot &middot; Live status</p>
    </header>
    <section id="status-section" class="status-section offline">
      <div id="status-icon" class="status-icon offline">&#x2717;</div>
      <div>
        <div id="status-label" class="status-label offline">Connecting…</div>
        <div id="status-detail" class="status-detail">Establishing connection</div>
      </div>
    </section>
    <section>
      <dl>
        <div class="stat-card">
          <dt>Uptime</dt>
          <dd id="uptime-text">—</dd>
          <p class="stat-detail">Time since last connection</p>
        </div>
        <div class="stat-card">
          <dt>Coordinates</dt>
          <dd id="coords-text">Searching…</dd>
          <p class="stat-detail">Bot's current in-game position</p>
        </div>
        <div class="stat-card">
          <dt>Server address</dt>
          <dd>${cfg.server.ip}</dd>
          <p class="stat-detail">Minecraft server hostname</p>
        </div>
      </dl>
    </section>
    <section class="controls">
      <div class="btn-grid">
        <button class="btn-primary btn-start" onclick="sendAction('start')">Start bot</button>
        <button class="btn-primary btn-stop" onclick="sendAction('stop')">Stop bot</button>
      </div>
      <div class="btn-grid">
        <a href="/tutorial" class="btn-secondary">Setup guide</a>
        <a href="/logs" class="btn-secondary">View logs</a>
      </div>
    </section>
    <footer><p>Status updates every 5 seconds</p></footer>
  </main>
  <script>
    function formatUptime(s) {
      const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
      return h > 0 ? \`\${h}h \${m}m \${sec}s\` : m > 0 ? \`\${m}m \${sec}s\` : \`\${sec} seconds\`;
    }
    async function update() {
      try {
        const r = await fetch('/health'), data = await r.json();
        const online = data.status === 'connected';
        document.getElementById('status-section').className = 'status-section ' + (online ? 'online' : 'offline');
        document.getElementById('status-icon').className = 'status-icon ' + (online ? 'online' : 'offline');
        document.getElementById('status-icon').textContent = online ? '✓' : '✗';
        document.getElementById('status-label').className = 'status-label ' + (online ? 'online' : 'offline');
        document.getElementById('status-label').textContent = online ? 'Connected' : 'Disconnected';
        document.getElementById('status-detail').textContent = online ? 'Bot is active' : 'Attempting to reconnect';
        document.getElementById('uptime-text').textContent = formatUptime(data.uptime);
        document.getElementById('coords-text').textContent = data.coords ? \`X \${Math.floor(data.coords.x)}, Y \${Math.floor(data.coords.y)}, Z \${Math.floor(data.coords.z)}\` : 'Searching…';
      } catch (e) { console.error(e); }
    }
    async function sendAction(action) {
      const r = await fetch('/' + action, { method: 'POST' });
      const data = await r.json();
      alert(data.msg);
      update();
    }
    setInterval(update, 5000);
    update();
  </script>
</body>
</html>`;
}

function getTutorialHtml(cfg) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <title>${cfg.name} - Setup Guide</title>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap">
  <style>
    *, *::before, *::after { box-sizing: border-box; }
    body { font-family: 'Inter', sans-serif; background: #0d1117; color: #e6edf3; margin: 0; padding: 40px 24px; }
    main { width: 100%; max-width: 560px; margin: 0 auto; }
    .back-btn { display: inline-flex; align-items: center; gap: 6px; font-size: 13px; font-weight: 500; color: #8b949e; text-decoration: none; background: #161b22; border: 1px solid #21262d; border-radius: 8px; padding: 7px 14px; margin-bottom: 32px; }
    .step-card { background: #161b22; border: 1px solid #21262d; border-radius: 12px; padding: 24px; margin-bottom: 16px; }
    .step-header { display: flex; align-items: center; gap: 14px; margin-bottom: 18px; }
    .step-number { width: 32px; height: 32px; border-radius: 50%; background: #0d2218; border: 2px solid #238636; color: #3fb950; font-size: 14px; font-weight: 700; display: flex; align-items: center; justify-content: center; }
    ol { margin: 0; padding: 0; list-style: none; display: flex; flex-direction: column; gap: 10px; }
    li { font-size: 14px; color: #8b949e; line-height: 1.6; padding-left: 20px; position: relative; }
    li::before { content: "·"; position: absolute; left: 6px; color: #3fb950; font-weight: 700; }
    code { background: #21262d; border: 1px solid #30363d; padding: 2px 7px; border-radius: 5px; font-family: monospace; font-size: 12px; color: #e6edf3; }
  </style>
</head>
<body>
  <main>
    <a href="/" class="back-btn">&#8592; Back to Dashboard</a>
    <h1>Setup Guide</h1>
    <div class="step-card">
      <div class="step-header"><div class="step-number">1</div><h2>Configure Server</h2></div>
      <ol>
        <li>Ensure your server supports online-mode or whitelist configuration.</li>
        <li>Install plugins like <code>ViaVersion</code> if versions mismatch.</li>
      </ol>
    </div>
  </main>
</body>
</html>`;
}

function getLogsHtml(cfg, logs) {
  const logCount = logs.length;
  const logsHtml = logCount === 0 
    ? '<div class="empty-state">No log entries yet.</div>'
    : logs.map(l => {
        const escaped = escapeHTML(l);
        const lower = l.toLowerCase();
        let cls = "default";
        if (lower.includes("error")) cls = "error";
        else if (lower.includes("warn")) cls = "warn";
        else if (lower.includes("connect")) cls = "success";
        return `<span class="log-entry ${cls}">${escaped}</span>`;
      }).join("");

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <title>${cfg.name} - Logs</title>
  <meta charset="utf-8">
  <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap">
  <style>
    body { font-family: 'Inter', sans-serif; background: #0d1117; color: #e6edf3; margin: 0; padding: 40px 24px; }
    main { max-width: 760px; margin: 0 auto; }
    .log-card { background: #0d1117; border: 1px solid #21262d; border-radius: 12px; overflow: hidden; }
    .log-body { padding: 16px; max-height: 560px; overflow-y: auto; font-family: monospace; font-size: 12.5px; }
    .log-entry.error { color: #ff7b72; }
    .log-entry.success { color: #3fb950; }
  </style>
</head>
<body>
  <main>
    <a href="/">← Back</a>
    <h1>Bot Logs</h1>
    <div class="log-card">
      <div class="log-body">${logsHtml}</div>
    </div>
  </main>
</body>
</html>`;
}

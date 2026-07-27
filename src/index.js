require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const { config } = require('./configStore');
const { handleMessage, handleReaction } = require('./handlers');
const { scheduleReminders } = require('./reminders');
const { notify } = require('./notify');

const groupName = process.env.WHATSAPP_GROUP_NAME || config.groupName;
const authPath  = process.env.BELLA_AUTH || '.wwebjs_auth';

// WhatsApp Web auto-updates its web build; new builds periodically break the
// installed whatsapp-web.js (getChats() throws a cryptic "r: r"), which leaves
// the bot connected but unable to find the group — so it silently ignores every
// message. Pin to a known-good build (cached under .wwebjs_cache) to stay stable.
// Override with WWEB_VERSION if a future update forces a bump.
const pinnedWebVersion = process.env.WWEB_VERSION || '2.3000.1043041454-alpha';

// ── WhatsApp client ────────────────────────────────────────────────────────────

const client = new Client({
  authStrategy: new LocalAuth({ dataPath: authPath }),
  webVersion: pinnedWebVersion,
  webVersionCache: {
    type: 'remote',
    remotePath: 'https://raw.githubusercontent.com/wppconnect-team/wa-version/main/html/{version}.html',
  },
  puppeteer: {
    headless: true,
    executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
    protocolTimeout: 300000,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
    ],
  },
});

// ── Group chat resolution ─────────────────────────────────────────────────────

let groupChatId = null;
let readyWatchdog = null;

// Returns true if getChats() succeeded (group found or legitimately absent),
// false if every attempt errored — the caller uses that to decide whether to
// let the watchdog restart the process.
async function resolveGroupChatId(retries = 5) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const chats = await client.getChats();
      const group = chats.find(
        (c) => c.isGroup && c.name.toLowerCase() === groupName.toLowerCase()
      );
      if (group) {
        groupChatId = group.id._serialized ?? group.id._serialised;
        console.log(`[bot] Found group: "${group.name}" (${groupChatId})`);
      } else {
        console.warn(`[bot] Group "${groupName}" not found. Bot will work in DMs only until the group is visible.`);
      }
      return true;
    } catch (err) {
      console.error(`[bot] getChats failed (attempt ${attempt}/${retries}): ${err.message}`);
      if (attempt < retries) await new Promise((r) => setTimeout(r, 10000));
    }
  }
  console.error('[bot] Could not resolve group chat after retries.');
  return false;
}

// Diagnostic only (BELLA_DEBUG_REVOKE=1): reports why WhatsApp is refusing to
// revoke the status messages we failed to delete. Loads recent history first so
// the probe sees the same message state a real delete would.
async function probeRevoke() {
  try {
    const db = require('./db');
    const { diagnoseRevoke } = require('./debugRevoke');
    const date = new Date().toLocaleDateString('en-CA', { timeZone: config.timezone });
    const chat = await client.getChatById(groupChatId);
    await chat.fetchMessages({ limit: 30 });
    await diagnoseRevoke(client, db.getStatusMessages(date).map((r) => r.message_id));
  } catch (err) {
    console.error('[revoke-debug] Probe aborted:', err.message);
  }
}

// ── Event handlers ────────────────────────────────────────────────────────────

client.on('qr', (qr) => {
  // A QR means login is needed — that requires a human to scan, so stand the
  // watchdog down instead of restart-looping.
  if (readyWatchdog) { clearTimeout(readyWatchdog); readyWatchdog = null; }
  console.log('\n[bot] Scan the QR code below with WhatsApp:\n');
  qrcode.generate(qr, { small: true });
});

client.on('ready', async () => {
  console.log('[bot] Client is ready!');
  const ok = await resolveGroupChatId();
  if (process.env.BELLA_DEBUG_REVOKE === '1' && groupChatId) await probeRevoke();
  scheduleReminders(client, () => groupChatId);
  // Only stand down the watchdog if WhatsApp actually responded; if getChats
  // errored the whole way, let the watchdog restart us for a clean retry.
  if (ok && readyWatchdog) { clearTimeout(readyWatchdog); readyWatchdog = null; }
  if (ok) startHealthWatchdog();
});

// We listen to `message_create` (not `message`) so the bot also reacts to
// messages sent from the linked account itself — important when the bot is
// hosted on a family member's own WhatsApp account rather than a dedicated
// number. Loop protection lives in handleMessage (it skips the bot's own
// output, which is prefixed with 🐾 / 📋).
client.on('message_create', async (message) => {
  try {
    if (!groupChatId || (message.id?.remote ?? message.from) !== groupChatId) return;
    await handleMessage(message, client);
  } catch (err) {
    console.error('[bot] Error handling message:', err.message);
  }
});

client.on('message_reaction', async (reaction) => {
  try {
    if (!groupChatId || reaction.msgId?.remote !== groupChatId) return;
    await handleReaction(reaction, client);
  } catch (err) {
    console.error('[bot] Error handling reaction:', err.message);
  }
});

client.on('auth_failure', (msg) => {
  console.error('[bot] Authentication failure:', msg);
});

client.on('disconnected', (reason) => {
  // whatsapp-web.js does not reconnect on its own after this event — the only
  // reliable recovery is a clean process restart via PM2.
  console.error('[bot] Disconnected:', reason, '— exiting for a clean restart.');
  notify('⚠️ Bella Bot restarting', `WhatsApp disconnected (${reason}). Restarting automatically.`);
  setTimeout(() => process.exit(1), 2000); // give the ntfy push a moment to send
});

// ── Runtime health watchdog ───────────────────────────────────────────────────
// The session can die long after startup (e.g. WhatsApp Web navigates and
// re-injection fails, leaving every call to time out) while PM2 still sees the
// process as "online". Ping the client regularly; after several consecutive
// failures, exit so PM2 restarts us through the self-healing boot path.

const HEALTH_INTERVAL_MS = Number(process.env.BELLA_HEALTH_INTERVAL_MS) || 120000;
const HEALTH_CHECK_TIMEOUT_MS = 30000;
const HEALTH_FAILS_TO_EXIT = 3;
let healthTimer = null;
let healthFails = 0;

function startHealthWatchdog() {
  if (healthTimer) clearInterval(healthTimer);
  healthFails = 0;
  healthTimer = setInterval(async () => {
    try {
      const state = await Promise.race([
        client.getState(),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('health check timed out')), HEALTH_CHECK_TIMEOUT_MS)
        ),
      ]);
      if (state !== 'CONNECTED') throw new Error(`state is ${state}`);
      if (healthFails > 0) console.log('[bot] Health check recovered.');
      healthFails = 0;
    } catch (err) {
      healthFails += 1;
      console.error(`[bot] Health check failed (${healthFails}/${HEALTH_FAILS_TO_EXIT}): ${err.message}`);
      if (healthFails >= HEALTH_FAILS_TO_EXIT) {
        console.error('[bot] Watchdog: client unresponsive — exiting for a clean restart.');
        notify('⚠️ Bella Bot restarting', 'WhatsApp session became unresponsive. Restarting automatically — back in a few minutes.');
        setTimeout(() => process.exit(1), 2000);
      }
    }
  }, HEALTH_INTERVAL_MS);
  console.log(`[bot] Health watchdog running (every ${Math.round(HEALTH_INTERVAL_MS / 1000)}s).`);
}

// ── Start ──────────────────────────────────────────────────────────────────────

// WhatsApp Web's service worker caches the app shell and, on this RPi, keeps
// getting into a state where getChats() throws "r" — leaving the bot connected
// but unable to find the group. Clearing only the app cache (NOT IndexedDB /
// Local Storage, which hold the login) on every startup forces a clean load and
// keeps the session logged in. Disable with BELLA_KEEP_CACHE=1 if ever needed.
function clearWebAppCache() {
  if (process.env.BELLA_KEEP_CACHE === '1') return;
  const base = path.join(authPath, 'session', 'Default');
  for (const dir of ['Service Worker', 'Cache', 'Code Cache', 'GPUCache']) {
    try {
      fs.rmSync(path.join(base, dir), { recursive: true, force: true });
    } catch (err) {
      console.warn(`[bot] Could not clear cache "${dir}": ${err.message}`);
    }
  }
  console.log('[bot] Cleared WhatsApp Web app cache (login preserved).');
}

console.log('[bot] Initialising…');
clearWebAppCache();

// Self-heal: if the WhatsApp client never becomes usable (cold-load hang or
// getChats failing all retries), exit so PM2 restarts us with a fresh cache.
// PM2 keeps a hung-but-"online" process forever otherwise. Stood down once the
// client is ready (see the 'ready'/'qr' handlers).
const readyTimeoutMs = Number(process.env.BELLA_READY_TIMEOUT_MS) || 210000; // 3.5 min
readyWatchdog = setTimeout(() => {
  console.error(`[bot] Watchdog: not ready after ${Math.round(readyTimeoutMs / 1000)}s — exiting for a clean restart.`);
  process.exit(1);
}, readyTimeoutMs);

client.initialize();

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const { config } = require('./configStore');
const { handleMessage, handleReaction } = require('./handlers');
const { scheduleReminders } = require('./reminders');

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
  scheduleReminders(client, () => groupChatId);
  // Only stand down the watchdog if WhatsApp actually responded; if getChats
  // errored the whole way, let the watchdog restart us for a clean retry.
  if (ok && readyWatchdog) { clearTimeout(readyWatchdog); readyWatchdog = null; }
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
  console.warn('[bot] Disconnected:', reason);
});

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

require('dotenv').config();
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const config = require('../config.json');
const { handleMessage, handleReaction } = require('./handlers');
const { scheduleReminders } = require('./reminders');

const groupName = process.env.WHATSAPP_GROUP_NAME || config.groupName;

// ── WhatsApp client ────────────────────────────────────────────────────────────

const client = new Client({
  authStrategy: new LocalAuth({ dataPath: '.wwebjs_auth' }),
  puppeteer: {
    headless: true,
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

async function resolveGroupChatId() {
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
}

// ── Event handlers ────────────────────────────────────────────────────────────

client.on('qr', (qr) => {
  console.log('\n[bot] Scan the QR code below with WhatsApp:\n');
  qrcode.generate(qr, { small: true });
});

client.on('ready', async () => {
  console.log('[bot] Client is ready!');
  await resolveGroupChatId();
  scheduleReminders(client, () => groupChatId);
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

console.log('[bot] Initialising…');
client.initialize();

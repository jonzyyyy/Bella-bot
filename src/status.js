const { config, isActiveToday, nextDueDate } = require('./configStore');
const db = require('./db');
const { buildStatusMessage } = require('./formatter');

function buildTaskEntry(task, todayMidnight) {
  const completions = db.getCompletionsToday(task.id);
  let daysOverdue = 0;
  const s = task.schedule;
  if (s && (s.everyMonths || s.everyDays)) {
    const due = nextDueDate(task);
    if (due) {
      const dueMidnight = new Date(due);
      dueMidnight.setHours(0, 0, 0, 0);
      daysOverdue = Math.max(0, Math.round((todayMidnight - dueMidnight) / 86400000));
    }
  }
  return { task, completions, daysOverdue };
}

/**
 * Builds the current day's status summary. Shows all tasks due today plus
 * any task completed today even if it wasn't scheduled (e.g. bath done early,
 * teeth brushed outside their weekly window).
 */
function buildCurrentStatus() {
  const todayMidnight = new Date();
  todayMidnight.setHours(0, 0, 0, 0);
  const seen = new Set();
  const taskData = [];

  for (const task of config.tasks) {
    if (!isActiveToday(task)) continue;
    seen.add(task.id);
    taskData.push(buildTaskEntry(task, todayMidnight));
  }

  for (const task of config.tasks) {
    if (seen.has(task.id)) continue;
    const completions = db.getCompletionsToday(task.id);
    if (completions.length > 0) taskData.push({ task, completions, daysOverdue: 0 });
  }

  return buildStatusMessage(taskData);
}

const buildEODStatus = buildCurrentStatus;

/** YYYY-MM-DD in the configured timezone. */
function todayStr() {
  return new Date().toLocaleDateString('en-CA', { timeZone: config.timezone });
}

// Two completions seconds apart (e.g. 👍 on breakfast then on medicine) used to
// run concurrently: both read "no previous status yet" and both posted one,
// leaving a stale list in the group. Chaining the sends makes each one see the
// previous message id and delete it.
let statusChain = Promise.resolve();

/**
 * Replaces today's status message: deletes the one(s) already posted, then
 * sends a fresh one to `chatId`. There is only ever one full task list in the
 * group per day — the end-of-day summary goes through here too (eod: true), so
 * at 9pm it takes over the day's list rather than adding a second one.
 */
function sendStatus(chatId, client, { eod = false } = {}) {
  statusChain = statusChain
    .then(() => postStatus(chatId, client, eod))
    .catch((err) => console.error('[status] Failed to send status:', err.message));
  return statusChain;
}

/**
 * Deletes one of the bot's own messages for everyone, and reports whether it
 * actually worked.
 *
 * Message.delete(true) is not trustworthy on its own: whatsapp-web.js asks
 * WhatsApp whether the message can be revoked and, if the answer is no,
 * silently downgrades to a delete-for-me and still resolves successfully. The
 * answer is no when WhatsApp only has a stub of the message rather than a full
 * model, which is what left status lists sitting in the group with nothing in
 * the logs. Re-reading the message afterwards is the only way to know.
 *
 * @returns {Promise<boolean>} true once the message is gone from the chat
 */
async function revokeMessage(client, messageId) {
  const msg = await client.getMessageById(messageId).catch(() => null);
  if (!msg || msg.type === 'revoked') return true; // already gone

  await msg.delete(true);

  const after = await client.getMessageById(messageId).catch(() => null);
  return !after || after.type === 'revoked';
}

async function postStatus(chatId, client, eod) {
  const date = todayStr();
  const chat = await client.getChatById(chatId);

  // Pull recent history into WhatsApp's in-memory store before deleting: a
  // message it only has a stub of fails the revoke check above.
  try {
    await chat.fetchMessages({ limit: 30 });
  } catch (err) {
    console.warn('[status] Could not preload recent messages:', err.message);
  }

  // Clear every status still tracked for today, not just the newest. A row is
  // dropped only once the message is confirmed gone, so a revoke that didn't
  // take is retried on the next completion instead of stranding a second list.
  db.purgeStatusMessagesBefore(date);
  for (const prev of db.getStatusMessages(date)) {
    let gone = false;
    try {
      gone = await revokeMessage(client, prev.message_id);
    } catch (err) {
      console.error('[status] Could not delete previous status:', err.message);
    }
    if (gone) {
      db.removeStatusMessage(prev.id);
    } else {
      console.warn(`[status] Previous status ${prev.message_id} survived deletion — retrying next time`);
    }
  }

  // Sent as a plain message, never a reply: a reply quotes the reminder (or the
  // user's own text) back into the group, which both doubles the text and makes
  // the just-deleted reminder look like it's still there.
  const body = eod
    ? `📊 *End-of-day check* — everything should be done by now:\n\n${buildCurrentStatus()}`
    : buildCurrentStatus();
  const sent = await chat.sendMessage(body);
  if (sent?.id) {
    db.saveStatusMessage(sent.id._serialized ?? sent.id.id, chatId, date);
  }
}

/**
 * Builds a status summary for a past date.
 * Shows all daily (unscheduled) tasks with ✅/❌, plus any scheduled task
 * that was actually completed that day.
 * @param {string} dateStr   "YYYY-MM-DD" in the configured timezone
 * @param {string} startISO  UTC start of that local day
 * @param {string} endISO    UTC end of that local day (exclusive)
 */
function buildHistoricalStatus(dateStr, startISO, endISO) {
  const taskData = [];
  for (const task of config.tasks) {
    const completions = db.getCompletionsBetween(task.id, startISO, endISO);
    if (!task.schedule) {
      taskData.push({ task, completions, daysOverdue: 0 });
    } else if (completions.length > 0) {
      taskData.push({ task, completions, daysOverdue: 0 });
    }
  }
  // Pass the date so the header shows the correct day, not today.
  return buildStatusMessage(taskData, new Date(startISO));
}

module.exports = { buildCurrentStatus, buildEODStatus, buildHistoricalStatus, sendStatus, revokeMessage };

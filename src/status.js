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

// A revoke doesn't show up in the local message model straight away: measured
// on the pinned web build, a message still reads as type "chat" immediately
// after delete() and only reads as gone a few seconds later. Checking sooner
// reports working deletes as failures.
const REVOKE_SETTLE_MS = 5000;

// Give up on a message after this many failed attempts rather than retrying a
// stuck message on every completion for the rest of the day.
const MAX_DELETE_ATTEMPTS = 3;

const settle = (ms) => new Promise((r) => setTimeout(r, ms));

/** True once WhatsApp no longer holds the message as a normal chat message. */
async function isGone(client, messageId) {
  const msg = await client.getMessageById(messageId).catch(() => null);
  return !msg || msg.type === 'revoked';
}

async function postStatus(chatId, client, eod) {
  const date = todayStr();
  const chat = await client.getChatById(chatId);

  // Pull recent history into WhatsApp's in-memory store so the messages we're
  // about to delete are loaded and addressable.
  try {
    await chat.fetchMessages({ limit: 30 });
  } catch (err) {
    console.warn('[status] Could not preload recent messages:', err.message);
  }

  // Clear every status still tracked for today, not just the newest. Delete
  // them all first and verify once afterwards, so the wait for WhatsApp to
  // catch up is paid a single time rather than per message.
  db.purgeStatusMessagesBefore(date);
  const pending = [];
  for (const prev of db.getStatusMessages(date)) {
    try {
      if (await isGone(client, prev.message_id)) {
        db.removeStatusMessage(prev.id);
        continue;
      }
      const msg = await client.getMessageById(prev.message_id);
      await msg.delete(true);
      pending.push(prev);
    } catch (err) {
      console.error('[status] Could not delete previous status:', err.message);
      pending.push(prev);
    }
  }

  // Post the new list before verifying: the deletes are already issued, and
  // waiting on WhatsApp to catch up first would just delay the reply people are
  // waiting for after reacting.
  //
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

  if (pending.length === 0) return;
  await settle(REVOKE_SETTLE_MS);
  for (const prev of pending) {
    if (await isGone(client, prev.message_id)) {
      db.removeStatusMessage(prev.id);
    } else if (prev.attempts + 1 >= MAX_DELETE_ATTEMPTS) {
      console.error(`[status] Giving up on ${prev.message_id} after ${MAX_DELETE_ATTEMPTS} attempts`);
      db.removeStatusMessage(prev.id);
    } else {
      console.warn(`[status] ${prev.message_id} still present — retrying next time`);
      db.bumpStatusAttempt(prev.id);
    }
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

module.exports = { buildCurrentStatus, buildEODStatus, buildHistoricalStatus, sendStatus };

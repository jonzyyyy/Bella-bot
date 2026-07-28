const { config, isActiveToday, nextDueDate } = require('./configStore');
const db = require('./db');
const { buildStatusMessage } = require('./formatter');
const { revoke } = require('./revoker');

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

// Give up on a message after this many failed attempts rather than retrying a
// stuck message on every completion for the rest of the day.
const MAX_DELETE_ATTEMPTS = 3;

async function postStatus(chatId, client, eod) {
  const date = todayStr();
  const chat = await client.getChatById(chatId);

  // Clear every status still tracked for today, not just the newest. Each
  // revoke goes through the global queue, which confirms one is gone before
  // issuing the next — two in flight at once and WhatsApp drops the second.
  db.purgeStatusMessagesBefore(date);
  for (const prev of db.getStatusMessages(date)) {
    let gone = false;
    try {
      gone = await revoke(client, prev.message_id);
    } catch (err) {
      console.error('[status] Could not delete previous status:', err.message);
    }
    if (gone) {
      db.removeStatusMessage(prev.id);
    } else if (prev.attempts + 1 >= MAX_DELETE_ATTEMPTS) {
      console.error(`[status] Giving up on ${prev.message_id} after ${MAX_DELETE_ATTEMPTS} attempts`);
      db.removeStatusMessage(prev.id);
    } else {
      console.warn(`[status] ${prev.message_id} still present — retrying next time`);
      db.bumpStatusAttempt(prev.id);
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

module.exports = { buildCurrentStatus, buildEODStatus, buildHistoricalStatus, sendStatus };

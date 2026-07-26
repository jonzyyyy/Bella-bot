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

async function postStatus(chatId, client, eod) {
  const date = todayStr();

  // Clear every status tracked for today, not just the newest — if a delete
  // ever fails the message is stranded in the chat forever otherwise.
  for (const prev of db.getStatusMessages(date)) {
    try {
      const prevMsg = await client.getMessageById(prev.message_id);
      if (prevMsg) await prevMsg.delete(true);
      else console.warn(`[status] Previous status ${prev.message_id} not found (already gone?)`);
    } catch (err) {
      console.error('[status] Could not delete previous status:', err.message);
    }
    db.removeStatusMessage(prev.id);
  }

  // Sent as a plain message, never a reply: a reply quotes the reminder (or the
  // user's own text) back into the group, which both doubles the text and makes
  // the just-deleted reminder look like it's still there.
  const body = eod
    ? `📊 *End-of-day check* — everything should be done by now:\n\n${buildCurrentStatus()}`
    : buildCurrentStatus();
  const chat = await client.getChatById(chatId);
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

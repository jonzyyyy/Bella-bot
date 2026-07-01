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

/** Builds the current day's status summary string (only tasks active today). */
function buildCurrentStatus() {
  const todayMidnight = new Date();
  todayMidnight.setHours(0, 0, 0, 0);
  const taskData = config.tasks
    .filter((task) => isActiveToday(task))
    .map((task) => buildTaskEntry(task, todayMidnight));
  return buildStatusMessage(taskData);
}

/**
 * Like buildCurrentStatus but also appends any task that was completed today
 * even if it wasn't scheduled for today (e.g. bath, vaccination done early).
 * Used for the end-of-day summary.
 */
function buildEODStatus() {
  const todayMidnight = new Date();
  todayMidnight.setHours(0, 0, 0, 0);
  const seen = new Set();
  const taskData = [];

  for (const task of config.tasks) {
    if (!isActiveToday(task)) continue;
    seen.add(task.id);
    taskData.push(buildTaskEntry(task, todayMidnight));
  }

  // Append interval/scheduled tasks completed today that weren't in the active list
  for (const task of config.tasks) {
    if (seen.has(task.id)) continue;
    const completions = db.getCompletionsToday(task.id);
    if (completions.length > 0) taskData.push({ task, completions, daysOverdue: 0 });
  }

  return buildStatusMessage(taskData);
}

/** YYYY-MM-DD in the configured timezone. */
function todayStr() {
  return new Date().toLocaleDateString('en-CA', { timeZone: config.timezone });
}

/**
 * Deletes the previous status message for today (if any), sends a new one as
 * a reply to `replyTarget`, then tracks the new message id for future deletion.
 * The EOD daily summary is NOT routed through here so it is never deleted.
 */
async function sendStatus(replyTarget, client) {
  const date = todayStr();

  const prev = db.getLatestStatusMessage(date);
  if (prev) {
    try {
      const prevMsg = await client.getMessageById(prev.message_id);
      if (prevMsg) await prevMsg.delete(true);
    } catch (_) {}
    db.removeStatusMessage(prev.id);
  }

  const sent = await replyTarget.reply(buildCurrentStatus());
  if (sent?.id) {
    const msgId = sent.id._serialized ?? sent.id.id;
    const chatId = sent.to ?? sent.id?.remote ?? '';
    db.saveStatusMessage(msgId, chatId, date);
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

const { config } = require('./configStore');

/** Parses "HH:MM" into minutes since midnight. */
function toMinutes(hhmm) {
  const [h, m] = String(hhmm).split(':').map((n) => parseInt(n, 10));
  return h * 60 + (m || 0);
}

/** True if the task has a time window that currently covers `now`. */
function windowCoversNow(task, now) {
  if (!task.window) return false;
  const mins = now.getHours() * 60 + now.getMinutes();
  return mins >= toMinutes(task.window.from) && mins <= toMinutes(task.window.to);
}

/**
 * Returns the best-matching task for the message text, or null.
 *
 * When several tasks share a keyword (e.g. "fed" matches both Breakfast and
 * Dinner), we disambiguate by:
 *   1. Number of matching keywords — an explicit word like "dinner" wins.
 *   2. Time-of-day window — a plain "fed" in the morning → Breakfast.
 *   3. First defined, as a last resort.
 */
function matchTask(text, now = new Date()) {
  if (!text) return null;
  const normalised = text.toLowerCase().trim();

  let candidates = [];
  for (const task of config.tasks) {
    let score = 0;
    for (const kw of task.keywords) {
      // Substring match so partial sentences like "just fed her" still work.
      if (normalised.includes(kw.toLowerCase())) score++;
    }
    if (score > 0) candidates.push({ task, score });
  }

  if (candidates.length === 0) return null;

  // Keep only the highest-scoring candidates (explicit keywords win).
  const maxScore = Math.max(...candidates.map((c) => c.score));
  candidates = candidates.filter((c) => c.score === maxScore);
  if (candidates.length === 1) return candidates[0].task;

  // Tie-break by time-of-day window (uses `now`, which may be an explicit
  // time parsed from the message, e.g. "fed her 7pm").
  const windowed = candidates.find((c) => windowCoversNow(c.task, now));
  return (windowed || candidates[0]).task;
}

/**
 * Returns true if the message is asking for the daily status summary.
 */
function isStatusRequest(text) {
  if (!text) return false;
  return /\bstatus\b/i.test(text);
}

/**
 * If the message is a history request, returns the matched task id; else null.
 * Recognises "history feed", "history walk", "history water", etc.
 */
function matchHistoryRequest(text) {
  if (!text) return null;
  const m = text.match(/\bhistory\s+(\w+)/i);
  if (!m) return null;
  const keyword = m[1].toLowerCase();
  return (
    config.tasks.find(
      (t) =>
        t.id === keyword ||
        t.label.toLowerCase().includes(keyword) ||
        t.keywords.some((k) => k.includes(keyword))
    ) || null
  );
}

/**
 * Returns true if the message is asking for the weekly responsibility breakdown.
 */
function isResponsibilityRequest(text) {
  if (!text) return false;
  return /\b(?:responsib(?:le|ility)|weekly|who\s+did)\b/i.test(text);
}

module.exports = { matchTask, isStatusRequest, matchHistoryRequest, isResponsibilityRequest };

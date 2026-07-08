const { config } = require('./configStore');

// Optional time expression at the end of a completion message,
// e.g. "shat 10am", "fed her 7:30pm", "poop 230pm".
const TRAILING_TIME_RE = /\s+(\d{1,2}:\d{2}\s*(?:am|pm)?|\d{3,4}\s*(?:am|pm)|\d{1,2}\s*(?:am|pm))\s*$/i;

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
 * Returns the matching task for the message text, or null.
 *
 * The message must be EXACTLY a keyword, optionally followed by a time
 * ("shat", "shat 10am", "fed her 7:30pm"). Anything else — extra words,
 * questions, normal conversation — is ignored so casual chat never
 * accidentally logs a task.
 *
 * When several tasks share the matched keyword (e.g. "poop" belongs to
 * morning/evening/extra poop), we disambiguate by:
 *   1. Time-of-day window — "poop" in the morning → Morning poop.
 *   2. A windowless candidate (e.g. Extra poop) outside all windows.
 *   3. Soonest upcoming window, as a last resort.
 */
function matchTask(text, now = new Date()) {
  if (!text) return null;
  const normalised = text
    .toLowerCase()
    .trim()
    .replace(TRAILING_TIME_RE, '')
    .trim();

  let candidates = [];
  for (const task of config.tasks) {
    if (task.keywords.some((kw) => kw.toLowerCase() === normalised)) {
      candidates.push({ task });
    }
  }

  if (candidates.length === 0) return null;
  if (candidates.length === 1) return candidates[0].task;

  // Tie-break by time-of-day window (uses `now`, which may be an explicit
  // time parsed from the message, e.g. "fed her 7pm").
  const windowed = candidates.find((c) => windowCoversNow(c.task, now));
  if (windowed) return windowed.task;

  // Outside all windows — prefer a windowless candidate (e.g. poop_extra)
  // over forcing into the wrong time-window bucket.
  const noWindow = candidates.find((c) => !c.task.window);
  if (noWindow) return noWindow.task;

  // Last resort: pick the window whose start is soonest in the future.
  const windowedCandidates = candidates.filter((c) => c.task.window);
  if (windowedCandidates.length > 0) {
    const nowMins = now.getHours() * 60 + now.getMinutes();
    const withDelta = windowedCandidates.map((c) => ({
      c,
      delta: toMinutes(c.task.window.from) - nowMins,
    }));
    const upcoming = withDelta.filter((w) => w.delta > 0);
    if (upcoming.length > 0) {
      upcoming.sort((a, b) => a.delta - b.delta);
      return upcoming[0].c.task;
    }
    withDelta.sort((a, b) => b.delta - a.delta);
    return withDelta[0].c.task;
  }

  return candidates[0].task;
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

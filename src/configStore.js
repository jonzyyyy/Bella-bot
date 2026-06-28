const fs = require('fs');
const path = require('path');
const config = require('../config.json'); // Node caches this — same object everywhere
const db = require('./db');

const CONFIG_PATH = path.join(__dirname, '..', 'config.json');

/**
 * Persists the in-memory config object back to config.json on disk.
 * Because every module require()s the same cached object, mutating it and
 * calling save() keeps memory and file in sync.
 */
function save() {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2) + '\n');
}

/**
 * Parses a human time like "8", "8:30", "8am", "6pm", "18:30" into a daily
 * cron expression "M H * * *". Returns null if it can't be parsed.
 */
function parseTimeToCron(input) {
  const s = String(input).trim().toLowerCase();
  const m = s.match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/);
  if (!m) return null;

  let hour = parseInt(m[1], 10);
  const min = m[2] ? parseInt(m[2], 10) : 0;
  const ampm = m[3];

  if (ampm === 'pm' && hour < 12) hour += 12;
  if (ampm === 'am' && hour === 12) hour = 0;

  if (hour > 23 || min > 59) return null;
  return `${min} ${hour} * * *`;
}

/** Parses a human time into a Date set to today at that time, or null. */
function parseTimeToDate(input) {
  const cronExpr = parseTimeToCron(input);
  if (!cronExpr) return null;
  const [min, hour] = cronExpr.split(' ').map(Number);
  const d = new Date();
  d.setHours(hour, min, 0, 0);
  return d;
}

/**
 * Finds an explicit time inside a free-text message and returns it as a Date
 * (today), or null. Requires am/pm or a colon to avoid matching stray numbers
 * ("fed her 2 times" must NOT parse as 2am).
 */
function extractTimeFromText(text) {
  const m = String(text).match(/\b(\d{1,2}:\d{2}\s*(?:am|pm)?|\d{1,2}\s*(?:am|pm))\b/i);
  if (!m) return null;
  return parseTimeToDate(m[1].replace(/\s+/g, ''));
}

const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** A comparable integer for a date's calendar day, e.g. 2026-07-06 → 20260706. */
function dayNum(d) {
  return d.getFullYear() * 10000 + (d.getMonth() + 1) * 100 + d.getDate();
}

/** Adds whole months to a date, clamping (e.g. Jan 31 + 1mo → Feb 28/29). */
function addMonths(date, n) {
  const d = new Date(date);
  const day = d.getDate();
  d.setDate(1);
  d.setMonth(d.getMonth() + n);
  d.setDate(Math.min(day, daysInMonth(d.getFullYear(), d.getMonth())));
  return d;
}

function daysInMonth(year, monthIndex) {
  return new Date(year, monthIndex + 1, 0).getDate();
}

function addDays(date, n) {
  const d = new Date(date);
  d.setDate(d.getDate() + n);
  return d;
}

/**
 * For interval schedules (everyMonths / everyDays), the next date the task is
 * due — based on the last time it was logged, or the `anchor` date if never
 * logged. Returns null for non-interval schedules.
 */
function nextDueDate(task) {
  const s = task.schedule;
  if (!s || (!s.everyMonths && !s.everyDays)) return null;
  const anchor = s.anchor ? new Date(s.anchor + 'T00:00:00') : null;
  const last = db.getLastCompletion(task.id);
  const baseline = last ? new Date(last.timestamp) : anchor;
  if (!baseline) return null;
  return s.everyMonths ? addMonths(baseline, s.everyMonths) : addDays(baseline, s.everyDays);
}

/**
 * Whether a task is active on the given date, per its optional `schedule`:
 *   schedule.daysOfWeek  — array of 0(Sun)–6(Sat)
 *   schedule.daysOfMonth — array of 1–31
 *   schedule.everyMonths / everyDays (+ optional anchor) — interval recurrence
 * No schedule → active every day. Interval tasks stay active (overdue) from
 * their due date until logged, then advance to the next cycle automatically.
 * Days are evaluated in the configured timezone so they match reminders.
 */
function isActiveToday(task, date = new Date()) {
  const s = task.schedule;
  if (!s) return true;
  const local = new Date(date.toLocaleString('en-US', { timeZone: config.timezone }));

  if (s.everyMonths || s.everyDays) {
    const due = nextDueDate(task);
    return due ? dayNum(local) >= dayNum(due) : true;
  }

  if (Array.isArray(s.daysOfWeek) && !s.daysOfWeek.includes(local.getDay())) return false;
  if (Array.isArray(s.daysOfMonth) && !s.daysOfMonth.includes(local.getDate())) return false;
  return true;
}

/** Human-readable description of a task's schedule, e.g. "Wed & Sun". */
function describeSchedule(task) {
  const s = task.schedule;
  if (!s) return 'daily';

  if (s.everyMonths || s.everyDays) {
    const n = s.everyMonths || s.everyDays;
    const unit = s.everyMonths ? 'month' : 'day';
    const due = nextDueDate(task);
    const dueStr = due
      ? due.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })
      : '?';
    return `every ${n} ${unit}${n > 1 ? 's' : ''} (next: ${dueStr})`;
  }

  const parts = [];
  if (Array.isArray(s.daysOfWeek)) parts.push(s.daysOfWeek.map((d) => DOW[d]).join(' & '));
  if (Array.isArray(s.daysOfMonth)) parts.push('day ' + s.daysOfMonth.join(', ') + ' of month');
  return parts.join('; ') || 'daily';
}

/** Converts a "M H * * *" cron back into a friendly "8:30am" string. */
function cronToTime(cronExpr) {
  const parts = cronExpr.split(' ');
  if (parts.length < 2) return cronExpr;
  let hour = parseInt(parts[1], 10);
  const min = String(parseInt(parts[0], 10)).padStart(2, '0');
  const ampm = hour >= 12 ? 'pm' : 'am';
  hour = hour % 12 || 12;
  return `${hour}:${min}${ampm}`;
}

function getTask(taskId) {
  return config.tasks.find(
    (t) => t.id.toLowerCase() === String(taskId).toLowerCase()
  );
}

/**
 * Replaces a task's reminder times with the supplied list of times.
 * Existing reminder messages are preserved by position; new slots get a
 * sensible default message.
 *
 * @param {string} taskId
 * @param {string[]} timeStrings  e.g. ["8am", "6pm"]
 * @returns {{ ok: true, task } | { ok: false, error: string }}
 */
function setTaskTimes(taskId, timeStrings) {
  const task = getTask(taskId);
  if (!task) {
    return { ok: false, error: `Unknown task "${taskId}".` };
  }

  const crons = [];
  for (const t of timeStrings) {
    const cronExpr = parseTimeToCron(t);
    if (!cronExpr) {
      return { ok: false, error: `Couldn't understand the time "${t}". Try formats like 8, 8:30, 8am, 6pm.` };
    }
    crons.push(cronExpr);
  }

  const oldReminders = task.reminders || [];
  task.reminders = crons.map((cronExpr, i) => ({
    cron: cronExpr,
    message:
      oldReminders[i]?.message ||
      `${config.petName} reminder: ${task.label} ${task.emoji || ''}`.trim(),
  }));

  save();
  return { ok: true, task };
}

/**
 * Adds a brand-new task to the config.
 * @param {{id: string, label: string, keywords: string[], timeStrings?: string[], emoji?: string}} opts
 * @returns {{ ok: true, task } | { ok: false, error: string }}
 */
function addTask({ id, label, keywords = [], timeStrings = [], emoji = '' }) {
  id = String(id || '').toLowerCase().trim();
  label = String(label || '').trim();

  if (!/^[a-z0-9]+$/.test(id)) {
    return { ok: false, error: `Task id must be a single word (letters/numbers only), got "${id}".` };
  }
  if (getTask(id)) {
    return { ok: false, error: `Task "${id}" already exists.` };
  }
  if (!label) {
    return { ok: false, error: 'Please give the task a label.' };
  }

  const crons = [];
  for (const t of timeStrings) {
    const cronExpr = parseTimeToCron(t);
    if (!cronExpr) {
      return { ok: false, error: `Couldn't understand the time "${t}". Try formats like 8, 8:30, 8am, 6pm.` };
    }
    crons.push(cronExpr);
  }

  // Build keyword list: user keywords + the id + the label, de-duplicated.
  const kwSet = new Set();
  for (const k of keywords) {
    const v = String(k).toLowerCase().trim();
    if (v) kwSet.add(v);
  }
  kwSet.add(id);
  kwSet.add(label.toLowerCase());

  const message = `${config.petName} reminder: ${label} ${emoji}`.trim();
  const task = {
    id,
    label,
    emoji,
    keywords: [...kwSet],
    reminders: crons.map((cronExpr) => ({ cron: cronExpr, message })),
  };

  config.tasks.push(task);
  save();
  return { ok: true, task };
}

const DOW_MAP = {
  sun: 0, sunday: 0,
  mon: 1, monday: 1,
  tue: 2, tues: 2, tuesday: 2,
  wed: 3, weds: 3, wednesday: 3,
  thu: 4, thur: 4, thurs: 4, thursday: 4,
  fri: 5, friday: 5,
  sat: 6, saturday: 6,
};

/** Local YYYY-MM-DD for a date (used as an interval anchor). */
function toISODateLocal(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/**
 * Sets (or clears) a task's schedule from a list of tokens.
 *   weekdays: "mon", "wed", "sun" …          → daysOfWeek
 *   dates:    "1", "15", "29"                → daysOfMonth
 *   interval: "every 3 months" / "every 14 days" → everyMonths/everyDays
 *             (anchored to today; advances each time the task is logged)
 *   "daily" / "everyday" / "off"            → clears the schedule (active daily)
 * @returns {{ ok: true, task } | { ok: false, error: string }}
 */
function setTaskSchedule(taskId, tokens) {
  const task = getTask(taskId);
  if (!task) {
    return { ok: false, error: `Unknown task "${taskId}".` };
  }

  if (tokens.length === 1 && /^(daily|everyday|all|off|none)$/i.test(tokens[0])) {
    delete task.schedule;
    save();
    return { ok: true, task };
  }

  // Interval: "every 3 months" / "every 14 days"
  const intervalMatch = tokens.join(' ').toLowerCase().match(/^every\s+(\d+)\s+(day|days|month|months)$/);
  if (intervalMatch) {
    const n = +intervalMatch[1];
    if (n < 1) return { ok: false, error: 'Interval must be at least 1.' };
    const key = intervalMatch[2].startsWith('month') ? 'everyMonths' : 'everyDays';
    // Keep an existing anchor if present, else anchor to today.
    const anchor = task.schedule?.anchor || toISODateLocal(new Date());
    task.schedule = { [key]: n, anchor };
    save();
    return { ok: true, task };
  }

  const daysOfWeek = [];
  const daysOfMonth = [];
  for (const t of tokens) {
    const key = t.toLowerCase();
    if (key in DOW_MAP) {
      daysOfWeek.push(DOW_MAP[key]);
    } else if (/^\d{1,2}$/.test(t) && +t >= 1 && +t <= 31) {
      daysOfMonth.push(+t);
    } else {
      return { ok: false, error: `Couldn't understand "${t}". Use weekdays (mon, tue, …) or dates (1–31).` };
    }
  }

  const schedule = {};
  if (daysOfWeek.length) schedule.daysOfWeek = [...new Set(daysOfWeek)].sort((a, b) => a - b);
  if (daysOfMonth.length) schedule.daysOfMonth = [...new Set(daysOfMonth)].sort((a, b) => a - b);
  task.schedule = schedule;
  save();
  return { ok: true, task };
}

/**
 * Removes a task by id.
 * @returns {{ ok: true, task } | { ok: false, error: string }}
 */
function removeTask(id) {
  const idx = config.tasks.findIndex(
    (t) => t.id.toLowerCase() === String(id).toLowerCase()
  );
  if (idx === -1) {
    return { ok: false, error: `No task called "${id}".` };
  }
  const [removed] = config.tasks.splice(idx, 1);
  save();
  return { ok: true, task: removed };
}

module.exports = {
  config,
  save,
  parseTimeToCron,
  parseTimeToDate,
  extractTimeFromText,
  cronToTime,
  isActiveToday,
  describeSchedule,
  nextDueDate,
  getTask,
  setTaskTimes,
  setTaskSchedule,
  addTask,
  removeTask,
};

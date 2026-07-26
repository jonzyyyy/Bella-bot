const fs = require('fs');
const path = require('path');
const db = require('./db');

// Allow a different config file for test instances via BELLA_CONFIG env var.
const CONFIG_PATH = path.resolve(__dirname, '..', process.env.BELLA_CONFIG || 'config.json');
const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));

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

  // Compact no-colon format: "230pm" → 2:30pm, "1130am" → 11:30am
  const compact = s.match(/^(\d{3,4})\s*(am|pm)$/);
  if (compact) {
    const digits = compact[1];
    const min = parseInt(digits.slice(-2), 10);
    let hour = parseInt(digits.slice(0, -2), 10);
    const ampm = compact[2];
    if (ampm === 'pm' && hour < 12) hour += 12;
    if (ampm === 'am' && hour === 12) hour = 0;
    if (hour > 23 || min > 59) return null;
    return `${min} ${hour} * * *`;
  }

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
  // Order: colon format first, then compact no-colon (e.g. "230pm"), then plain hour+ampm.
  const m = String(text).match(/\b(\d{1,2}:\d{2}\s*(?:am|pm)?|\d{3,4}\s*(?:am|pm)|\d{1,2}\s*(?:am|pm))\b/i);
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
  let computed = s.everyMonths ? addMonths(baseline, s.everyMonths) : addDays(baseline, s.everyDays);
  if (s.deferredUntil) {
    const deferred = new Date(s.deferredUntil + 'T00:00:00');
    if (deferred > computed) computed = deferred;
  }
  // Drontal must be at least 7 days after the last NexGard — enforced dynamically
  // so it's always correct regardless of when NexGard was logged.
  if (task.id === 'drontal') {
    const lastNexgard = db.getLastCompletion('nexgard');
    if (lastNexgard) {
      const safeAfter = new Date(new Date(lastNexgard.timestamp).getTime() + 7 * 86400000);
      if (safeAfter > computed) computed = safeAfter;
    }
  }
  return computed;
}

/**
 * Returns the task's ignore block ({ reason, until }) if it's active on the
 * given date, else null. `until` is inclusive — the task is skipped through the
 * end of that local day and reverts to normal the morning after. Expired
 * blocks are pruned from the config lazily so they don't linger.
 */
function activeIgnore(task, date = new Date()) {
  const ig = task.ignore;
  if (!ig || !ig.until) return null;
  const local = new Date(date.toLocaleString('en-US', { timeZone: config.timezone }));
  if (dayNum(local) <= dayNum(new Date(ig.until + 'T00:00:00'))) return ig;
  delete task.ignore;
  save();
  return null;
}

/**
 * Marks a task to be skipped (with a reason) until the given date, inclusive.
 * @param {string} taskId
 * @param {string} until   "YYYY-MM-DD" local date the skip expires at end of
 * @param {string} reason  shown next to the task in the status list
 */
function setTaskIgnore(taskId, until, reason) {
  const task = getTask(taskId);
  if (!task) return { ok: false, error: `Unknown task "${taskId}".` };
  task.ignore = { reason, until };
  save();
  return { ok: true, task };
}

function clearTaskIgnore(taskId) {
  const task = getTask(taskId);
  if (!task) return { ok: false, error: `Unknown task "${taskId}".` };
  delete task.ignore;
  save();
  return { ok: true, task };
}

/** Clears any active deferral on a task (called after the task is logged). */
function clearTaskDeferral(taskId) {
  const task = getTask(taskId);
  if (!task?.schedule) return;
  delete task.schedule.deferredUntil;
  delete task.schedule.deferralInfo;
  save();
}

/**
 * Whether a task is active on the given date, per its optional `schedule`:
 *   schedule.daysOfWeek  — array of 0(Sun)–6(Sat)
 *   schedule.daysOfMonth — array of 1–31
 *   schedule.everyMonths / everyDays (+ optional anchor) — interval recurrence
 *   schedule.from / until — YYYY-MM-DD bounds (inclusive) limiting when the
 *     task runs at all, e.g. a daily course for one week.
 * No schedule → active every day. Interval tasks stay active (overdue) from
 * their due date until logged, then advance to the next cycle automatically.
 * Days are evaluated in the configured timezone so they match reminders.
 */
function isActiveToday(task, date = new Date()) {
  const s = task.schedule;
  if (!s) return true;
  const local = new Date(date.toLocaleString('en-US', { timeZone: config.timezone }));

  // Date-range bounds apply to every schedule type.
  if (s.from && dayNum(local) < dayNum(new Date(s.from + 'T00:00:00'))) return false;
  if (s.until && dayNum(local) > dayNum(new Date(s.until + 'T00:00:00'))) return false;

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
  let desc = parts.join('; ') || 'daily';
  if (s.until) {
    const untilStr = new Date(s.until + 'T00:00:00').toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
    desc += ` until ${untilStr}`;
  }
  return desc;
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
 * Assigns one or more people to a task, stored as { id, name }[] so reminders
 * can @mention the id and the status list can show the name.
 * With more than one, they rotate — see currentAssignee().
 * @param {string} taskId
 * @param {{ id: string, name: string }[]} assignees
 * @returns {{ ok: true, task } | { ok: false, error: string }}
 */
function setTaskAssignees(taskId, assignees) {
  const task = getTask(taskId);
  if (!task) return { ok: false, error: `Unknown task "${taskId}".` };
  task.assignees = assignees.map((a) => ({ id: a.id, name: a.name }));
  save();
  return { ok: true, task };
}

function clearTaskAssignee(taskId) {
  const task = getTask(taskId);
  if (!task) return { ok: false, error: `Unknown task "${taskId}".` };
  delete task.assignees;
  save();
  return { ok: true, task };
}

/**
 * Returns the assignee currently "on duty" for a task ({ id, name }), or null
 * if unassigned. With multiple assignees they rotate by the task's all-time
 * completion count, so each occurrence tags the next person in line — a
 * missed/skipped occurrence just holds the turn rather than skipping it.
 */
function currentAssignee(task) {
  const list = task.assignees;
  if (!list || list.length === 0) return null;
  if (list.length === 1) return list[0];
  const count = db.getCompletionCount(task.id);
  return list[count % list.length];
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
 * Returns UTC ISO timestamps covering a full local-timezone day for a given
 * "YYYY-MM-DD" date string (interpreted in the configured timezone).
 */
/**
 * Converts a local calendar date + time (in the configured timezone) into a
 * Date (UTC under the hood). Used to backdate completions, e.g. "fed yesterday".
 * @param {string} dateStr  "YYYY-MM-DD" in the configured timezone
 * @param {number} hour     0–23 local
 * @param {number} min      0–59 local
 */
function localDateTimeToUTC(dateStr, hour = 12, min = 0) {
  const now = new Date();
  const local = new Date(now.toLocaleString('en-US', { timeZone: config.timezone }));
  const fakeOffset = local.getTime() - now.getTime();
  const [y, m, d] = dateStr.split('-').map(Number);
  const fake = new Date(y, m - 1, d, hour, min, 0, 0);
  return new Date(fake.getTime() - fakeOffset);
}

function dayBoundsUTC(dateStr) {
  const now = new Date();
  const local = new Date(now.toLocaleString('en-US', { timeZone: config.timezone }));
  const fakeOffset = local.getTime() - now.getTime();
  const [y, m, d] = dateStr.split('-').map(Number);
  const startFake = new Date(y, m - 1, d, 0, 0, 0, 0);
  const endFake   = new Date(y, m - 1, d + 1, 0, 0, 0, 0);
  return {
    start: new Date(startFake.getTime() - fakeOffset).toISOString(),
    end:   new Date(endFake.getTime()   - fakeOffset).toISOString(),
  };
}

/**
 * Returns the UTC ISO timestamps for the start and end of the current week
 * (Monday 00:00 → next Monday 00:00) in the configured timezone.
 */
function currentWeekRange() {
  const now = new Date();
  // Build a "fake" Date whose calendar fields (getDay, getDate, etc.) reflect
  // the configured local timezone — same trick used in isActiveToday().
  const local = new Date(now.toLocaleString('en-US', { timeZone: config.timezone }));
  const fakeOffset = local.getTime() - now.getTime();

  const dow = local.getDay(); // 0=Sun … 6=Sat
  const daysSinceMonday = (dow + 6) % 7;

  const mondayLocal = new Date(local);
  mondayLocal.setDate(mondayLocal.getDate() - daysSinceMonday);
  mondayLocal.setHours(0, 0, 0, 0);

  const weekStart = new Date(mondayLocal.getTime() - fakeOffset);
  const weekEnd   = new Date(weekStart.getTime() + 7 * 24 * 60 * 60 * 1000);

  return { start: weekStart.toISOString(), end: weekEnd.toISOString() };
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
  clearTaskDeferral,
  activeIgnore,
  setTaskIgnore,
  clearTaskIgnore,
  dayBoundsUTC,
  localDateTimeToUTC,
  currentWeekRange,
  getTask,
  setTaskTimes,
  setTaskSchedule,
  setTaskAssignees,
  clearTaskAssignee,
  currentAssignee,
  addTask,
  removeTask,
};

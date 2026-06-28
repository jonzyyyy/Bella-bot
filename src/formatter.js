const { config, describeSchedule } = require('./configStore');

const NUMBER_EMOJIS = ['1️⃣', '2️⃣', '3️⃣', '4️⃣', '5️⃣', '6️⃣', '7️⃣', '8️⃣', '9️⃣'];

function fmtTime(isoString) {
  const d = new Date(isoString);
  let h = d.getHours();
  const m = String(d.getMinutes()).padStart(2, '0');
  const ampm = h >= 12 ? 'pm' : 'am';
  h = h % 12 || 12;
  return `${h}:${m}${ampm}`;
}

function fmtDate(isoString) {
  return new Date(isoString).toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'long',
  });
}

/**
 * Builds the daily status summary message.
 * @param {Array<{task: object, completions: Array}>} taskData
 */
function buildStatusMessage(taskData) {
  const today = new Date().toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'long',
  });

  const lines = [`🐾 *${config.petName}'s Tasks — ${today}*`];

  taskData.forEach(({ task, completions, daysOverdue = 0 }, i) => {
    const num = NUMBER_EMOJIS[i] ?? `${i + 1}.`;
    if (completions.length === 0) {
      const overdue = daysOverdue > 0
        ? ` _(${daysOverdue} day${daysOverdue === 1 ? '' : 's'} overdue)_`
        : '';
      lines.push(`${num} ${task.label} ❌${overdue}`);
    } else if (task.multiple) {
      // Tasks that can happen several times a day (e.g. poop) — list them all.
      const all = completions
        .map((c) => `${fmtTime(c.timestamp)} by ${c.user_name}`)
        .join(', ');
      lines.push(`${num} ${task.label} ✅ ×${completions.length} (${all})`);
    } else {
      const last = completions[completions.length - 1];
      lines.push(
        `${num} ${task.label} ✅ (${fmtTime(last.timestamp)} by ${last.user_name})`
      );
    }
  });

  return lines.join('\n');
}

/**
 * Builds the history message for a single task over the last 7 days.
 * @param {object} task
 * @param {Array} completions  sorted DESC by timestamp
 */
function buildHistoryMessage(task, completions) {
  const lines = [
    `📋 *${task.label} — last 7 days*`,
  ];

  if (completions.length === 0) {
    lines.push('No completions recorded.');
    return lines.join('\n');
  }

  // Group by date
  const byDate = {};
  for (const c of completions) {
    const key = fmtDate(c.timestamp);
    if (!byDate[key]) byDate[key] = [];
    byDate[key].push(c);
  }

  for (const [date, entries] of Object.entries(byDate)) {
    const times = entries
      .map((e) => `${fmtTime(e.timestamp)} by ${e.user_name}`)
      .join(', ');
    lines.push(`• ${date}: ${times}`);
  }

  return lines.join('\n');
}

/**
 * Builds a list of every task's current reminder times.
 * @param {(cron: string) => string} cronToTime
 */
function buildRemindersMessage(cronToTime) {
  const lines = ['⏰ *Current reminders*'];
  for (const task of config.tasks) {
    const sched = describeSchedule(task);
    const when = sched === 'daily' ? '' : ` _(${sched})_`;
    if (!task.reminders || task.reminders.length === 0) {
      lines.push(`• *${task.id}* (${task.label}): none${when}`);
    } else {
      const times = task.reminders.map((r) => cronToTime(r.cron)).join(', ');
      lines.push(`• *${task.id}* (${task.label}): ${times}${when}`);
    }
  }
  lines.push('');
  lines.push('_To change: `remind <task> <times…>`  e.g._ `remind feed 8am 6pm`');
  return lines.join('\n');
}

/**
 * Builds the weekly responsibility breakdown message.
 * @param {Array<{user_name: string, task: string, count: number}>} rows
 * @param {string} weekStart  UTC ISO string — Monday 00:00 local time
 * @param {string} weekEnd    UTC ISO string — next Monday 00:00 local time (exclusive)
 */
function buildWeeklyResponsibility(rows, weekStart, weekEnd) {
  const tz = config.timezone;

  const fmtDay = (iso) =>
    new Date(iso).toLocaleDateString('en-GB', {
      timeZone: tz,
      weekday: 'short',
      day: 'numeric',
      month: 'short',
    });

  // weekEnd is exclusive (next Monday midnight), display the day before
  const lastMoment = new Date(new Date(weekEnd).getTime() - 1).toISOString();
  const header = `📊 *Weekly responsibility — ${fmtDay(weekStart)} – ${fmtDay(lastMoment)}*`;

  if (rows.length === 0) {
    return `${header}\n\nNo tasks logged yet this week.\n\n_Resets Monday_`;
  }

  // Group by user
  const byUser = {};
  for (const row of rows) {
    if (!byUser[row.user_name]) byUser[row.user_name] = { total: 0, breakdown: [] };
    byUser[row.user_name].total += row.count;
    const task = config.tasks.find((t) => t.id === row.task);
    const label = task ? `${task.emoji || ''} ${task.label}`.trim() : row.task;
    byUser[row.user_name].breakdown.push(`${label} ×${row.count}`);
  }

  const lines = [header, ''];
  for (const [user, data] of Object.entries(byUser)) {
    lines.push(`• *${user}* — ${data.total} task${data.total === 1 ? '' : 's'} done`);
    lines.push(`  ${data.breakdown.join(', ')}`);
  }
  lines.push('');
  lines.push('_Resets Monday_');

  return lines.join('\n');
}

module.exports = { buildStatusMessage, buildHistoryMessage, buildRemindersMessage, buildWeeklyResponsibility, fmtTime };

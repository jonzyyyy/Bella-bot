const {
  config, save, cronToTime, setTaskTimes, setTaskSchedule, addTask, removeTask,
  extractTimeFromText, describeSchedule, parseTimeToCron, getTask, currentWeekRange, dayBoundsUTC,
  nextDueDate, clearTaskDeferral, setTaskAssignee, clearTaskAssignee, localDateTimeToUTC,
} = require('./configStore');
const db = require('./db');
const { matchTask, isStatusRequest, matchHistoryRequest, isResponsibilityRequest } = require('./matcher');
const { buildHistoryMessage, buildRemindersMessage, buildWeeklyResponsibility, fmtTime } = require('./formatter');
const { rescheduleReminders } = require('./reminders');
const { buildCurrentStatus, buildHistoricalStatus, sendStatus } = require('./status');
const { notify } = require('./notify');

/**
 * Handles an incoming text message.
 */
// Markers that identify the bot's own output, so we never react to ourselves
// and trigger an infinite loop (e.g. the status summary contains "Walked",
// which would otherwise re-match the walk keyword).
const BOT_MARKERS = ['🐾', '📋', '⏰', '🆕', '🗑️', '♻️', '🔔', '🗓️', '⚙️', '📊', '⚠️', '👥'];

// Pending duplicate confirmations — keyed by chat ID, cleared after 5 min or on response.
// { task, triggeredBy, when (Date|null), expiresAt (ms timestamp) }
const pendingConfirmations = new Map();

const MONTH_MAP = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
  jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
  january: 0, february: 1, march: 2, april: 3, june: 5,
  july: 6, august: 7, september: 8, october: 9, november: 10, december: 11,
};

/**
 * Parses a date argument ("yesterday", "28 jun", "jun 28") into a
 * "YYYY-MM-DD" string in the configured timezone, or null if unrecognised.
 */
function parseDateArg(arg) {
  const s = arg.trim().toLowerCase();
  const tz = config.timezone;
  const nowLocal = new Date().toLocaleDateString('en-CA', { timeZone: tz }); // "YYYY-MM-DD"
  const [ny, nm, nd] = nowLocal.split('-').map(Number);

  if (s === 'yesterday') {
    const d = new Date(ny, nm - 1, nd - 1);
    return d.toLocaleDateString('en-CA');
  }

  // "28 jun" / "jun 28" / "28 june"
  const m1 = s.match(/^(\d{1,2})\s+([a-z]+)$/);
  const m2 = s.match(/^([a-z]+)\s+(\d{1,2})$/);
  const hit = m1 || m2;
  if (hit) {
    const day   = parseInt(m1 ? hit[1] : hit[2], 10);
    const mon   = MONTH_MAP[m1 ? hit[2] : hit[1]];
    if (mon === undefined || day < 1 || day > 31) return null;
    // Use current year; if the resulting date is in the future, step back a year.
    let year = ny;
    const candidate = new Date(year, mon, day);
    if (candidate > new Date()) year -= 1;
    return new Date(year, mon, day).toLocaleDateString('en-CA');
  }

  return null;
}

const MS_DAY = 86400000;

/**
 * Pulls a date token ("yesterday", "16 jul", "jul 16") out of a completion
 * message so tasks can be backdated. Returns the resolved "YYYY-MM-DD" (local)
 * and the message with the date token removed (so keyword matching still works).
 */
function extractDateFromText(body) {
  const text = String(body).trim();

  const yRe = /\byesterday\b/i;
  if (yRe.test(text)) {
    return { dateStr: parseDateArg('yesterday'), cleaned: text.replace(yRe, ' ').replace(/\s+/g, ' ').trim() };
  }

  // "<day> <month>" or "<month> <day>", e.g. "16 jul" / "jul 16".
  const dm = text.match(/\b(\d{1,2})\s+([a-z]{3,9})\b/i);
  const md = text.match(/\b([a-z]{3,9})\s+(\d{1,2})\b/i);
  const hit = dm || md;
  if (hit) {
    const monthWord = (dm ? hit[2] : hit[1]).toLowerCase();
    if (MONTH_MAP[monthWord] !== undefined) {
      const dateStr = parseDateArg(hit[0].toLowerCase());
      if (dateStr) {
        return { dateStr, cleaned: text.replace(hit[0], ' ').replace(/\s+/g, ' ').trim() };
      }
    }
  }

  return { dateStr: null, cleaned: text };
}

async function deleteTaskReminders(taskId, client) {
  const records = db.getActiveReminderMessages(taskId);
  for (const rec of records) {
    try {
      const msg = await client.getMessageById(rec.message_id);
      if (msg) {
        await msg.delete(true);
        console.log(`[handler] Deleted reminder message for ${taskId}`);
      } else {
        console.warn(`[handler] Reminder message ${rec.message_id} not found (already gone?)`);
      }
    } catch (err) {
      console.error(`[handler] Failed to delete reminder for ${taskId}:`, err.message);
    }
  }
  db.removeReminderMessagesForTask(taskId);
}

/**
 * Returns a warning string if logging `taskId` would violate a medication
 * spacing rule, or null if it's safe to proceed.
 *   drontal: must be ≥ 3 months since last dose, and ≥ 7 days from NexGard
 *   nexgard: must be ≥ 7 days from Drontal
 */
function checkMedConflict(taskId, now) {
  if (taskId === 'drontal') {
    const due = nextDueDate(getTask('drontal'));
    if (due && due > now) {
      const days = Math.ceil((due.getTime() - now.getTime()) / MS_DAY);
      return `Drontal isn't due for another *${days} day${days === 1 ? '' : 's'}* — last dose was too recent (every 3 months).`;
    }
    const lastNexgard = db.getLastCompletion('nexgard');
    if (lastNexgard) {
      const days = Math.round((now.getTime() - new Date(lastNexgard.timestamp).getTime()) / MS_DAY);
      if (days < 7) {
        return `NexGard was given *${days} day${days === 1 ? '' : 's'} ago* — Drontal should be at least 7 days apart.`;
      }
    }
  }

  if (taskId === 'nexgard') {
    const lastDrontal = db.getLastCompletion('drontal');
    if (lastDrontal) {
      const days = Math.round((now.getTime() - new Date(lastDrontal.timestamp).getTime()) / MS_DAY);
      if (days < 7) {
        return `Drontal was given *${days} day${days === 1 ? '' : 's'} ago* — NexGard should be at least 7 days apart.`;
      }
    }
  }

  return null;
}

async function handleMessage(message, client) {
  const body = message.body || '';

  // Loop protection for messages sent from the bot's own account:
  if (message.fromMe) {
    // 1. Skip status / history / personality output (prefixed with a marker).
    if (BOT_MARKERS.some((m) => body.startsWith(m))) return;
    // 2. Skip our own scheduled reminders (tracked by message id), otherwise a
    //    reminder like "Time to feed Bella 🍖" would self-log a completion.
    const msgId = message.id?._serialized ?? message.id?.id;
    if (msgId && db.findTaskByMessageId(msgId)) return;
  }

  // Resolve the sender's name. getContact() can throw "getAlternateUserWid"
  // for messages sent from the bot's own linked account — don't let that abort
  // the whole command; fall back to a default name (only matters for logging).
  let userName = 'Someone';
  try {
    const contact = await message.getContact();
    userName = contact.pushname || contact.name || contact.number || contact.id?.user || 'Someone';
  } catch (err) {
    if (message.fromMe) {
      userName = client.info?.pushname || 'Me';
    } else {
      // Extract the phone number from the sender's WhatsApp ID (e.g. "6512345678@c.us" → "6512345678")
      const authorId = message.author || message.from;
      if (authorId) userName = authorId.split('@')[0];
    }
    console.warn('[handler] Could not resolve contact:', err.message);
  }

  const chatId = message.id?.remote ?? message.from;

  // ── duplicate confirmation response ────────────────────────────────────────
  //   If there's a pending "are you sure?" for this chat, handle yes/no first.
  const pending = pendingConfirmations.get(chatId);
  if (pending) {
    if (/^\s*y(?:es|ep|eah)?\s*$|^\s*confirm\s*$/i.test(body)) {
      pendingConfirmations.delete(chatId);
      if (Date.now() < pending.expiresAt) {
        db.logCompletion(pending.task.id, pending.triggeredBy, pending.when?.toISOString());
        await message.react('✅');
        notify('✅ Task completed', `${pending.task.label} — by ${pending.triggeredBy} (confirmed)`);
        await deleteTaskReminders(pending.task.id, client);
        if (config.statusAfterCompletion) await sendStatus(message, client);
        console.log(`[handler] Confirmed duplicate "${pending.task.id}" by ${pending.triggeredBy}`);
      }
      return;
    }
    if (/^\s*no\b|^\s*nope\b|^\s*cancel\b/i.test(body)) {
      pendingConfirmations.delete(chatId);
      await message.reply(`⚠️ Got it — *${pending.task.label}* not logged again.`);
      return;
    }
  }

  // ── history request ────────────────────────────────────────────────────────
  const historyTask = matchHistoryRequest(body);
  if (historyTask) {
    const completions = db.getCompletionsLast7Days(historyTask.id);
    const reply = buildHistoryMessage(historyTask, completions);
    await message.reply(reply);
    return;
  }

  // ── change / clear reminder times ──────────────────────────────────────────
  //   "remind feed 8am 6pm"  →  sets feed reminders to 8am and 6pm (persisted)
  //   "remind feed off"      →  removes all feed reminders
  const remindMatch = body.match(/^\s*remind\s+(\w+)\s+(.+)$/i);
  if (remindMatch) {
    const taskId = remindMatch[1];
    const arg = remindMatch[2].trim();

    // "off" / "none" / "clear" / "stop" → remove all reminders for this task
    const clearing = /^(off|none|clear|stop)$/i.test(arg);
    const times = clearing ? [] : arg.split(/[\s,]+/);

    const result = setTaskTimes(taskId, times);
    if (!result.ok) {
      await message.reply(`⏰ ${result.error}`);
      return;
    }
    rescheduleReminders(); // apply live, no restart needed

    if (result.task.reminders.length === 0) {
      await message.reply(`⏰ Removed all reminders for *${result.task.label}*.`);
      console.log(`[handler] Cleared reminders for "${taskId}"`);
    } else {
      const pretty = result.task.reminders.map((r) => cronToTime(r.cron)).join(', ');
      await message.reply(`⏰ Saved! *${result.task.label}* reminders are now: ${pretty}`);
      console.log(`[handler] Reminder times for "${taskId}" set to ${pretty}`);
    }
    return;
  }

  // ── list reminder times ────────────────────────────────────────────────────
  if (/^\s*reminders\s*$/i.test(body)) {
    await message.reply(buildRemindersMessage(cronToTime));
    return;
  }

  // ── list group members (with numbers, for assigning) ───────────────────────
  if (/^\s*members\s*$/i.test(body)) {
    try {
      const chat = await message.getChat();
      if (!chat.isGroup) {
        await message.reply('👥 This only works in the group chat.');
        return;
      }
      const lines = ['👥 *Group members*'];
      for (const p of chat.participants) {
        const id = p.id?._serialized;
        let name = id?.split('@')[0] || '?';
        try {
          const c = await client.getContactById(id);
          name = c.pushname || c.name || c.number || name;
        } catch (_) {}
        lines.push(`• ${name} — \`${id?.split('@')[0]}\``);
      }
      lines.push('');
      lines.push('_Assign with_ `assign <task> <number>` _e.g._ `assign feed_pm 6591234567`');
      await message.reply(lines.join('\n'));
    } catch (err) {
      await message.reply(`👥 Couldn't read the member list: ${err.message}`);
    }
    return;
  }

  // ── assign a person to a task ──────────────────────────────────────────────
  //   "assign feed_pm 6591234567"  or  "assign feed_pm @mention"
  const assignMatch = body.match(/^\s*assign\s+(\w+)\s+(.+)$/i);
  if (assignMatch) {
    const taskId = assignMatch[1];
    if (!getTask(taskId)) {
      await message.reply(`👥 Unknown task "${taskId}". Send \`reminders\` to see task ids.`);
      return;
    }
    // Prefer an @mention if the message carries one, else parse a raw number.
    let wid = null;
    const mentioned = await message.getMentions().catch(() => []);
    if (mentioned && mentioned.length > 0) {
      wid = mentioned[0].id?._serialized;
    } else {
      const digits = assignMatch[2].replace(/\D/g, '');
      if (digits) wid = `${digits}@c.us`;
    }
    if (!wid) {
      await message.reply('👥 Give a phone number or @mention. E.g. `assign feed_pm 6591234567`');
      return;
    }
    let name = wid.split('@')[0];
    try {
      const contact = await client.getContactById(wid);
      name = contact.pushname || contact.name || contact.number || name;
    } catch (_) {}
    const result = setTaskAssignee(taskId, { id: wid, name });
    if (!result.ok) {
      await message.reply(`👥 ${result.error}`);
      return;
    }
    await message.reply(`👥 *${result.task.label}* is now assigned to *${name}* — they'll be @mentioned on its reminders.`);
    console.log(`[handler] Assigned "${taskId}" → ${name} (${wid})`);
    return;
  }

  // ── unassign a task ────────────────────────────────────────────────────────
  const unassignMatch = body.match(/^\s*unassign\s+(\w+)\s*$/i);
  if (unassignMatch) {
    const result = clearTaskAssignee(unassignMatch[1]);
    if (!result.ok) {
      await message.reply(`👥 ${result.error}`);
      return;
    }
    await message.reply(`👥 *${result.task.label}* is no longer assigned to anyone.`);
    console.log(`[handler] Unassigned "${unassignMatch[1]}"`);
    return;
  }

  // ── list current assignments ───────────────────────────────────────────────
  if (/^\s*assignments\s*$/i.test(body)) {
    const assigned = config.tasks.filter((t) => t.assignee?.name);
    if (assigned.length === 0) {
      await message.reply('👥 No tasks are assigned yet. Use `members` then `assign <task> <number>`.');
      return;
    }
    const lines = ['👥 *Task assignments*'];
    for (const t of assigned) lines.push(`• ${t.label} → *${t.assignee.name}*`);
    await message.reply(lines.join('\n'));
    return;
  }

  // ── add a new task ─────────────────────────────────────────────────────────
  //   addtask meds | Meds given | medicine, meds, pill | 8am 8pm | mon,wed
  const addMatch = body.match(/^\s*addtask\s+(.+)$/i);
  if (addMatch) {
    const parts = addMatch[1].split('|').map((s) => s.trim());
    if (parts.length < 2) {
      await message.reply(
        '🆕 Usage: `addtask <id> | <label> | <keywords> | <times> | <days>`\n' +
        'Example: `addtask ears | Ears cleaned | ears, ear clean | 7pm | wed,sun`\n' +
        '_(times and days are optional; days = weekdays like mon,wed or dates like 29)_'
      );
      return;
    }
    const [id, label, kwRaw = '', timesRaw = '', daysRaw = ''] = parts;
    const keywords = kwRaw.split(',').map((s) => s.trim()).filter(Boolean);
    const timeStrings = timesRaw.split(/[\s,]+/).map((s) => s.trim()).filter(Boolean);
    const dayTokens = daysRaw.split(/[\s,]+/).map((s) => s.trim()).filter(Boolean);

    const result = addTask({ id, label, keywords, timeStrings });
    if (!result.ok) {
      await message.reply(`🆕 ${result.error}`);
      return;
    }
    // Optional day schedule.
    if (dayTokens.length) {
      const sched = setTaskSchedule(id, dayTokens);
      if (!sched.ok) {
        await message.reply(`🆕 Task added, but schedule error: ${sched.error}`);
        rescheduleReminders();
        return;
      }
    }
    rescheduleReminders();
    const t = result.task;
    const times = t.reminders.length ? t.reminders.map((r) => cronToTime(r.cron)).join(', ') : 'none';
    await message.reply(
      `🆕 Added *${t.label}* (id: ${t.id})\n` +
      `Keywords: ${t.keywords.join(', ')}\n` +
      `Reminders: ${times}\n` +
      `Days: ${describeSchedule(t)}`
    );
    console.log(`[handler] Added task "${t.id}"`);
    return;
  }

  // ── set a task's day schedule ──────────────────────────────────────────────
  //   "schedule ears wed,sun"  /  "schedule nexgard 29"  /  "schedule ears daily"
  const schedMatch = body.match(/^\s*schedule\s+(\w+)\s+(.+)$/i);
  if (schedMatch) {
    const taskId = schedMatch[1];
    const tokens = schedMatch[2].trim().split(/[\s,]+/).filter(Boolean);
    const result = setTaskSchedule(taskId, tokens);
    if (!result.ok) {
      await message.reply(`🗓️ ${result.error}`);
      return;
    }
    rescheduleReminders();
    await message.reply(`🗓️ *${result.task.label}* now runs: ${describeSchedule(result.task)}`);
    console.log(`[handler] Schedule for "${taskId}" set to ${describeSchedule(result.task)}`);
    return;
  }

  // ── remove a task ──────────────────────────────────────────────────────────
  const delMatch = body.match(/^\s*(?:removetask|deltask)\s+(\w+)\s*$/i);
  if (delMatch) {
    const result = removeTask(delMatch[1]);
    if (!result.ok) {
      await message.reply(`🗑️ ${result.error}`);
      return;
    }
    rescheduleReminders();
    await message.reply(`🗑️ Removed task *${result.task.label}* (${result.task.id}).`);
    console.log(`[handler] Removed task "${result.task.id}"`);
    return;
  }

  // ── reset completions ──────────────────────────────────────────────────────
  //   "reset"            → clears today's completions (back to all ❌)
  //   "reset all confirm"→ wipes the entire history
  const resetMatch = body.match(/^\s*reset(\s+all)?(\s+confirm)?\s*$/i);
  if (resetMatch) {
    const isAll = !!resetMatch[1];
    if (isAll && !resetMatch[2]) {
      await message.reply(
        '♻️ This wipes *all* recorded history. If you\'re sure, send: `reset all confirm`'
      );
      return;
    }
    const removed = isAll ? db.resetAll() : db.resetToday();
    const scope = isAll ? 'all history' : "today's tasks";
    await message.reply(`♻️ Reset ${scope} (${removed} entr${removed === 1 ? 'y' : 'ies'} cleared).\n\n${buildCurrentStatus()}`);
    console.log(`[handler] Reset ${scope} — ${removed} rows`);
    return;
  }

  // ── undo last completion for a task ───────────────────────────────────────
  //   "undo poop" / "undo shat" / "undo feed" etc.
  const undoMatch = body.match(/^\s*undo\s+(\S+)\s*$/i);
  if (undoMatch) {
    const keyword = undoMatch[1];
    const task = getTask(keyword) || matchTask(keyword);
    if (!task) {
      await message.reply(`♻️ Couldn't find a task matching "${keyword}".`);
      return;
    }
    const removed = db.undoLastCompletion(task.id);
    if (!removed) {
      await message.reply(`♻️ No completions recorded for *${task.label}*.`);
    } else {
      await message.reply(
        `♻️ Removed the last *${task.label}* entry (logged at ${fmtTime(removed.timestamp)}).\n\n${buildCurrentStatus()}`
      );
    }
    return;
  }

  // ── toggle auto-status after each completion ───────────────────────────────
  //   "autostatus on" / "autostatus off"
  const autoMatch = body.match(/^\s*autostatus\s+(on|off)\s*$/i);
  if (autoMatch) {
    config.statusAfterCompletion = autoMatch[1].toLowerCase() === 'on';
    save();
    await message.reply(
      `⚙️ Auto-status after each task is now *${config.statusAfterCompletion ? 'ON' : 'OFF'}*.`
    );
    console.log(`[handler] statusAfterCompletion → ${config.statusAfterCompletion}`);
    return;
  }

  // ── set daily summary time ─────────────────────────────────────────────────
  //   "summary 9pm" / "summary 21:00" / "summary off"
  const summaryMatch = body.match(/^\s*summary\s+(.+)$/i);
  if (summaryMatch) {
    const arg = summaryMatch[1].trim();
    if (/^(off|none|stop)$/i.test(arg)) {
      delete config.dailySummaryCron;
      save();
      rescheduleReminders();
      await message.reply('📊 Daily summary turned *off*.');
      return;
    }
    const cronExpr = parseTimeToCron(arg);
    if (!cronExpr) {
      await message.reply('📊 Couldn\'t understand that time. Try `summary 9pm` or `summary 21:00`.');
      return;
    }
    config.dailySummaryCron = cronExpr;
    save();
    rescheduleReminders();
    await message.reply(`📊 Daily summary will be sent at *${cronToTime(cronExpr)}* every day.`);
    console.log(`[handler] dailySummaryCron → ${cronExpr}`);
    return;
  }

  // ── set weekly responsibility auto-summary time ────────────────────────────
  //   "weeklycron 9pm"  → auto-posts every Sunday at 9pm
  //   "weeklycron off"  → disables auto-post
  const weeklyCronMatch = body.match(/^\s*weeklycron\s+(.+)$/i);
  if (weeklyCronMatch) {
    const arg = weeklyCronMatch[1].trim();
    if (/^(off|none|stop)$/i.test(arg)) {
      delete config.weeklyResponsibilityCron;
      save();
      rescheduleReminders();
      await message.reply('📊 Weekly responsibility auto-summary turned *off*.');
      return;
    }
    const cronExpr = parseTimeToCron(arg);
    if (!cronExpr) {
      await message.reply('📊 Couldn\'t understand that time. Try `weeklycron 9pm` (posts every Sunday evening).');
      return;
    }
    // Restrict to Sundays only (field 5: day of week 0 = Sunday)
    config.weeklyResponsibilityCron = cronExpr.replace(/\* \* \*$/, '* * 0');
    save();
    rescheduleReminders();
    await message.reply(`📊 Weekly responsibility summary will be sent every *Sunday at ${cronToTime(cronExpr)}*.`);
    console.log(`[handler] weeklyResponsibilityCron → ${config.weeklyResponsibilityCron}`);
    return;
  }

  // ── weekly responsibility breakdown ────────────────────────────────────────
  //   "responsibility" / "responsible" / "weekly" / "who did"
  if (isResponsibilityRequest(body)) {
    const { start, end } = currentWeekRange();
    const rows = db.getWeeklyCompletionsByUser(start, end);
    await message.reply(buildWeeklyResponsibility(rows, start, end));
    return;
  }

  // ── status request ─────────────────────────────────────────────────────────
  //   "status"            → today's live status
  //   "status yesterday"  → previous day's summary
  //   "status 28 jun"     → specific date summary
  if (isStatusRequest(body)) {
    const dateArg = body.replace(/status/i, '').trim();
    if (dateArg) {
      const dateStr = parseDateArg(dateArg);
      if (dateStr) {
        const { start, end } = dayBoundsUTC(dateStr);
        await message.reply(buildHistoricalStatus(dateStr, start, end));
        return;
      }
    }
    await sendStatus(message, client);
    return;
  }

  // ── task completion keyword ────────────────────────────────────────────────
  // A date token ("yesterday", "16 jul") backdates the log; an explicit time
  // ("shat 8:30am") sets the routing window and logged time. Both are optional.
  const { dateStr, cleaned } = extractDateFromText(body);
  const timeWhen = extractTimeFromText(cleaned);
  let when;
  if (dateStr) {
    when = localDateTimeToUTC(dateStr, timeWhen ? timeWhen.getHours() : 12, timeWhen ? timeWhen.getMinutes() : 0);
  } else {
    when = timeWhen; // may be null → now
  }
  let task = matchTask(cleaned, when || new Date());

  // If a windowed poop slot is already logged that day, overflow to poop_extra.
  if (task && (task.id === 'poop_am' || task.id === 'poop_pm')) {
    let dayDone;
    if (dateStr) {
      const { start, end } = dayBoundsUTC(dateStr);
      dayDone = db.getCompletionsBetween(task.id, start, end);
    } else {
      dayDone = db.getCompletionsToday(task.id);
    }
    if (dayDone.length > 0) {
      const extra = config.tasks.find((t) => t.id === 'poop_extra');
      if (extra) task = extra;
    }
  }

  if (task) {
    // Medication spacing rules (drontal / nexgard).
    const medWarning = checkMedConflict(task.id, when || new Date());
    if (medWarning) {
      pendingConfirmations.set(chatId, {
        task,
        triggeredBy: userName,
        when: when || null,
        expiresAt: Date.now() + 5 * 60 * 1000,
      });
      await message.reply(`⚠️ ${medWarning}\n\nReply *yes* to log anyway, or ignore to cancel.`);
      return;
    }

    // For tasks that don't allow multiple completions, check for a recent duplicate.
    // Skipped when backdating — "recent" is measured from now, not the past date.
    if (!task.multiple && !dateStr) {
      const recent = db.getLastCompletionWithinMinutes(task.id, 30);
      if (recent) {
        const minsAgo = Math.max(1, Math.round((Date.now() - new Date(recent.timestamp).getTime()) / 60000));
        pendingConfirmations.set(chatId, {
          task,
          triggeredBy: userName,
          when: when || null,
          expiresAt: Date.now() + 5 * 60 * 1000,
        });
        await message.reply(
          `⚠️ *${task.label}* was already logged ${minsAgo} min ago by ${recent.user_name}.\n\nReply *yes* to log again, or ignore to cancel.`
        );
        return;
      }
    }

    db.logCompletion(task.id, userName, when ? when.toISOString() : undefined);
    await message.react('✅');

    // Backdated log — confirm with that day's updated status; don't touch today's
    // reminders or status, and skip the med auto-defer (only relevant live).
    if (dateStr) {
      const pretty = new Date(when).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: config.timezone });
      notify('✅ Task backdated', `${task.label} — ${pretty} by ${userName}`);
      const { start, end } = dayBoundsUTC(dateStr);
      await message.reply(`📋 Logged *${task.label}* for *${pretty}*.\n\n${buildHistoricalStatus(dateStr, start, end)}`);
      console.log(`[handler] ${userName} backdated "${task.id}" to ${dateStr}`);
      return;
    }

    notify('✅ Task completed', `${task.label} — by ${userName}${when ? ' at ' + fmtTime(when.toISOString()) : ''}`);
    await deleteTaskReminders(task.id, client);
    if (config.statusAfterCompletion) await sendStatus(message, client);
    console.log(`[handler] ${userName} completed "${task.id}"${when ? ' at ' + when.toLocaleTimeString() : ''}`);

    // After logging NexGard, auto-defer Drontal if the next due date falls
    // within 7 days of this NexGard dose.
    if (task.id === 'nexgard') {
      const drontalTask = getTask('drontal');
      if (drontalTask) {
        const now = when || new Date();
        const safeDate = new Date(now.getTime() + 7 * MS_DAY);
        const due = nextDueDate(drontalTask);
        if (due && safeDate > due) {
          const delayDays = Math.ceil((safeDate.getTime() - due.getTime()) / MS_DAY);
          const safeDateStr = safeDate.toLocaleDateString('en-CA', { timeZone: config.timezone }); // YYYY-MM-DD
          const displayStr = safeDate.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: config.timezone });
          drontalTask.schedule.deferredUntil = safeDateStr;
          drontalTask.schedule.deferralInfo = `delayed ${delayDays}d — NexGard`;
          save();
          await message.reply(
            `⚠️ Drontal deferred by *${delayDays} day${delayDays === 1 ? '' : 's'}* to *${displayStr}* to keep 7 days clear of NexGard.`
          );
        }
      }
    }

    // Clear any deferral once Drontal is actually given.
    if (task.id === 'drontal') {
      clearTaskDeferral('drontal');
    }
  }
}

/**
 * Handles a message reaction (e.g. 👍 on a bot reminder).
 */
async function handleReaction(reaction, client) {
  // Only care about thumbs-up reactions
  if (reaction.reaction !== '👍') return;

  const msgId = reaction.msgId?._serialized ?? reaction.msgId?._serialised ?? reaction.msgId?.id;
  if (!msgId) return;

  const record = db.findTaskByMessageId(msgId);
  if (!record) return; // reaction is not on a bot reminder

  const task = config.tasks.find((t) => t.id === record.task);
  if (!task) return;

  // Resolve the reactor's name. getContactById throws "getAlternateUserWid"
  // when the reaction comes from the bot's own linked account — same issue as
  // in handleMessage — so fall back to the bot's name (or the raw number).
  let userName = 'Someone';
  try {
    const contact = await client.getContactById(reaction.senderId);
    userName = contact.pushname || contact.name || contact.number || 'Someone';
  } catch (err) {
    const selfId = client.info?.wid?._serialized;
    if (selfId && reaction.senderId === selfId) {
      userName = client.info?.pushname || 'Me';
    } else if (reaction.senderId) {
      userName = String(reaction.senderId).split('@')[0];
    }
    console.warn('[handler] Could not resolve reactor contact:', err.message);
  }

  db.logCompletion(task.id, userName);
  notify('✅ Task completed', `${task.label} — by ${userName} (👍 reaction)`);
  console.log(`[handler] ${userName} completed "${task.id}" via reaction`);

  // Confirm with a ✅ react on the reminder, delete it, then post the updated status.
  try {
    const msg = await client.getMessageById(msgId);
    if (msg) {
      await msg.react('✅');
      await deleteTaskReminders(task.id, client);
      if (config.statusAfterCompletion) await sendStatus(msg, client);
    }
  } catch (_) {}
}

module.exports = { handleMessage, handleReaction };

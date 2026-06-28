const {
  config, save, cronToTime, setTaskTimes, setTaskSchedule, addTask, removeTask,
  extractTimeFromText, describeSchedule, parseTimeToCron, getTask,
} = require('./configStore');
const db = require('./db');
const { matchTask, isStatusRequest, matchHistoryRequest } = require('./matcher');
const { buildHistoryMessage, buildRemindersMessage, fmtTime } = require('./formatter');
const { rescheduleReminders } = require('./reminders');
const { buildCurrentStatus, sendStatus } = require('./status');

/**
 * Handles an incoming text message.
 */
// Markers that identify the bot's own output, so we never react to ourselves
// and trigger an infinite loop (e.g. the status summary contains "Walked",
// which would otherwise re-match the walk keyword).
const BOT_MARKERS = ['🐾', '📋', '⏰', '🆕', '🗑️', '♻️', '🔔', '🗓️', '⚙️', '📊'];

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

  // ── status request ─────────────────────────────────────────────────────────
  if (isStatusRequest(body)) {
    await sendStatus(message, client);
    return;
  }

  // ── task completion keyword ────────────────────────────────────────────────
  // An explicit time in the message ("shat 8:30am", "fed her 7pm") sets both
  // the routing window and the logged timestamp; otherwise we use now.
  const when = extractTimeFromText(body);
  const task = matchTask(body, when || new Date());
  if (task) {
    db.logCompletion(task.id, userName, when ? when.toISOString() : undefined);
    await message.react('✅');
    if (config.statusAfterCompletion) await sendStatus(message, client);
    console.log(`[handler] ${userName} completed "${task.id}"${when ? ' at ' + when.toLocaleTimeString() : ''}`);
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

  // Resolve the reactor's name
  let userName = 'Someone';
  try {
    const contact = await client.getContactById(reaction.senderId);
    userName = contact.pushname || contact.name || contact.number || 'Someone';
  } catch (_) {}

  db.logCompletion(task.id, userName);
  console.log(`[handler] ${userName} completed "${task.id}" via reaction`);

  // Confirm with a ✅ react on the reminder, then post the updated status.
  try {
    const msg = await client.getMessageById(msgId);
    if (msg) {
      await msg.react('✅');
      if (config.statusAfterCompletion) await sendStatus(msg, client);
    }
  } catch (_) {}
}

module.exports = { handleMessage, handleReaction };

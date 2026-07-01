const cron = require('node-cron');
const { config, isActiveToday, currentWeekRange } = require('./configStore');
const db = require('./db');
const { buildCurrentStatus, buildEODStatus } = require('./status');
const { buildWeeklyResponsibility } = require('./formatter');

function buildDisclaimer(task) {
  const example = task.keywords[0] || task.id;
  return `_React 👍 when done, or just say it (e.g. "${example}" or "${example} 9am" — time is optional). Ignore this if it's already taken care of._`;
}

let scheduledJobs = [];
let clientRef = null;
let getGroupChatIdRef = null;

function clearJobs() {
  for (const job of scheduledJobs) job.stop();
  scheduledJobs = [];
}

/**
 * Schedules all reminder cron jobs from the current config.
 * @param {import('whatsapp-web.js').Client} client
 * @param {() => string|null} getGroupChatId  resolves lazily after client is ready
 */
function scheduleReminders(client, getGroupChatId) {
  clientRef = client;
  getGroupChatIdRef = getGroupChatId;
  clearJobs();

  for (const task of config.tasks) {
    for (const reminder of task.reminders) {
      const job = cron.schedule(
        reminder.cron,
        async () => {
          const chatId = getGroupChatId();
          if (!chatId) {
            console.warn(`[reminders] Group not found yet, skipping reminder for ${task.id}`);
            return;
          }
          // Skip if the task isn't scheduled for today (e.g. ears on Wed/Sun only).
          if (!isActiveToday(task)) {
            console.log(`[reminders] ${task.id} not scheduled today, skipping reminder`);
            return;
          }
          // Skip if the task is already done today — no need to nag.
          const doneToday = db.getCompletionsToday(task.id);
          if (doneToday.length > 0) {
            console.log(`[reminders] ${task.id} already done today, skipping reminder`);
            return;
          }
          try {
            const chat = await client.getChatById(chatId);
            // Prefix with 🔔 so the bot recognises (and ignores) its own
            // reminders — the disclaimer text contains "fed her" as an example,
            // which would otherwise be read as a feed completion.
            const text = `🔔 ${reminder.message}\n\n${buildDisclaimer(task)}`;
            const sent = await chat.sendMessage(text);
            db.saveReminderMessage(task.id, sent.id._serialized ?? sent.id.id, chatId);
            console.log(`[reminders] Sent reminder for ${task.id}`);
          } catch (err) {
            console.error(`[reminders] Failed to send reminder for ${task.id}:`, err.message);
          }
        },
        { timezone: config.timezone }
      );
      scheduledJobs.push(job);
      console.log(`[reminders] Scheduled "${task.id}" → ${reminder.cron} (${config.timezone})`);
    }
  }

  // Daily end-of-day status summary (e.g. 9pm — everything should be done by now).
  if (config.dailySummaryCron) {
    const summaryJob = cron.schedule(
      config.dailySummaryCron,
      async () => {
        const chatId = getGroupChatId();
        if (!chatId) {
          console.warn('[reminders] Group not found yet, skipping daily summary');
          return;
        }
        try {
          const chat = await client.getChatById(chatId);
          const text = `📊 *End-of-day check* — everything should be done by now:\n\n${buildEODStatus()}`;
          await chat.sendMessage(text);
          console.log('[reminders] Sent daily summary');
        } catch (err) {
          console.error('[reminders] Failed to send daily summary:', err.message);
        }
      },
      { timezone: config.timezone }
    );
    scheduledJobs.push(summaryJob);
    console.log(`[reminders] Scheduled daily summary → ${config.dailySummaryCron} (${config.timezone})`);
  }

  // Weekly responsibility breakdown — posts every Sunday at the configured time.
  if (config.weeklyResponsibilityCron) {
    const weeklyJob = cron.schedule(
      config.weeklyResponsibilityCron,
      async () => {
        const chatId = getGroupChatId();
        if (!chatId) {
          console.warn('[reminders] Group not found yet, skipping weekly summary');
          return;
        }
        try {
          const { start, end } = currentWeekRange();
          const rows = db.getWeeklyCompletionsByUser(start, end);
          const chat = await client.getChatById(chatId);
          await chat.sendMessage(buildWeeklyResponsibility(rows, start, end));
          console.log('[reminders] Sent weekly responsibility summary');
        } catch (err) {
          console.error('[reminders] Failed to send weekly summary:', err.message);
        }
      },
      { timezone: config.timezone }
    );
    scheduledJobs.push(weeklyJob);
    console.log(`[reminders] Scheduled weekly responsibility summary → ${config.weeklyResponsibilityCron} (${config.timezone})`);
  }
}

/** Tears down all jobs and re-reads the (now updated) config. Call after editing reminders. */
function rescheduleReminders() {
  if (!clientRef || !getGroupChatIdRef) return;
  console.log('[reminders] Rescheduling after config change…');
  scheduleReminders(clientRef, getGroupChatIdRef);
}

module.exports = { scheduleReminders, rescheduleReminders };

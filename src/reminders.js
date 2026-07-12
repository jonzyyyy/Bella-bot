const cron = require('node-cron');
const { config, isActiveToday, currentWeekRange } = require('./configStore');
const db = require('./db');
const { buildCurrentStatus, buildEODStatus } = require('./status');
const { buildWeeklyResponsibility } = require('./formatter');
const { notify } = require('./notify');

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

            // Drontal spacing check: if NexGard was given within the last 7 days,
            // replace the normal reminder with a warning not to give the pill yet.
            if (task.id === 'drontal') {
              const lastNexgard = db.getLastCompletion('nexgard');
              if (lastNexgard) {
                const daysSince = Math.round((Date.now() - new Date(lastNexgard.timestamp).getTime()) / 86400000);
                if (daysSince < 7) {
                  const safeDate = new Date(new Date(lastNexgard.timestamp).getTime() + 7 * 86400000);
                  const safeDateStr = safeDate.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: config.timezone });
                  await chat.sendMessage(
                    `⚠️ *Drontal is due today* but NexGard was given ${daysSince} day${daysSince === 1 ? '' : 's'} ago.\n\n_Do NOT give Drontal yet — wait until at least *${safeDateStr}* (7 days after NexGard)._`
                  );
                  notify('⚠️ Drontal warning', `Drontal is due today but NexGard was given ${daysSince} day${daysSince === 1 ? '' : 's'} ago. Wait until at least ${safeDateStr}.`);
                  console.log(`[reminders] Sent drontal spacing warning (nexgard ${daysSince}d ago)`);
                  return;
                }
              }
            }

            // Prefix with 🔔 so the bot recognises (and ignores) its own
            // reminders — the disclaimer text contains "fed her" as an example,
            // which would otherwise be read as a feed completion.
            // If the task has an assignee, @mention them so their phone pings.
            let body = `🔔 ${reminder.message}`;
            const sendOpts = {};
            if (task.assignee?.id) {
              const num = task.assignee.id.split('@')[0];
              body += `\n\n@${num}, you're on this one 🙌`;
              sendOpts.mentions = [task.assignee.id];
            }
            const text = `${body}\n\n${buildDisclaimer(task)}`;
            const sent = await chat.sendMessage(text, sendOpts);
            db.saveReminderMessage(task.id, sent.id._serialized ?? sent.id.id, chatId);
            notify(
              `🔔 ${config.petName} reminder`,
              task.assignee?.name ? `${reminder.message} (${task.assignee.name}'s turn)` : reminder.message
            );
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
          notify('📊 End-of-day check', buildEODStatus());
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

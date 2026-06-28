# Bella Bot 🐾

A self-hosted WhatsApp bot for tracking Bella's daily care tasks (feeding, walks, water). Runs on any cheap VPS using [whatsapp-web.js](https://wwebjs.dev/), SQLite, and pm2.

> **Group-only:** the bot only listens and responds inside the configured WhatsApp group. Messages in private chats are ignored entirely.

---

# 📖 How to use it (for the family)

Everything is typed naturally in the WhatsApp group — no special prefixes or syntax.

## 1. Logging that a task is done

Just say it. The bot reacts ✅ and posts the updated status.

| Type | Logs |
|---|---|
| `fed her` / `just fed` / `breakfast` | Breakfast (morning) or Dinner (evening) — auto by time |
| `fed her dinner` | Dinner (explicit word wins) |
| `walked` / `took her out` | Morning or Evening walk — auto by time |
| `water` / `refilled water` | Water refilled |
| `shat` / `pooped` | Pooped |
| `ear medicine` / `ear meds` / `meds` | Ear Medicine |
| `ears` / `cleaned ears` | Ears cleaned (Wed & Sun only) |
| `brush teeth` / `brushed` / `teeth` | Teeth brushed (Mondays only) |
| `nexgard` / `spectra` | NexGard Spectra (monthly) |
| `drontal` / `deworm` | Drontal (every 3 months) |

**With a specific time** (if you forgot to log earlier):

```
shat 8:30am
fed her 7am
walked 6:30pm
```

**Or react 👍** to any reminder the bot sends → logs that task as done by you.

## 2. Checking what's been done

```
status
```

Shows today's tasks with ✅/❌ and who did each. Only shows tasks scheduled for today. When you request a new status, the previous status message is **automatically deleted** from the chat to keep things tidy — the end-of-day summary is the only one that stays permanently.

```
history feed
history poop
```

Last 7 days for that task.

## 3. Managing reminders

| Type | Does |
|---|---|
| `reminders` | List all reminder times + which days |
| `remind feed_am 7am` | Change a task's reminder time(s) |
| `remind feed_pm 6pm 9pm` | Multiple times |
| `remind water off` | Remove all reminders for a task |

## 4. Managing tasks

| Type | Does |
|---|---|
| `addtask treats \| Treats given \| treat, snack \| 3pm` | Add a new task |
| `addtask ears \| Ears cleaned \| ears, ear clean \| 7pm \| wed,sun` | Add a task that only runs on certain days |
| `removetask treats` / `deltask treats` | Delete a task |

The `addtask` format is `id | label | keywords | times | days` — only `id` and `label` are required.

## 5. Scheduling tasks to specific days

Some tasks shouldn't be daily (e.g. ear-cleaning on Wed & Sun, teeth on Mondays). A scheduled task **only appears in `status` and only sends reminders on its days**.

| Type | Does |
|---|---|
| `schedule ears wed,sun` | Run only on Wednesdays & Sundays |
| `schedule teeth mon` | Run only on Mondays |
| `schedule nexgard 29` | Run only on the 29th of each month |
| `schedule vet 1,15` | Run on the 1st and 15th |
| `schedule drontal every 3 months` | Recurs every 3 months (interval) |
| `schedule heartworm every 30 days` | Recurs every 30 days |
| `schedule ears daily` | Back to every day (clears the schedule) |

- **Weekdays:** `mon tue wed thu fri sat sun`
- **Dates:** any number `1`–`31`
- **Intervals:** `every <n> months` or `every <n> days`
- Times are still set separately with `remind` (e.g. `remind ears 7pm`).

**Interval tasks are self-advancing.** Once due, they stay in `status` (and remind daily) until someone logs them — then the next due date jumps forward automatically (e.g. log Drontal on Jul 6 → next becomes Oct 6). When set from chat, the interval is anchored to today; to anchor it to a past date, set it in config.json (see below).

## 6. Bot settings

| Type | Does |
|---|---|
| `autostatus on` | Post the full task list after **every** completion |
| `autostatus off` | Only react ✅ after a completion (default) |
| `summary 9pm` | Set the daily end-of-day summary time |
| `summary 21:30` | 24-hour format also works |
| `summary off` | Disable the daily summary |

A daily summary is posted to the group at **9:00pm** by default (everything should be done by then). Unlike regular status messages, the daily summary is never auto-deleted.

## 7. Fixing mistakes

| Type | Does |
|---|---|
| `undo poop` | Remove the most recent completion for a task |
| `undo shat` | Same — any matching keyword works |
| `reset` | Clear **all** of today's completions → all back to ❌ |
| `reset all confirm` | Wipe all history across all days (irreversible) |

`undo` removes the single most recent entry for that task (regardless of day) and shows the updated status. Useful if someone accidentally logs the wrong thing.

---

## 📋 Full command reference

Everything the bot understands, in one place:

| Command | What it does |
|---|---|
| _any keyword_ (e.g. `walked`, `fed her`, `shat`) | Log a task as done → ✅ |
| _keyword + time_ (e.g. `fed her 7am`, `shat 8:30pm`) | Log it at a specific time |
| 👍 _react on a reminder_ | Log that task as done by you |
| `status` | Today's task list with ✅ / ❌ (replaces previous status message) |
| `history <task>` (e.g. `history feed`) | Last 7 days for a task |
| `reminders` | List all reminder times + schedules |
| `remind <task> <times>` (e.g. `remind feed_am 8am`) | Set a task's reminder time(s) |
| `remind <task> off` | Remove a task's reminders |
| `addtask <id> \| <label> \| <keywords> \| <times> \| <days>` | Add a new task (only id & label required) |
| `removetask <task>` / `deltask <task>` | Delete a task |
| `schedule <task> <days>` (e.g. `schedule ears wed,sun`) | Restrict to weekdays/dates |
| `schedule <task> every <n> months\|days` | Interval recurrence |
| `schedule <task> daily` | Clear the schedule (back to daily) |
| `undo <task>` (e.g. `undo poop`) | Remove the most recent completion for a task |
| `autostatus on` / `autostatus off` | Toggle status after every completion |
| `summary <time>` / `summary off` | Set or disable the daily 9pm summary |
| `reset` | Clear today's completions |
| `reset all confirm` | Wipe all history |

### Two things to remember

- **Reminders fire at their set times only** — and since the bot runs on a personal number, *that* phone won't get a notification for them (they appear in the chat; other members get notified).
- **Day-restricted tasks** (ears, teeth, nexgard, drontal) only appear in `status` and only remind on their scheduled days.

---

# 🛠️ Technical setup

## Folder structure

```
bella-bot/
├── src/
│   ├── index.js       # Entry point, WhatsApp client setup
│   ├── handlers.js    # Message & reaction logic
│   ├── reminders.js   # Cron-based reminder scheduling
│   ├── configStore.js # Config read/write, time parsing, task CRUD
│   ├── matcher.js     # Loose keyword matching
│   ├── formatter.js   # Status / history message formatting
│   ├── status.js      # Status builder + send-and-replace helper
│   └── db.js          # SQLite access layer
├── data/              # Created at runtime — holds bella.db
├── logs/              # Created by pm2 — err.log, out.log
├── .wwebjs_auth/      # Created at runtime — saved WhatsApp session
├── config.json        # Tasks, reminder times, group name
├── ecosystem.config.js
├── package.json
└── .env               # Copy from .env.example (optional overrides)
```

---

## 1. Install dependencies

You need **Node.js 18+** and **npm**.

```bash
# On a fresh Hetzner (Ubuntu) VPS:
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs

# Chromium dependencies required by whatsapp-web.js
sudo apt-get install -y \
  gconf-service libgbm-dev libasound2 libatk1.0-0 libc6 \
  libcairo2 libcups2 libdbus-1-3 libexpat1 libfontconfig1 \
  libgcc1 libgconf-2-4 libgdk-pixbuf2.0-0 libglib2.0-0 \
  libgtk-3-0 libnspr4 libpango-1.0-0 libpangocairo-1.0-0 \
  libstdc++6 libx11-6 libx11-xcb1 libxcb1 libxcomposite1 \
  libxcursor1 libxdamage1 libxext6 libxfixes3 libxi6 \
  libxrandr2 libxrender1 libxss1 libxtst6 ca-certificates \
  fonts-liberation libappindicator1 libnss3 lsb-release \
  xdg-utils wget

# Clone / copy the project, then:
cd bella-bot
npm install
```

---

## 2. Configure the bot

Edit **`config.json`** to match your setup:

| Field | Description |
|---|---|
| `petName` | Used in reminder messages and status headers |
| `groupName` | Exact name of the WhatsApp group the bot should listen in |
| `timezone` | IANA timezone, e.g. `"Asia/Singapore"`, `"Europe/London"` |
| `statusAfterCompletion` | `true`/`false` — post the full task list after every completion (chat: `autostatus on/off`) |
| `dailySummaryCron` | Cron time for the daily end-of-day summary, e.g. `"0 21 * * *"` (chat: `summary 9pm`). Remove to disable |
| `tasks[].id` | Internal key, used for history lookup and DB storage |
| `tasks[].label` | Human-readable name shown in status / history |
| `tasks[].emoji` | _(optional)_ emoji shown with the task |
| `tasks[].keywords` | Any of these phrases in a message triggers a completion log |
| `tasks[].reminders[].cron` | Standard 5-field cron expression |
| `tasks[].reminders[].message` | Message the bot sends to the group |
| `tasks[].window` | _(optional)_ time range for routing shared keywords, e.g. morning vs evening feed |
| `tasks[].schedule` | _(optional)_ restrict the task to certain days or an interval (see below) |
| `tasks[].multiple` | _(optional)_ `true` if the task can happen several times a day — `status` then lists every occurrence (e.g. poop) |

> Most of these can also be edited from chat — see [Managing tasks](#4-managing-tasks) and [Scheduling tasks](#5-scheduling-tasks-to-specific-days) in the usage guide. Chat edits are written straight back to this file.

### Adding a task

```json
{
  "id": "teeth",
  "label": "Teeth brushed",
  "emoji": "🦷",
  "keywords": ["brush teeth", "brushed teeth", "teeth", "brushed"],
  "schedule": { "daysOfWeek": [1] },
  "reminders": [
    { "cron": "30 8 * * *", "message": "Time to brush Bella's teeth 🦷" },
    { "cron": "30 20 * * *", "message": "Don't forget to brush Bella's teeth tonight 🦷" }
  ]
}
```

### Tasks that happen multiple times a day (`multiple`)

By default `status` shows the most recent time a task was done. For tasks that can occur several times a day (e.g. pooping), add `"multiple": true` and `status` will list **every** occurrence with a count:

```json
{
  "id": "poop",
  "label": "Pooped",
  "emoji": "💩",
  "multiple": true,
  "keywords": ["shat", "pooped", "poop", "did her business"],
  "reminders": []
}
```

```
6️⃣ Pooped ✅ ×3 (7:12am by Aunty, 2:30pm by Jon, 8:20pm by Kiara)
```

### Restricting a task to certain days (`schedule`)

A task with a `schedule` only appears in `status` and only sends reminders on the matching days. Omit `schedule` for a daily task.

```json
"schedule": { "daysOfWeek": [0, 3] }      // Sun=0 … Sat=6  → Wednesdays & Sundays
"schedule": { "daysOfWeek": [1] }         // Mondays only
"schedule": { "daysOfMonth": [29] }       // the 29th of every month
"schedule": { "daysOfWeek": [1], "daysOfMonth": [15] }  // both conditions

// Interval recurrence — every N months/days from an anchor date.
// `anchor` is the last time it was done; the next due date is anchor + interval,
// and it advances automatically each time the task is logged.
"schedule": { "everyMonths": 3, "anchor": "2026-04-06" }   // → next due 2026-07-06
"schedule": { "everyDays": 30, "anchor": "2026-06-01" }
```

Days are evaluated in the configured `timezone`. The equivalent chat command is `schedule <task> <days>`, e.g. `schedule ears wed,sun` or `schedule drontal every 3 months`. Setting an interval from chat anchors it to today — use config.json (with `anchor`) to anchor it to a past date.

### Changing reminder times

Cron format: `minute hour day month weekday`

| Cron | Meaning |
|---|---|
| `0 8 * * *` | 8:00 am every day |
| `30 8 * * *` | 8:30 am every day |
| `30 17 * * *` | 5:30 pm every day |
| `0 8 * * 1-5` | 8:00 am weekdays only |

---

## 3. First run — scan the QR code

The first time you start the bot it will print a QR code. Scan it with WhatsApp on your phone:

**WhatsApp → Linked Devices → Link a Device**

```bash
node src/index.js
```

The session is saved to `.wwebjs_auth/`. You will not need to scan again unless you log out or delete that folder.

> **Tip on a headless VPS:** run via SSH, scan from your phone, then Ctrl-C and hand off to pm2.

---

## 4. Start with pm2

```bash
# Install pm2 globally (once)
npm install -g pm2

# Start the bot
pm2 start ecosystem.config.js

# Make pm2 start automatically on server reboot
pm2 startup            # follow the printed command
pm2 save

# Useful commands
pm2 status             # see if the bot is running
pm2 logs bella-bot     # live log tail
pm2 restart bella-bot  # restart after config changes
pm2 stop bella-bot     # stop without deleting from process list
```

---

## 5. SSH into the VPS and keep it running

```bash
# Connect
ssh user@YOUR_VPS_IP

# Check bot is alive
pm2 status

# Watch live logs
pm2 logs bella-bot --lines 50

# After editing config.json
pm2 restart bella-bot
```

pm2 will automatically restart the bot if it crashes. The `max_restarts: 10` and `restart_delay: 5000` settings in `ecosystem.config.js` prevent a crash loop from hammering resources.

> For day-to-day usage (commands, logging, reminders), see [📖 How to use it](#-how-to-use-it-for-the-family) at the top.

---

## Troubleshooting

| Problem | Fix |
|---|---|
| QR code not showing | Make sure all Chromium deps are installed (`apt-get install` list above) |
| Bot not responding in group | Check `groupName` in `config.json` exactly matches the WhatsApp group name (including emoji) |
| Bot responding in private chats | Shouldn't happen — it only listens to the configured group. Check `groupName` is correct |
| Session expired / logged out | Delete `.wwebjs_auth/` and re-scan the QR code |
| Reminders firing at wrong time | Check `timezone` in `config.json` matches your VPS locale |
| pm2 not starting on reboot | Run `pm2 startup` again and execute the printed command as root |

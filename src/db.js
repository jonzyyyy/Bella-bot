const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const DATA_DIR = path.join(__dirname, '..', 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const DB_FILE = process.env.BELLA_DB || 'bella.db';
const db = new Database(path.join(DATA_DIR, DB_FILE));

db.exec(`
  CREATE TABLE IF NOT EXISTS completions (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    task      TEXT    NOT NULL,
    user_name TEXT    NOT NULL,
    timestamp TEXT    NOT NULL
  );

  CREATE TABLE IF NOT EXISTS reminder_messages (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    task       TEXT NOT NULL,
    message_id TEXT NOT NULL,
    chat_id    TEXT NOT NULL,
    sent_at    TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS status_messages (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    message_id TEXT NOT NULL,
    chat_id    TEXT NOT NULL,
    date       TEXT NOT NULL
  );
`);

// Added later — counts delete attempts so a message that can never be revoked
// is eventually given up on instead of being retried forever.
try {
  db.exec('ALTER TABLE status_messages ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0');
} catch (_) {
  // Column already exists.
}

// ── completions ──────────────────────────────────────────────────────────────

function logCompletion(task, userName, timestamp) {
  const stmt = db.prepare(
    'INSERT INTO completions (task, user_name, timestamp) VALUES (?, ?, ?)'
  );
  stmt.run(task, userName, timestamp || new Date().toISOString());
}

function getCompletionsToday(task) {
  const startOfDay = new Date();
  startOfDay.setHours(0, 0, 0, 0);
  return db
    .prepare(
      'SELECT * FROM completions WHERE task = ? AND timestamp >= ? ORDER BY timestamp ASC'
    )
    .all(task, startOfDay.toISOString());
}

function getLastCompletion(task) {
  return db
    .prepare('SELECT * FROM completions WHERE task = ? ORDER BY timestamp DESC LIMIT 1')
    .get(task);
}

function getCompletionCount(task) {
  return db.prepare('SELECT COUNT(*) as c FROM completions WHERE task = ?').get(task).c;
}

function getCompletionsLast7Days(task) {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - 7);
  return db
    .prepare(
      'SELECT * FROM completions WHERE task = ? AND timestamp >= ? ORDER BY timestamp DESC'
    )
    .all(task, cutoff.toISOString());
}

function resetToday() {
  const startOfDay = new Date();
  startOfDay.setHours(0, 0, 0, 0);
  const info = db
    .prepare('DELETE FROM completions WHERE timestamp >= ?')
    .run(startOfDay.toISOString());
  return info.changes;
}

function resetAll() {
  const info = db.prepare('DELETE FROM completions').run();
  return info.changes;
}

// ── reminder message tracking ─────────────────────────────────────────────────

function saveReminderMessage(task, messageId, chatId) {
  db.prepare(
    'INSERT INTO reminder_messages (task, message_id, chat_id, sent_at) VALUES (?, ?, ?, ?)'
  ).run(task, messageId, chatId, new Date().toISOString());
}

function findTaskByMessageId(messageId) {
  return db
    .prepare('SELECT task FROM reminder_messages WHERE message_id = ?')
    .get(messageId);
}

function getActiveReminderMessages(taskId) {
  return db.prepare('SELECT * FROM reminder_messages WHERE task = ?').all(taskId);
}

function removeReminderMessage(id) {
  db.prepare('DELETE FROM reminder_messages WHERE id = ?').run(id);
}

/**
 * Drops reminder rows older than `days`. A reminder past WhatsApp's revoke
 * window can never be deleted, so without this the retry list would grow
 * forever and every completion would re-try months-old messages.
 */
function purgeOldReminderMessages(days = 2) {
  const cutoff = new Date(Date.now() - days * 86400000).toISOString();
  return db.prepare('DELETE FROM reminder_messages WHERE sent_at < ?').run(cutoff).changes;
}

// ── status message tracking ───────────────────────────────────────────────────

function saveStatusMessage(messageId, chatId, date) {
  db.prepare(
    'INSERT INTO status_messages (message_id, chat_id, date) VALUES (?, ?, ?)'
  ).run(messageId, chatId, date);
}

/** All statuses posted on `date` — usually one, but a failed delete can strand extras. */
function getStatusMessages(date) {
  return db
    .prepare('SELECT * FROM status_messages WHERE date = ? ORDER BY id ASC')
    .all(date);
}

function removeStatusMessage(id) {
  db.prepare('DELETE FROM status_messages WHERE id = ?').run(id);
}

function bumpStatusAttempt(id) {
  db.prepare('UPDATE status_messages SET attempts = attempts + 1 WHERE id = ?').run(id);
}

/**
 * Forgets statuses from earlier days — they're past the point of being
 * deletable. Rows written before this table standardised on "YYYY-MM-DD" hold
 * dates like "6/29/2026", which no string comparison against today's date will
 * match, so they're cleared by shape instead.
 */
function purgeStatusMessagesBefore(date) {
  db.prepare('DELETE FROM status_messages WHERE date < ?').run(date);
  db.prepare("DELETE FROM status_messages WHERE date NOT LIKE '____-__-__'").run();
}

function getCompletionsBetween(task, startISO, endISO) {
  return db
    .prepare(
      'SELECT * FROM completions WHERE task = ? AND timestamp >= ? AND timestamp < ? ORDER BY timestamp ASC'
    )
    .all(task, startISO, endISO);
}

function getLastCompletionWithinMinutes(task, minutes) {
  const cutoff = new Date(Date.now() - minutes * 60 * 1000);
  return db
    .prepare(
      'SELECT * FROM completions WHERE task = ? AND timestamp >= ? ORDER BY timestamp DESC LIMIT 1'
    )
    .get(task, cutoff.toISOString());
}

function getWeeklyCompletionsByUser(startISO, endISO) {
  return db
    .prepare(
      'SELECT user_name, task, COUNT(*) as count FROM completions WHERE timestamp >= ? AND timestamp < ? GROUP BY user_name, task ORDER BY user_name, count DESC'
    )
    .all(startISO, endISO);
}

function undoLastCompletion(task) {
  const row = db
    .prepare('SELECT id, timestamp FROM completions WHERE task = ? ORDER BY timestamp DESC LIMIT 1')
    .get(task);
  if (!row) return null;
  db.prepare('DELETE FROM completions WHERE id = ?').run(row.id);
  return row;
}

module.exports = {
  logCompletion,
  getCompletionsToday,
  getLastCompletion,
  getCompletionCount,
  getCompletionsLast7Days,
  resetToday,
  resetAll,
  saveReminderMessage,
  findTaskByMessageId,
  getActiveReminderMessages,
  removeReminderMessage,
  purgeOldReminderMessages,
  saveStatusMessage,
  getStatusMessages,
  removeStatusMessage,
  bumpStatusAttempt,
  purgeStatusMessagesBefore,
  undoLastCompletion,
  getCompletionsBetween,
  getLastCompletionWithinMinutes,
  getWeeklyCompletionsByUser,
};

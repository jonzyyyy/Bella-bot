const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const DATA_DIR = path.join(__dirname, '..', 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(path.join(DATA_DIR, 'bella.db'));

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

// ── status message tracking ───────────────────────────────────────────────────

function saveStatusMessage(messageId, chatId, date) {
  db.prepare(
    'INSERT INTO status_messages (message_id, chat_id, date) VALUES (?, ?, ?)'
  ).run(messageId, chatId, date);
}

function getLatestStatusMessage(date) {
  return db
    .prepare('SELECT * FROM status_messages WHERE date = ? ORDER BY id DESC LIMIT 1')
    .get(date);
}

function removeStatusMessage(id) {
  db.prepare('DELETE FROM status_messages WHERE id = ?').run(id);
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
  getCompletionsLast7Days,
  resetToday,
  resetAll,
  saveReminderMessage,
  findTaskByMessageId,
  saveStatusMessage,
  getLatestStatusMessage,
  removeStatusMessage,
  undoLastCompletion,
};

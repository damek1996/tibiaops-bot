import Database from "better-sqlite3";

export function initDb() {
  const db = new Database("bot.db");

  db.exec(`
    CREATE TABLE IF NOT EXISTS alerts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL,
      item_norm TEXT NOT NULL,
      item_display TEXT NOT NULL,
      type TEXT NOT NULL,
      direction TEXT NOT NULL,
      threshold INTEGER NOT NULL,
      channel_id TEXT,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_alerts_item ON alerts(item_norm);
  `);

  return db;
}

export function addAlert(db, alert) {
  const stmt = db.prepare(`
    INSERT INTO alerts (user_id, item_norm, item_display, type, direction, threshold, channel_id, created_at)
    VALUES (@user_id, @item_norm, @item_display, @type, @direction, @threshold, @channel_id, @created_at)
  `);
  const info = stmt.run(alert);
  return info.lastInsertRowid;
}

export function listAlerts(db, userId) {
  return db.prepare(`SELECT * FROM alerts WHERE user_id = ? ORDER BY id DESC`).all(userId);
}

export function removeAlert(db, userId, alertId) {
  const info = db.prepare(`DELETE FROM alerts WHERE user_id = ? AND id = ?`).run(userId, alertId);
  return info.changes > 0;
}

export function getAllAlerts(db) {
  return db.prepare(`SELECT * FROM alerts`).all();
}

// SQLite via Node:s inbyggda modul. Endast preparerade satser.
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export function openDb(path) {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    PRAGMA secure_delete = ON;

    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY,
      username TEXT NOT NULL UNIQUE COLLATE NOCASE,
      pw_hash TEXT NOT NULL,
      created TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS invites (
      token_hash TEXT PRIMARY KEY,
      created TEXT NOT NULL,
      expires TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      csrf TEXT NOT NULL,
      expires INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS forms (
      id INTEGER PRIMARY KEY,
      owner_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      slug TEXT NOT NULL UNIQUE,
      title TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      questions TEXT NOT NULL,
      open INTEGER NOT NULL DEFAULT 1,
      retention_days INTEGER,
      created TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS responses (
      id INTEGER PRIMARY KEY,
      form_id INTEGER NOT NULL REFERENCES forms(id) ON DELETE CASCADE,
      day TEXT NOT NULL,
      answers TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS responses_form ON responses(form_id);
  `);

  const q = (sql) => db.prepare(sql);
  const st = {
    userByName: q('SELECT * FROM users WHERE username = ?'),
    userById: q('SELECT id, username FROM users WHERE id = ?'),
    insUser: q('INSERT INTO users (username, pw_hash, created) VALUES (?, ?, ?)'),
    setPw: q('UPDATE users SET pw_hash = ? WHERE id = ?'),
    insInvite: q('INSERT INTO invites (token_hash, created, expires) VALUES (?, ?, ?)'),
    delInvite: q('DELETE FROM invites WHERE token_hash = ? AND expires > ?'),
    hasInvite: q('SELECT 1 AS ok FROM invites WHERE token_hash = ? AND expires > ?'),
    purgeInvites: q('DELETE FROM invites WHERE expires <= ?'),
    insSession: q('INSERT INTO sessions (token_hash, user_id, csrf, expires) VALUES (?, ?, ?, ?)'),
    session: q('SELECT s.csrf, s.user_id, u.username FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ? AND s.expires > ?'),
    delSession: q('DELETE FROM sessions WHERE token_hash = ?'),
    delUserSessions: q('DELETE FROM sessions WHERE user_id = ?'),
    purgeSessions: q('DELETE FROM sessions WHERE expires <= ?'),
    formsByOwner: q('SELECT f.id, f.slug, f.title, f.open, (SELECT COUNT(*) FROM responses r WHERE r.form_id = f.id) AS n FROM forms f WHERE f.owner_id = ? ORDER BY f.id DESC'),
    // owner_id ingår alltid i uppslaget: åtkomstkontrollen kan inte glömmas.
    formOwned: q('SELECT * FROM forms WHERE id = ? AND owner_id = ?'),
    formBySlug: q('SELECT id, slug, title, description, questions, open FROM forms WHERE slug = ?'),
    insForm: q('INSERT INTO forms (owner_id, slug, title, description, questions, open, retention_days, created) VALUES (?, ?, ?, ?, ?, 1, ?, ?)'),
    updForm: q('UPDATE forms SET title = ?, description = ?, questions = ?, open = ?, retention_days = ? WHERE id = ? AND owner_id = ?'),
    delForm: q('DELETE FROM forms WHERE id = ? AND owner_id = ?'),
    insResp: q('INSERT INTO responses (form_id, day, answers) VALUES (?, ?, ?)'),
    respsOwned: q('SELECT r.id, r.day, r.answers FROM responses r JOIN forms f ON f.id = r.form_id WHERE f.id = ? AND f.owner_id = ? ORDER BY r.id'),
    delRespsOwned: q('DELETE FROM responses WHERE form_id IN (SELECT id FROM forms WHERE id = ? AND owner_id = ?)'),
    delOneRespOwned: q('DELETE FROM responses WHERE id = ? AND form_id IN (SELECT id FROM forms WHERE id = ? AND owner_id = ?)'),
    retentionForms: q('SELECT id, retention_days FROM forms WHERE retention_days IS NOT NULL'),
    purgeResps: q('DELETE FROM responses WHERE form_id = ? AND day < ?'),
  };

  return {
    db,
    st,
    /** Radera svar äldre än respektive utvärderings gallringstid. */
    purgeExpired(now = new Date()) {
      let removed = 0;
      for (const f of st.retentionForms.all()) {
        const cutoff = new Date(now.getTime() - f.retention_days * 86400000).toISOString().slice(0, 10);
        removed += Number(st.purgeResps.run(f.id, cutoff).changes);
      }
      st.purgeSessions.run(now.getTime());
      st.purgeInvites.run(now.toISOString());
      return removed;
    },
    close() {
      db.close();
    },
  };
}

import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { MYSTERY_SPOTS, PARTY_COST } from './public/mystery.js';

const CLUE_TEXT = {
  reception: 'A receipt for Room 003: “$3 paid. The price comes first in the lock code.”',
  lounge: 'A postcard under a cushion: “One guest stayed behind. The guest count goes second.”',
  pool: 'A tag on the towel basket: “Four dry towels. The towel count goes last.”',
};
const failure = (status, message) => Object.assign(new Error(message), { status });

// One small embedded database. No chat, IPs, wallet data or raw cookie tokens.
export function createPassportStore(dataDir) {
  if (dataDir !== ':memory:') mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(dataDir === ':memory:' ? dataDir : path.join(dataDir, 'passports.sqlite'));
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = FULL;
    PRAGMA busy_timeout = 1000;
    CREATE TABLE IF NOT EXISTS passports (
      id TEXT PRIMARY KEY,
      clues INTEGER NOT NULL DEFAULT 0 CHECK(clues BETWEEN 0 AND 7),
      solved_at INTEGER,
      credits INTEGER NOT NULL DEFAULT 0 CHECK(credits BETWEEN 0 AND 3)
    ) STRICT;
    CREATE TABLE IF NOT EXISTS party (
      id INTEGER PRIMARY KEY CHECK(id = 1),
      ends_at INTEGER NOT NULL DEFAULT 0,
      started_by TEXT
    ) STRICT;
    INSERT OR IGNORE INTO party(id) VALUES(1);
  `);
  const get = db.prepare('SELECT clues, solved_at, credits FROM passports WHERE id = ?');
  const count = db.prepare('SELECT count(*) AS count FROM passports');
  const insert = db.prepare('INSERT INTO passports(id) VALUES(?)');
  const collect = db.prepare('UPDATE passports SET clues = clues | ? WHERE id = ?');
  const award = db.prepare('UPDATE passports SET solved_at = ?, credits = ? WHERE id = ? AND solved_at IS NULL');
  const debit = db.prepare('UPDATE passports SET credits = credits - ? WHERE id = ? AND credits >= ?');
  const readParty = db.prepare('SELECT ends_at AS endsAt, started_by AS startedBy FROM party WHERE id = 1');
  const writeParty = db.prepare('UPDATE party SET ends_at = ?, started_by = ? WHERE id = 1');

  function transaction(action) {
    db.exec('BEGIN IMMEDIATE');
    try { const result = action(); db.exec('COMMIT'); return result; }
    catch (error) { db.exec('ROLLBACK'); throw error; }
  }
  function read(id) {
    const row = id ? get.get(id) : null;
    if (!row) return null;
    return {
      clues: MYSTERY_SPOTS.filter((spot, index) => row.clues & (1 << index)).map(spot => ({ id: spot.id, title: spot.title, text: CLUE_TEXT[spot.id] })),
      solved: row.solved_at !== null,
      stamp: row.solved_at === null ? null : { id: 'room-003', title: 'Room 003 · Founding sleuth', earnedAt: row.solved_at },
      credits: row.credits,
    };
  }
  return {
    read,
    create(id) {
      // Bound disk growth on the small VM without discarding earned progress.
      if (count.get().count >= 100_000) throw failure(503, 'Reception cannot issue another passport just now.');
      insert.run(id);
    },
    inspect(id, clueId) {
      const index = MYSTERY_SPOTS.findIndex(spot => spot.id === clueId);
      if (index < 0) throw failure(400, 'Choose one of the three clues.');
      collect.run(1 << index, id);
      return read(id);
    },
    solve(id, code) {
      return transaction(() => {
        const row = get.get(id);
        if (!row || row.clues !== 7) throw failure(400, 'Collect all three clues around the courtyard first.');
        if (typeof code !== 'string' || code.trim() !== '314') throw failure(400, 'That code did not open the lock. Read the three clues in order.');
        award.run(Date.now(), PARTY_COST, id);
        return read(id);
      });
    },
    party: () => ({ ...readParty.get() }),
    startParty(id, name, now, duration) {
      return transaction(() => {
        if (readParty.get().endsAt > now) throw failure(409, 'A pool party is already running. Your credits are still yours.');
        if (debit.run(PARTY_COST, id, PARTY_COST).changes !== 1) throw failure(400, 'Solve Room 003 to earn the three demo credits for a party.');
        writeParty.run(now + duration, name);
        return { ...readParty.get() };
      });
    },
    close: () => db.close(),
  };
}

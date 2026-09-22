import { PLAYER_COLORS } from "@family/protocol";
import { Database } from "bun:sqlite";
import { readFileSync, writeFileSync } from "node:fs";
import type { HostPaths } from "./paths";

export type PlayerRow = {
  id: string;
  name: string;
  color: string;
  created_at: number;
  updated_at: number;
};

export type SourceRow = {
  id: string;
  name: string;
  url: string;
  enabled: number;
  catalog: string | null;
};

export function openDatabase(paths: HostPaths): Database {
  const db = new Database(paths.sqlitePath);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec(`
    CREATE TABLE IF NOT EXISTS players (
      id TEXT PRIMARY KEY,
      name TEXT UNIQUE NOT NULL,
      color TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS player_tokens (
      token TEXT PRIMARY KEY,
      player_id TEXT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS saves (
      game_id TEXT NOT NULL,
      player_id TEXT NOT NULL,
      key TEXT NOT NULL,
      value TEXT NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (game_id, player_id, key)
    );
    CREATE TABLE IF NOT EXISTS sources (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL DEFAULT '',
      url TEXT UNIQUE NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      catalog TEXT
    );
    CREATE TABLE IF NOT EXISTS installed_games (
      id TEXT PRIMARY KEY,
      version TEXT NOT NULL,
      source_id TEXT,
      installed_at INTEGER NOT NULL
    );
  `);
  return db;
}

export type HostFileConfig = {
  selectedAddress?: string | null;
};

export function readHostConfig(paths: HostPaths): HostFileConfig {
  try {
    return JSON.parse(readFileSync(paths.configPath, "utf8")) as HostFileConfig;
  } catch {
    return {};
  }
}

export function writeHostConfig(paths: HostPaths, config: HostFileConfig) {
  writeFileSync(paths.configPath, JSON.stringify(config, null, 2), "utf8");
}

export function nextColor(db: Database): string {
  const used = new Set(
    db.query("SELECT color FROM players").all().map((row) => (row as { color: string }).color),
  );
  return PLAYER_COLORS.find((c) => !used.has(c)) ?? PLAYER_COLORS[used.size % PLAYER_COLORS.length]!;
}

export function newToken(): string {
  return Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("hex");
}

export function listPlayers(db: Database): PlayerRow[] {
  return db.query("SELECT * FROM players ORDER BY created_at ASC").all() as PlayerRow[];
}

export function getPlayer(db: Database, id: string): PlayerRow | undefined {
  return db.query("SELECT * FROM players WHERE id = ?").get(id) as PlayerRow | undefined;
}

export function getPlayerByName(db: Database, name: string): PlayerRow | undefined {
  return db.query("SELECT * FROM players WHERE name = ?").get(name) as PlayerRow | undefined;
}

export function createPlayer(db: Database, name: string): { player: PlayerRow; token: string } {
  const now = Date.now();
  const player: PlayerRow = {
    id: crypto.randomUUID(),
    name,
    color: nextColor(db),
    created_at: now,
    updated_at: now,
  };
  db.query(
    "INSERT INTO players (id, name, color, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
  ).run(player.id, player.name, player.color, player.created_at, player.updated_at);
  const token = issueToken(db, player.id);
  return { player, token };
}

export function issueToken(db: Database, playerId: string): string {
  const token = newToken();
  db.query("INSERT INTO player_tokens (token, player_id, created_at) VALUES (?, ?, ?)").run(
    token,
    playerId,
    Date.now(),
  );
  return token;
}

export function playerIdByToken(db: Database, token: string): string | undefined {
  const row = db.query("SELECT player_id FROM player_tokens WHERE token = ?").get(token) as
    | { player_id: string }
    | undefined;
  return row?.player_id;
}

export function renamePlayer(db: Database, id: string, name: string): PlayerRow {
  db.query("UPDATE players SET name = ?, updated_at = ? WHERE id = ?").run(name, Date.now(), id);
  const player = getPlayer(db, id);
  if (!player) throw new Error("not_found");
  return player;
}

export function revokeTokens(db: Database, playerId: string) {
  db.query("DELETE FROM player_tokens WHERE player_id = ?").run(playerId);
}

export function deletePlayer(db: Database, id: string) {
  revokeTokens(db, id);
  db.query("DELETE FROM saves WHERE player_id = ?").run(id);
  db.query("DELETE FROM players WHERE id = ?").run(id);
}

export function getSave(
  db: Database,
  gameId: string,
  playerId: string,
  key: string,
): string | undefined {
  const row = db
    .query("SELECT value FROM saves WHERE game_id = ? AND player_id = ? AND key = ?")
    .get(gameId, playerId, key) as { value: string } | undefined;
  return row?.value;
}

export function putSave(
  db: Database,
  gameId: string,
  playerId: string,
  key: string,
  value: string,
) {
  db.query(
    `INSERT INTO saves (game_id, player_id, key, value, updated_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(game_id, player_id, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  ).run(gameId, playerId, key, value, Date.now());
}

export function saveGameBytes(db: Database, gameId: string): number {
  const row = db.query("SELECT COALESCE(SUM(LENGTH(value)), 0) AS n FROM saves WHERE game_id = ?").get(gameId) as {
    n: number;
  };
  return row.n;
}

export function saveValueBytes(db: Database, gameId: string, playerId: string, key: string): number {
  const row = db
    .query("SELECT LENGTH(value) AS n FROM saves WHERE game_id = ? AND player_id = ? AND key = ?")
    .get(gameId, playerId, key) as { n: number } | undefined;
  return row?.n ?? 0;
}

export function purgeSaves(db: Database, gameId: string) {
  db.query("DELETE FROM saves WHERE game_id = ?").run(gameId);
}

export function listSources(db: Database): SourceRow[] {
  return db.query("SELECT * FROM sources ORDER BY name ASC").all() as SourceRow[];
}

export function getSource(db: Database, id: string): SourceRow | undefined {
  return db.query("SELECT * FROM sources WHERE id = ?").get(id) as SourceRow | undefined;
}

export function insertSource(db: Database, url: string): SourceRow {
  const row: SourceRow = {
    id: crypto.randomUUID(),
    name: "",
    url,
    enabled: 1,
    catalog: null,
  };
  db.query("INSERT INTO sources (id, name, url, enabled, catalog) VALUES (?, ?, ?, ?, ?)").run(
    row.id,
    row.name,
    row.url,
    row.enabled,
    row.catalog,
  );
  return row;
}

export function deleteSource(db: Database, id: string) {
  db.query("DELETE FROM sources WHERE id = ?").run(id);
}

export function updateSourceCatalog(db: Database, id: string, name: string, catalog: string) {
  db.query("UPDATE sources SET name = ?, catalog = ? WHERE id = ?").run(name, catalog, id);
}

export function recordInstalled(db: Database, id: string, version: string, sourceId: string | null) {
  db.query(
    `INSERT INTO installed_games (id, version, source_id, installed_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET version = excluded.version, source_id = excluded.source_id, installed_at = excluded.installed_at`,
  ).run(id, version, sourceId, Date.now());
}

export function removeInstalled(db: Database, id: string) {
  db.query("DELETE FROM installed_games WHERE id = ?").run(id);
}

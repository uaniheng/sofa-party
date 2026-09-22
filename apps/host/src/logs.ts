import {
  MAX_LOG_ENTRIES,
  MAX_LOG_HZ,
  MAX_LOG_MESSAGE_BYTES,
  type GameLogEntry,
  type GameLogLevel,
  type GameLogSource,
} from "@family/protocol";
import type { Conn } from "./party";

const LEVELS: GameLogLevel[] = ["debug", "info", "warn", "error"];

export type LogInput = {
  level?: GameLogLevel;
  source: GameLogSource;
  gameId?: string | null;
  role?: GameLogEntry["role"];
  playerId?: string;
  playerName?: string;
  message: string;
  data?: unknown;
};

function utf8Bytes(text: string): number {
  return new TextEncoder().encode(text).length;
}

function clipMessage(message: string): string {
  if (utf8Bytes(message) <= MAX_LOG_MESSAGE_BYTES) return message;
  let out = message;
  while (utf8Bytes(out) > MAX_LOG_MESSAGE_BYTES - 1) out = out.slice(0, Math.max(0, out.length - 8));
  return `${out}…`;
}

export function parseLogLevel(value: unknown): GameLogLevel {
  if (typeof value === "string" && LEVELS.includes(value as GameLogLevel)) return value as GameLogLevel;
  return "info";
}

export class GameLogBuffer {
  private entries: GameLogEntry[] = [];
  private nextId = 1;

  write(input: LogInput): GameLogEntry {
    let data = input.data;
    if (data !== undefined) {
      try {
        JSON.stringify(data);
      } catch {
        data = { error: "data_not_json" };
      }
    }
    const entry: GameLogEntry = {
      id: this.nextId++,
      ts: Date.now(),
      level: input.level ?? "info",
      source: input.source,
      gameId: input.gameId ?? null,
      role: input.role,
      playerId: input.playerId,
      playerName: input.playerName,
      message: clipMessage(String(input.message ?? "")),
    };
    if (data !== undefined) entry.data = data;
    this.entries.push(entry);
    if (this.entries.length > MAX_LOG_ENTRIES) {
      this.entries.splice(0, this.entries.length - MAX_LOG_ENTRIES);
    }
    return entry;
  }

  after(id: number): GameLogEntry[] {
    if (!id) return [...this.entries];
    const start = this.entries.findIndex((e) => e.id > id);
    if (start < 0) return [];
    return this.entries.slice(start);
  }

  clear() {
    this.entries = [];
  }

  ingest(conn: Conn, gameId: string | null, raw: { level?: unknown; message?: unknown; data?: unknown }) {
    if (typeof raw.message !== "string" || !raw.message.trim()) {
      return { error: "bad_log", message: "日志缺少 message" };
    }
    const packed = JSON.stringify({ message: raw.message, data: raw.data ?? null });
    if (utf8Bytes(packed) > MAX_LOG_MESSAGE_BYTES) {
      return { error: "too_large", message: "日志太大" };
    }
    const now = Date.now();
    conn.logTimes = conn.logTimes.filter((t) => now - t < 1000);
    if (conn.logTimes.length >= MAX_LOG_HZ) {
      return { error: "rate_limited", message: "日志太快了" };
    }
    conn.logTimes.push(now);
    this.write({
      level: parseLogLevel(raw.level),
      source: "game",
      gameId,
      role: conn.role,
      playerId: conn.player?.id,
      playerName: conn.player?.name,
      message: raw.message,
      data: raw.data,
    });
    return null;
  }
}

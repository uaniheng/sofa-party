import { describe, expect, test } from "bun:test";
import { MAX_LOG_ENTRIES } from "@family/protocol";
import { GameLogBuffer } from "./logs";
import type { Conn } from "./party";

function fakeConn(): Conn {
  return {
    id: "c1",
    sink: { send() {}, close() {} },
    role: "player",
    player: { id: "p1", name: "小明", color: "#4C8BF5" },
    inGame: true,
    inputTimes: [],
    logTimes: [],
  };
}

describe("game logs", () => {
  test("keeps a ring buffer and after-cursor", () => {
    const buf = new GameLogBuffer();
    buf.write({ source: "host", message: "a", gameId: "quiz-party" });
    const second = buf.write({ source: "game", level: "error", message: "boom" });
    expect(buf.after(0)).toHaveLength(2);
    expect(buf.after(second.id - 1).map((e) => e.message)).toEqual(["boom"]);
    buf.clear();
    expect(buf.after(0)).toHaveLength(0);
  });

  test("drops old entries past the cap", () => {
    const buf = new GameLogBuffer();
    for (let i = 0; i < MAX_LOG_ENTRIES + 10; i++) {
      buf.write({ source: "host", message: String(i) });
    }
    const all = buf.after(0);
    expect(all.length).toBe(MAX_LOG_ENTRIES);
    expect(all[0]?.message).toBe("10");
  });

  test("ingest attaches player identity and rate-limits", () => {
    const buf = new GameLogBuffer();
    const conn = fakeConn();
    expect(buf.ingest(conn, "quiz-party", { level: "warn", message: "慢了" })).toBeNull();
    const row = buf.after(0)[0]!;
    expect(row.playerName).toBe("小明");
    expect(row.gameId).toBe("quiz-party");
    expect(row.level).toBe("warn");
    expect(buf.ingest(conn, "quiz-party", { message: "   " })?.error).toBe("bad_log");
    conn.logTimes = Array.from({ length: 20 }, () => Date.now());
    expect(buf.ingest(conn, "quiz-party", { message: "spam" })?.error).toBe("rate_limited");
  });
});

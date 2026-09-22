import { describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { GameRegistry, validateManifest } from "./games";
import { scoreAddress } from "./lan";
import { PartyRoom, pickAuthority, viewFor, type Conn, type SocketSink } from "./party";
import { findZipManifestRoot, isUnsafeZipPath } from "./zip";
import type { GameInfo } from "@family/protocol";

describe("lan", () => {
  test("prefers home wifi addresses", () => {
    expect(scoreAddress("192.168.1.8")).toBeGreaterThan(scoreAddress("10.0.0.2"));
    expect(scoreAddress("10.0.0.2")).toBeGreaterThan(scoreAddress("172.16.0.2"));
  });
});

describe("zip paths", () => {
  test("rejects traversal and absolute paths", () => {
    expect(isUnsafeZipPath("../etc/passwd")).toBe(true);
    expect(isUnsafeZipPath("/tmp/x")).toBe(true);
    expect(isUnsafeZipPath("C:/windows/x")).toBe(true);
    expect(isUnsafeZipPath("quiz-party/manifest.json")).toBe(false);
    expect(isUnsafeZipPath("manifest.json")).toBe(false);
  });

  test("finds nested manifest", () => {
    expect(findZipManifestRoot(["manifest.json", "player/index.html"])).toBe("");
    expect(findZipManifestRoot(["quiz-party/manifest.json", "quiz-party/player/index.html"])).toBe(
      "quiz-party",
    );
    expect(findZipManifestRoot(["readme.txt"])).toBeNull();
  });
});

describe("manifest", () => {
  const dir = join(import.meta.dir, "..", "..", "..", "games");

  test("accepts the bundled games", () => {
    const games = new GameRegistry(dir);
    const list = games.scan();
    const duel = list.find((g) => g.id === "bow-duel");
    const drop = list.find((g) => g.id === "catch-drop");
    expect(duel?.broken).toBe(false);
    expect(duel?.playMode).toBe("personal");
    expect(drop?.broken).toBe(false);
    expect(drop?.playMode).toBe("shared-screen");
  });

  test("marks id mismatch as broken", () => {
    const tmp = join(import.meta.dir, "..", "..", "..", "data", "tmp-manifest-test");
    mkdirSync(join(tmp, "bad-id"), { recursive: true });
    writeFileSync(
      join(tmp, "bad-id", "manifest.json"),
      JSON.stringify({
        id: "other",
        name: "x",
        version: "1.0.0",
        minPlayers: 1,
        maxPlayers: 2,
        playMode: "personal",
        entry: { player: "player/index.html" },
      }),
    );
    const result = validateManifest(
      {
        id: "other",
        name: "x",
        version: "1.0.0",
        minPlayers: 1,
        maxPlayers: 2,
        playMode: "personal",
        entry: { player: "player/index.html" },
      },
      "bad-id",
      tmp,
    );
    expect(result.ok).toBe(false);
    rmSync(tmp, { recursive: true, force: true });
  });
});

function fakeGame(over: Partial<GameInfo> = {}): GameInfo {
  return {
    id: "quiz-party",
    name: "家庭抢答",
    version: "1.0.0",
    description: "",
    minPlayers: 2,
    maxPlayers: 8,
    playMode: "personal",
    supportsTV: false,
    usesSave: true,
    tickHz: 20,
    broken: false,
    hasServer: false,
    entries: { player: "/games/quiz-party/player/index.html" },
    ...over,
  };
}

function sink(): SocketSink & { closed: boolean; messages: object[] } {
  const messages: object[] = [];
  return {
    messages,
    closed: false,
    send(msg) {
      messages.push(msg);
    },
    close() {
      this.closed = true;
    },
  };
}

describe("party", () => {
  test("start needs enough players and may need a display", () => {
    const games = new GameRegistry(".");
    games.games = [fakeGame({ playMode: "shared-screen", minPlayers: 2 })];
    const party = new PartyRoom(games);
    const a = sink();
    const b = sink();
    party.attachPlayer({ id: "1", name: "小明", color: "#4C8BF5" }, a);
    expect(party.start("quiz-party", "1")).toMatchObject({ error: "too_few" });
    party.attachPlayer({ id: "2", name: "小红", color: "#E74C3C" }, b);
    expect(party.start("quiz-party", "1")).toMatchObject({ error: "need_display" });
    party.attachDisplay(sink());
    expect(party.start("quiz-party", "1")).toMatchObject({ ok: true });
  });

  test("a host script without a file cannot start", () => {
    const games = new GameRegistry(".");
    games.games = [fakeGame({ hasServer: true, minPlayers: 1 })];
    const party = new PartyRoom(games);
    party.attachPlayer({ id: "1", name: "小明", color: "#4C8BF5" }, sink());
    expect(party.start("quiz-party", "1")).toMatchObject({ error: "game_broken" });
  });

  test("a taken name cannot be claimed by someone else", () => {
    const games = new GameRegistry(".");
    games.games = [fakeGame({ minPlayers: 1 })];
    const party = new PartyRoom(games);
    expect(party.tryClaim("1", "token-a")).toBe(true);
    expect(party.tryClaim("1", "token-b")).toBe(false);
    const blocked = sink();
    expect(party.attachPlayer({ id: "1", name: "小明", color: "#4C8BF5" }, blocked, "token-b")).toMatchObject({
      ok: false,
      error: "taken",
    });
    const first = sink();
    const second = sink();
    expect(party.attachPlayer({ id: "1", name: "小明", color: "#4C8BF5" }, first, "token-a")).toMatchObject({
      ok: true,
    });
    expect(party.attachPlayer({ id: "1", name: "小明", color: "#4C8BF5" }, second, "token-b")).toMatchObject({
      ok: false,
      error: "taken",
    });
    expect(first.closed).toBe(false);
    expect(party.players.size).toBe(1);
  });

  test("the same token can replace its own connection", () => {
    const games = new GameRegistry(".");
    const party = new PartyRoom(games);
    const first = sink();
    const second = sink();
    party.attachPlayer({ id: "1", name: "小明", color: "#4C8BF5" }, first, "tok");
    party.attachPlayer({ id: "1", name: "小明", color: "#4C8BF5" }, second, "tok");
    expect(first.closed).toBe(true);
    expect(first.messages.some((m) => (m as { type: string }).type === "player.replaced")).toBe(true);
    expect(first.messages.some((m) => (m as { type: string }).type === "player.kicked")).toBe(false);
    expect(party.players.size).toBe(1);
  });

  test("starter disconnect keeps the party for a reconnect", () => {
    const games = new GameRegistry(".");
    games.games = [fakeGame({ minPlayers: 1, playMode: "personal" })];
    const party = new PartyRoom(games);
    const first = sink();
    party.attachPlayer({ id: "1", name: "小明", color: "#4C8BF5" }, first, "tok");
    expect(party.start("quiz-party", "1")).toMatchObject({ ok: true });
    const conn = party.getPlayerConn("1")!;
    party.detach(conn);
    expect(party.phase).toBe("playing");
    expect(party.occupied("1")).toBe(true);
    const second = sink();
    expect(party.attachPlayer({ id: "1", name: "小明", color: "#4C8BF5" }, second, "tok")).toMatchObject({
      ok: true,
    });
    expect(party.phase).toBe("playing");
    expect(party.players.has("1")).toBe(true);
    expect(second.messages.some((m) => (m as { type: string }).type === "party.start")).toBe(true);
  });

  test("dropPlayer frees the name immediately", () => {
    const games = new GameRegistry(".");
    const party = new PartyRoom(games);
    party.attachPlayer({ id: "1", name: "小明", color: "#4C8BF5" }, sink(), "tok");
    party.dropPlayer("1");
    expect(party.occupied("1")).toBe(false);
    expect(party.tryClaim("1", "other")).toBe(true);
  });

  test("kicking the starter ends a personal game", () => {
    const games = new GameRegistry(".");
    games.games = [fakeGame({ minPlayers: 1, playMode: "personal" })];
    const party = new PartyRoom(games);
    party.attachPlayer({ id: "1", name: "小明", color: "#4C8BF5" }, sink(), "tok");
    expect(party.start("quiz-party", "1")).toMatchObject({ ok: true });
    party.dropPlayer("1");
    expect(party.phase).toBe("idle");
    expect(party.occupied("1")).toBe(false);
  });

  test("keeps every display and only the last leave clears the screen", () => {
    const games = new GameRegistry(".");
    const party = new PartyRoom(games);
    const playerSink = sink();
    const joined = party.attachPlayer({ id: "1", name: "小明", color: "#4C8BF5" }, playerSink, "tok");
    if (!joined.ok) throw new Error(joined.message);
    const first = sink();
    const second = sink();
    const firstConn = party.attachDisplay(first);
    const secondConn = party.attachDisplay(second);
    expect(first.closed).toBe(false);
    expect(party.displayCount()).toBe(2);
    expect(playerSink.messages.filter((m) => (m as { type: string }).type === "display.ready")).toHaveLength(1);
    party.detach(firstConn);
    expect(party.displayConnected()).toBe(true);
    expect(playerSink.messages.some((m) => (m as { type: string }).type === "display.gone")).toBe(false);
    party.detach(secondConn);
    expect(party.displayConnected()).toBe(false);
    expect(playerSink.messages.some((m) => (m as { type: string }).type === "display.gone")).toBe(true);
  });

  test("a newly joined display receives the latest snapshot", () => {
    const games = new GameRegistry(".");
    games.games = [fakeGame({ minPlayers: 1, playMode: "personal" })];
    const party = new PartyRoom(games);
    const joined = party.attachPlayer({ id: "1", name: "小明", color: "#4C8BF5" }, sink(), "tok");
    if (!joined.ok) throw new Error(joined.message);
    party.attachDisplay(sink());
    expect(party.start("quiz-party", "1")).toMatchObject({ ok: true });
    expect(party.handleState(joined.conn, { x: 1 })).toBeNull();
    const late = sink();
    party.attachDisplay(late);
    expect(late.messages.some((m) => (m as { type?: string; payload?: { x?: number } }).payload?.x === 1)).toBe(
      true,
    );
  });

  test("view mapping", () => {
    const player: Conn = {
      id: "c",
      sink: sink(),
      role: "player",
      player: { id: "1", name: "a", color: "#000" },
      inGame: true,
      inputTimes: [],
      logTimes: [],
    };
    expect(viewFor(player, "idle", null, false)).toBe("lobby");
    expect(viewFor(player, "playing", "personal", true)).toBe("game-player");
    expect(viewFor(player, "playing", "shared-screen", true)).toBe("game-controller");
    expect(viewFor(player, "playing", "personal", false)).toBe("wait");
    const display: Conn = { ...player, role: "display", player: undefined, logTimes: [] };
    expect(viewFor(display, "playing", "shared-screen", true)).toBe("game-display");
    expect(viewFor(display, "playing", "personal", true)).toBe("lobby");
  });

  test("authority without server", () => {
    expect(pickAuthority("personal", false)).toBe("starter");
    expect(pickAuthority("shared-screen", false)).toBe("starter");
    expect(pickAuthority("hybrid", false)).toBe("starter");
    expect(pickAuthority("personal", true)).toBe("host");
    expect(pickAuthority("shared-screen", true)).toBe("host");
  });

  test("host script receives play and can end the party", async () => {
    const dir = join(import.meta.dir, "..", "..", "..", "data", "tmp-server-ok");
    rmSync(dir, { recursive: true, force: true });
    installDemo(
      dir,
      `export default {
        async onStart(ctx) {
          await ctx.save.setShared("n", 2);
          ctx.broadcastPlayers({ n: await ctx.save.getShared("n") });
        },
        onInput(_id, payload, ctx) {
          if (payload && payload.end) ctx.end();
        },
      };`,
    );
    const games = new GameRegistry(dir);
    games.scan();
    const store = new Map<string, unknown>();
    const party = new PartyRoom(games, {
      log() {},
      readSave(_gameId, playerId, key) {
        return store.get(`${playerId}:${key}`);
      },
      writeSave(_gameId, playerId, key, value) {
        store.set(`${playerId}:${key}`, value);
        return null;
      },
    });
    const joined = party.attachPlayer({ id: "1", name: "小明", color: "#4C8BF5" }, sink(), "tok");
    if (!joined.ok) throw new Error(joined.message);
    try {
      expect(party.start("demo", "1")).toMatchObject({ ok: true });
      expect(party.authority).toBe("host");
      expect(joined.conn.sink).toBeTruthy();
      const messages = (joined.conn.sink as SocketSink & { messages: object[] }).messages;
      await until(() => messages.some((m) => (m as { type?: string }).type === "game"));
      const gameMsg = messages.find((m) => (m as { type?: string }).type === "game") as {
        payload: { n: number };
      };
      expect(gameMsg.payload.n).toBe(2);
      expect(store.get(":n")).toBe(2);
      party.handleInput(joined.conn, { end: true });
      await until(() => party.phase === "idle");
    } finally {
      party.endParty();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a crashing host script ends only the party", async () => {
    const dir = join(import.meta.dir, "..", "..", "..", "data", "tmp-server-crash");
    rmSync(dir, { recursive: true, force: true });
    installDemo(
      dir,
      `export default { onStart() { throw new Error("算挂了"); } };`,
    );
    const games = new GameRegistry(dir);
    games.scan();
    const party = new PartyRoom(games);
    const playerSink = sink();
    party.attachPlayer({ id: "1", name: "小明", color: "#4C8BF5" }, playerSink, "tok");
    try {
      expect(party.start("demo", "1")).toMatchObject({ ok: true });
      await until(() => party.phase === "idle");
      expect(playerSink.messages.some((m) => (m as { error?: string }).error === "game_server_crash")).toBe(
        true,
      );
      expect(party.phase).toBe("idle");
    } finally {
      party.endParty();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

function installDemo(dir: string, server: string) {
  const root = join(dir, "demo");
  mkdirSync(join(root, "player"), { recursive: true });
  writeFileSync(join(root, "player", "index.html"), "<!doctype html>");
  writeFileSync(join(root, "server.js"), server);
  writeFileSync(
    join(root, "manifest.json"),
    JSON.stringify({
      id: "demo",
      name: "演示",
      version: "1.0.0",
      minPlayers: 1,
      maxPlayers: 2,
      playMode: "personal",
      entry: { player: "player/index.html", server: "server.js" },
    }),
  );
}

async function until(pred: () => boolean, ms = 2000) {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (pred()) return;
    await Bun.sleep(20);
  }
  throw new Error("timed out");
}

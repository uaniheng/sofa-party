import {
  MAX_GAME_MESSAGE_BYTES,
  MAX_INPUT_BYTES,
  MAX_INPUT_HZ,
  type Authority,
  type ConnRole,
  type GameEntries,
  type GameInfo,
  type GameLogLevel,
  type PartyStateMessage,
  type Phase,
  type PlayMode,
  type PlayerPublic,
  type SendTo,
  type View,
} from "@family/protocol";
import { GameServer } from "./game-server";
import type { GameRegistry } from "./games";

export type SocketSink = {
  send(msg: object): void;
  close(): void;
};

export type Conn = {
  id: string;
  sink: SocketSink;
  role: ConnRole;
  player?: PlayerPublic;
  inGame: boolean;
  inputTimes: number[];
  logTimes: number[];
};

export type StartError = { error: string; message: string };

export type PartyServices = {
  log(input: {
    level?: GameLogLevel;
    source: "server" | "host";
    gameId?: string | null;
    message: string;
    data?: unknown;
  }): void;
  readSave(gameId: string, playerId: string, key: string): unknown;
  writeSave(gameId: string, playerId: string, key: string, value: unknown): string | null;
};

const noopServices: PartyServices = {
  log() {},
  readSave() {
    return undefined;
  },
  writeSave() {
    return null;
  },
};

const CLAIM_HOLD_MS = 15_000;
const RECONNECT_HOLD_MS = 10_000;

type Seat = { token: string; until: number };

export type AttachPlayerResult =
  | { ok: true; conn: Conn; replaced: Conn | null }
  | { ok: false; error: string; message: string };

function utf8Bytes(value: unknown): number {
  return new TextEncoder().encode(typeof value === "string" ? value : JSON.stringify(value)).length;
}

export function viewFor(conn: Conn, phase: Phase, playMode: PlayMode | null, inGame: boolean): View {
  if (conn.role === "display") {
    if (phase === "playing" && (playMode === "shared-screen" || playMode === "hybrid")) {
      return "game-display";
    }
    return "lobby";
  }
  if (phase === "idle") return "lobby";
  if (!inGame) return "wait";
  if (playMode === "personal") return "game-player";
  return "game-controller";
}

export function pickAuthority(_playMode: PlayMode, hasServer: boolean): Authority {
  if (hasServer) return "host";
  return "starter";
}

export class PartyRoom {
  phase: Phase = "idle";
  gameId: string | null = null;
  playMode: PlayMode | null = null;
  starterPlayerId: string | null = null;
  authority: Authority | null = null;
  entries: GameEntries | null = null;
  private server: GameServer | null = null;
  private serverKnown = new Set<string>();
  private displays: Conn[] = [];
  private lastState: { type: "state"; payload: unknown } | null = null;
  players = new Map<string, Conn>();
  waiting = new Set<string>();
  private seats = new Map<string, Seat>();
  private watchers = new Map<string, SocketSink>();
  private reconnectTimers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(
    private games: GameRegistry,
    private services: PartyServices = noopServices,
  ) {}

  onlinePlayers(): PlayerPublic[] {
    return [...this.players.values()].map((c) => c.player!);
  }

  displayConnected() {
    return this.displays.length > 0;
  }

  displayCount() {
    return this.displays.length;
  }

  getPlayerConn(playerId: string) {
    return this.players.get(playerId);
  }

  occupied(playerId: string): boolean {
    if (this.players.has(playerId)) return true;
    const seat = this.seats.get(playerId);
    return !!seat && Date.now() < seat.until;
  }

  occupiedIds(): string[] {
    const ids = new Set(this.players.keys());
    const now = Date.now();
    for (const [id, seat] of this.seats) {
      if (now < seat.until) ids.add(id);
    }
    return [...ids];
  }

  tryClaim(playerId: string, token: string): boolean {
    if (this.players.has(playerId)) return false;
    const seat = this.seats.get(playerId);
    if (seat && Date.now() < seat.until) return false;
    this.seats.set(playerId, { token, until: Date.now() + CLAIM_HOLD_MS });
    this.pushRoster();
    return true;
  }

  attachWatcher(sink: SocketSink): string {
    const id = crypto.randomUUID();
    this.watchers.set(id, sink);
    sink.send({ type: "hello.ok", role: "watcher" });
    sink.send({ type: "roster", onlineIds: this.occupiedIds() });
    return id;
  }

  detachWatcher(id: string) {
    this.watchers.delete(id);
  }

  snapshot(conn: Conn): PartyStateMessage {
    const inGame = conn.role === "display" ? true : conn.inGame;
    return {
      type: "party.state",
      phase: this.phase,
      gameId: this.gameId,
      playMode: this.playMode,
      starterPlayerId: this.starterPlayerId,
      displayConnected: this.displayConnected(),
      displayCount: this.displayCount(),
      online: this.onlinePlayers(),
      view: viewFor(conn, this.phase, this.playMode, inGame && !this.waiting.has(conn.player?.id ?? "")),
      isAuthority: this.isAuthority(conn),
      entries: this.entries,
    };
  }

  isAuthority(conn: Conn): boolean {
    if (this.phase !== "playing" || !this.authority) return false;
    if (this.authority === "starter") return conn.player?.id === this.starterPlayerId;
    return false;
  }

  attachDisplay(sink: SocketSink): Conn {
    const before = this.displays.length;
    const conn: Conn = {
      id: crypto.randomUUID(),
      sink,
      role: "display",
      inGame: this.phase === "playing",
      inputTimes: [],
      logTimes: [],
    };
    this.displays.push(conn);
    conn.sink.send({ type: "hello.ok", role: "display" });
    conn.sink.send(this.snapshot(conn));
    if (this.lastState) conn.sink.send(this.lastState);
    this.noteDisplays(before);
    return conn;
  }

  attachPlayer(player: PlayerPublic, sink: SocketSink, token?: string): AttachPlayerResult {
    const live = this.players.get(player.id) ?? null;
    const seat = this.seats.get(player.id);
    if (live) {
      if (!token || seat?.token !== token) {
        return { ok: false, error: "taken", message: "已经被选走了" };
      }
    } else if (seat && Date.now() < seat.until && token !== seat.token) {
      return { ok: false, error: "taken", message: "已经被选走了" };
    }
    this.cancelReconnect(player.id);
    const conn: Conn = {
      id: crypto.randomUUID(),
      sink,
      role: "player",
      player,
      inGame: false,
      inputTimes: [],
      logTimes: [],
    };
    if (this.phase === "playing") {
      if (live) {
        conn.inGame = live.inGame;
        if (!conn.inGame) this.waiting.add(player.id);
      } else {
        const game = this.games.get(this.gameId!);
        const inCount = [...this.players.values()].filter((p) => p.inGame && p.player?.id !== player.id).length;
        if (game && inCount < game.maxPlayers) {
          conn.inGame = true;
        } else {
          this.waiting.add(player.id);
        }
      }
    }
    this.players.set(player.id, conn);
    if (token) this.seats.set(player.id, { token, until: Date.now() + 24 * 60 * 60 * 1000 });
    if (live) {
      live.sink.send({ type: "player.replaced" });
      live.sink.close();
    }
    conn.sink.send({ type: "hello.ok", role: "player", me: player });
    conn.sink.send(this.snapshot(conn));
    if (!live) {
      this.broadcastAll({ type: "member.online", player }, conn.id);
    }
    this.broadcastAll({ type: "party.state" });
    this.pushRoster();
    if (this.phase === "playing" && conn.inGame && conn.player && !this.serverKnown.has(conn.player.id)) {
      this.serverKnown.add(conn.player.id);
      this.server?.playerJoin(conn.player);
    }
    if (this.phase === "playing" && conn.inGame && this.gameId && this.playMode && this.entries) {
      conn.sink.send({
        type: "party.start",
        gameId: this.gameId,
        playMode: this.playMode,
        starterPlayerId: this.starterPlayerId,
        view: viewFor(conn, this.phase, this.playMode, true),
        isAuthority: this.isAuthority(conn),
        entries: this.entries,
      });
    }
    return { ok: true, conn, replaced: live };
  }

  detach(conn: Conn, dropSeat = false) {
    const displayIndex = this.displays.findIndex((d) => d.id === conn.id);
    if (displayIndex >= 0) {
      const before = this.displays.length;
      this.displays.splice(displayIndex, 1);
      this.noteDisplays(before);
      return;
    }
    if (conn.player && this.players.get(conn.player.id)?.id === conn.id) {
      const playerId = conn.player.id;
      this.players.delete(playerId);
      this.waiting.delete(playerId);
      if (dropSeat) {
        this.releaseSeat(playerId);
        this.broadcastAll({ type: "member.offline", playerId });
        this.broadcastAll({ type: "party.state" });
        return;
      }
      this.holdReconnect(playerId);
      this.pushRoster();
    }
  }

  dropPlayer(playerId: string) {
    const wasStarter =
      this.phase === "playing" &&
      this.authority === "starter" &&
      this.starterPlayerId === playerId;
    const conn = this.players.get(playerId);
    if (conn) {
      conn.sink.send({ type: "player.kicked" });
      conn.sink.close();
      this.detach(conn, true);
    } else {
      this.releaseSeat(playerId);
    }
    if (wasStarter) this.endParty();
  }

  private holdReconnect(playerId: string) {
    this.cancelReconnect(playerId);
    const existing = this.seats.get(playerId);
    if (existing?.token) {
      this.seats.set(playerId, { token: existing.token, until: Date.now() + RECONNECT_HOLD_MS });
    }
    this.reconnectTimers.set(
      playerId,
      setTimeout(() => {
        this.reconnectTimers.delete(playerId);
        if (this.players.has(playerId)) return;
        const wasStarter =
          this.phase === "playing" &&
          this.authority === "starter" &&
          this.starterPlayerId === playerId;
        this.releaseSeat(playerId);
        this.broadcastAll({ type: "member.offline", playerId });
        if (wasStarter) this.endParty();
        else this.broadcastAll({ type: "party.state" });
      }, RECONNECT_HOLD_MS),
    );
  }

  private cancelReconnect(playerId: string) {
    const timer = this.reconnectTimers.get(playerId);
    if (timer) clearTimeout(timer);
    this.reconnectTimers.delete(playerId);
  }

  private releaseSeat(playerId: string) {
    this.cancelReconnect(playerId);
    this.seats.delete(playerId);
    this.pushRoster();
    if (this.serverKnown.delete(playerId)) this.server?.playerLeave(playerId);
  }

  start(gameId: string, starterPlayerId: string): StartError | { ok: true; game: GameInfo } {
    if (this.phase !== "idle") {
      return { error: "not_idle", message: "已经在玩一局了" };
    }
    const game = this.games.get(gameId);
    if (!game) return { error: "game_not_found", message: "找不到这个游戏" };
    if (game.broken) return { error: "game_broken", message: game.error ?? "游戏包损坏" };
    const script = game.hasServer ? this.games.serverScript(game.id) : null;
    if (game.hasServer && !script) {
      return { error: "game_broken", message: "找不到主机脚本" };
    }
    const n = this.players.size;
    if (n < game.minPlayers) {
      return { error: "too_few", message: `人数不够（最少 ${game.minPlayers} 人）` };
    }
    if (n > game.maxPlayers) {
      return { error: "too_many", message: `人太多了（最多 ${game.maxPlayers} 人）` };
    }
    if ((game.playMode === "shared-screen" || game.playMode === "hybrid") && !this.displayConnected()) {
      return { error: "need_display", message: "请打开电视" };
    }
    if (!this.players.has(starterPlayerId)) {
      return { error: "not_online", message: "发起者不在线" };
    }

    this.phase = "playing";
    this.gameId = game.id;
    this.playMode = game.playMode;
    this.starterPlayerId = starterPlayerId;
    this.authority = pickAuthority(game.playMode, game.hasServer);
    this.entries = game.entries;
    this.waiting.clear();
    for (const conn of this.players.values()) conn.inGame = true;
    for (const display of this.displays) display.inGame = true;

    if (script) {
      const playing = this.playingPlayers();
      try {
        this.server = new GameServer(script, playing, game.tickHz, this.displayConnected(), {
          onPushDisplay: (state) => this.pushServerState(state),
          onPushController: (playerId, payload) => this.pushServerController(playerId, payload),
          onBroadcastPlayers: (payload) => this.broadcastServerPlayers(payload),
          onEnd: () => this.endFromServer(),
          onCrash: (message) => this.crashFromServer(message),
          onLog: (level, message, data) => this.logFromServer(level, message, data),
          onSave: (op, playerId, key, value) => this.saveFromServer(op, playerId, key, value),
        });
        for (const player of playing) this.serverKnown.add(player.id);
      } catch (err) {
        this.abortStart();
        const message = err instanceof Error ? err.message : "主机脚本没能启动";
        return { error: "server_crash", message };
      }
    }

    this.broadcastStart(game);
    this.broadcastAll({ type: "party.state" });
    return { ok: true, game };
  }

  endParty() {
    this.server?.stop();
    this.server = null;
    this.serverKnown.clear();
    this.lastState = null;
    this.phase = "idle";
    this.gameId = null;
    this.playMode = null;
    this.starterPlayerId = null;
    this.authority = null;
    this.entries = null;
    this.waiting.clear();
    for (const conn of this.players.values()) conn.inGame = false;
    for (const display of this.displays) display.inGame = false;
    this.broadcastAll({ type: "party.end" });
    this.broadcastAll({ type: "party.state" });
  }

  private playingPlayers(): PlayerPublic[] {
    return [...this.players.values()].filter((c) => c.inGame && c.player).map((c) => c.player!);
  }

  private abortStart() {
    this.server?.stop();
    this.server = null;
    this.serverKnown.clear();
    this.lastState = null;
    this.phase = "idle";
    this.gameId = null;
    this.playMode = null;
    this.starterPlayerId = null;
    this.authority = null;
    this.entries = null;
    this.waiting.clear();
    for (const conn of this.players.values()) conn.inGame = false;
    for (const display of this.displays) display.inGame = false;
  }

  private endFromServer() {
    if (this.phase !== "playing" || this.authority !== "host") return;
    this.services.log({
      level: "info",
      source: "server",
      gameId: this.gameId,
      message: "主机脚本结束了这一局",
    });
    this.endParty();
  }

  private crashFromServer(message: string) {
    if (this.phase !== "playing" || this.authority !== "host") return;
    this.services.log({ level: "error", source: "server", gameId: this.gameId, message });
    this.broadcastAll({
      type: "error",
      error: "game_server_crash",
      message: "这局的主机脚本出错了，回到大厅",
    });
    this.endParty();
  }

  private logFromServer(level: string, message: string, data?: unknown) {
    const known = level === "debug" || level === "info" || level === "warn" || level === "error";
    this.services.log({
      level: known ? level : "info",
      source: "server",
      gameId: this.gameId,
      message,
      data,
    });
  }

  private saveFromServer(op: "get" | "set", playerId: string, key: string, value: unknown) {
    if (!this.gameId || !key) return { ok: false as const, message: "缺少存档键" };
    if (op === "get") return { ok: true as const, value: this.services.readSave(this.gameId, playerId, key) };
    const err = this.services.writeSave(this.gameId, playerId, key, value);
    if (err) return { ok: false as const, message: err };
    return { ok: true as const };
  }

  private pushServerState(state: unknown) {
    if (this.phase !== "playing" || !this.fits(state)) return;
    this.fanoutState(state);
  }

  private pushServerController(playerId: string, payload: unknown) {
    if (this.phase !== "playing" || !this.fits(payload)) return;
    const conn = this.players.get(playerId);
    if (conn?.inGame) conn.sink.send({ type: "game", payload });
  }

  private broadcastServerPlayers(payload: unknown) {
    if (this.phase !== "playing" || !this.fits(payload)) return;
    const msg = { type: "game", payload };
    for (const conn of this.players.values()) {
      if (conn.inGame) conn.sink.send(msg);
    }
  }

  private fits(value: unknown): boolean {
    try {
      return utf8Bytes(value) <= MAX_GAME_MESSAGE_BYTES;
    } catch {
      return false;
    }
  }

  handleGame(from: Conn, to: SendTo, payload: unknown): StartError | null {
    if (utf8Bytes(payload) > MAX_GAME_MESSAGE_BYTES) {
      return { error: "too_large", message: "消息太大" };
    }
    if (this.authority === "host") {
      if (from.player) this.server?.message(from.player.id, payload);
      return null;
    }
    const msg = { type: "game", from: from.player?.id, payload };
    if (to === "all") {
      this.forEachConn((c) => c.id !== from.id && c.sink.send(msg));
    } else if (to === "display") {
      for (const display of this.displays) display.sink.send(msg);
    } else if (to === "players") {
      for (const c of this.players.values()) if (c.id !== from.id) c.sink.send(msg);
    } else if (to && typeof to === "object" && "playerId" in to) {
      this.players.get(to.playerId)?.sink.send(msg);
    } else {
      return { error: "bad_to", message: "不知道发给谁" };
    }
    return null;
  }

  handleInput(from: Conn, payload: unknown): StartError | null {
    if (from.role !== "player" || !from.player) {
      return { error: "forbidden", message: "只有玩家能发按键" };
    }
    if (this.phase !== "playing") return { error: "not_playing", message: "现在没有在玩" };
    if (!from.inGame) return { error: "waiting", message: "这局已经满了" };
    if (utf8Bytes(payload) > MAX_INPUT_BYTES) {
      return { error: "too_large", message: "按键数据太大" };
    }
    const now = Date.now();
    from.inputTimes = from.inputTimes.filter((t) => now - t < 1000);
    if (from.inputTimes.length >= MAX_INPUT_HZ) {
      return { error: "rate_limited", message: "按键太快了" };
    }
    from.inputTimes.push(now);
    if (this.authority === "host") {
      this.server?.input(from.player.id, payload);
      return null;
    }
    const msg = { type: "input", playerId: from.player.id, payload };
    const target = this.authorityConn();
    if (target) target.sink.send(msg);
    return null;
  }

  handleState(from: Conn, payload: unknown): StartError | null {
    if (this.authority !== "starter" || !this.isAuthority(from)) {
      return { error: "forbidden", message: "只有负责计算的玩家能发画面快照" };
    }
    if (utf8Bytes(payload) > MAX_GAME_MESSAGE_BYTES) {
      return { error: "too_large", message: "快照太大" };
    }
    this.fanoutState(payload);
    const msg = { type: "state", payload };
    for (const c of this.players.values()) {
      if (c.inGame && c.id !== from.id) c.sink.send(msg);
    }
    return null;
  }

  private authorityConn(): Conn | null {
    if (this.authority === "starter" && this.starterPlayerId) {
      return this.players.get(this.starterPlayerId) ?? null;
    }
    return null;
  }

  private broadcastStart(game: GameInfo) {
    for (const conn of this.allConns()) {
      const inGame = conn.role === "display" || conn.inGame;
      conn.sink.send({
        type: "party.start",
        gameId: game.id,
        playMode: game.playMode,
        starterPlayerId: this.starterPlayerId,
        view: viewFor(conn, this.phase, this.playMode, inGame),
        isAuthority: this.isAuthority(conn),
        entries: game.entries,
      });
    }
  }

  broadcastAll(msg: object, exceptId?: string) {
    for (const conn of this.allConns()) {
      if (exceptId && conn.id === exceptId) continue;
      if (msg && (msg as { type?: string }).type === "party.state") {
        conn.sink.send(this.snapshot(conn));
      } else {
        conn.sink.send(msg);
      }
    }
  }

  private broadcastPlayers(msg: object) {
    for (const conn of this.players.values()) conn.sink.send(msg);
  }

  pushRoster() {
    const msg = { type: "roster", onlineIds: this.occupiedIds() };
    for (const sink of this.watchers.values()) sink.send(msg);
  }

  private allConns(): Conn[] {
    const list = [...this.players.values()];
    list.push(...this.displays);
    return list;
  }

  private noteDisplays(before: number) {
    const after = this.displays.length;
    if (before === 0 && after > 0) {
      this.broadcastPlayers({ type: "display.ready" });
      if (this.phase === "playing" && this.authority === "host") this.server?.display(true);
    } else if (before > 0 && after === 0) {
      this.broadcastPlayers({ type: "display.gone" });
      if (this.phase === "playing" && this.authority === "host") this.server?.display(false);
    }
    this.broadcastAll({ type: "party.state" });
  }

  private fanoutState(payload: unknown) {
    const msg = { type: "state" as const, payload };
    this.lastState = msg;
    for (const display of this.displays) display.sink.send(msg);
  }

  private forEachConn(fn: (c: Conn) => void) {
    for (const c of this.allConns()) fn(c);
  }
}

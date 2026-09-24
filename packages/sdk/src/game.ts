import {
  SESSION_GAME_ID,
  SESSION_ROLE,
  SESSION_TOKEN,
  STORAGE_ME,
  STORAGE_TOKEN,
  type PageRole,
  type PartyStateMessage,
  type PlayerPublic,
  type SaveScope,
  type SendTo,
  type WsServerMessage,
} from "@family/protocol";
import { attachGameMenu } from "./menu";
import { attachPad } from "./pad";

export type { PageRole, PlayerPublic, SendTo };
export type { PadButton, PadInput, PadSpec, PadStick } from "@family/protocol";
export type { PadHandle, PadOptions } from "./pad";
export { attachPad };

type Handler<T> = (arg: T) => void;

class Emitter {
  private map = new Map<string, Set<Handler<any>>>();

  on(event: string, fn: Handler<any>) {
    let set = this.map.get(event);
    if (!set) {
      set = new Set();
      this.map.set(event, set);
    }
    set.add(fn);
    return () => this.off(event, fn);
  }

  off(event: string, fn: Handler<any>) {
    this.map.get(event)?.delete(fn);
  }

  emit(event: string, arg?: unknown) {
    for (const fn of this.map.get(event) ?? []) fn(arg);
  }
}

function wsUrl() {
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${location.host}/ws`;
}

function readSession() {
  const role = (sessionStorage.getItem(SESSION_ROLE) ?? "player") as PageRole;
  const gameId = sessionStorage.getItem(SESSION_GAME_ID) ?? "";
  const token =
    sessionStorage.getItem(SESSION_TOKEN) ?? localStorage.getItem(STORAGE_TOKEN) ?? "";
  return { role, gameId, token };
}

async function saveRequest(gameId: string, token: string, scope: SaveScope, key: string, value?: unknown) {
  const headers: Record<string, string> = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (value !== undefined) headers["Content-Type"] = "application/json";
  const url = `/api/saves/${encodeURIComponent(gameId)}?scope=${scope}&key=${encodeURIComponent(key)}`;
  if (value === undefined) {
    const res = await fetch(url, { headers });
    if (res.status === 404) return undefined;
    if (!res.ok) throw new Error("存档读取失败");
    const data = (await res.json()) as { value: unknown };
    return data.value;
  }
  const res = await fetch(url, {
    method: "PUT",
    headers,
    body: JSON.stringify({ scope, key, value }),
  });
  if (!res.ok) throw new Error("存档写入失败");
}

export type GameSession = {
  role: PageRole;
  me?: PlayerPublic;
  players: PlayerPublic[];
  starterId: string | null;
  gameId: string;
  playMode: "personal" | "shared-screen" | "hybrid";
  isAuthority: boolean;
  /** 此刻是否有大屏（电视 / 本机当大屏）连着 */
  displayConnected: boolean;
  send(to: SendTo, payload: unknown): void;
  broadcast(payload: unknown): void;
  sendInput(payload: unknown): void;
  sendState(payload: unknown): void;
  save: {
    get(key: string): Promise<unknown>;
    set(key: string, value: unknown): Promise<void>;
    getShared(key: string): Promise<unknown>;
    setShared(key: string, value: unknown): Promise<void>;
  };
    end(): void;
    log: {
      debug(message: string, data?: unknown): void;
      info(message: string, data?: unknown): void;
      warn(message: string, data?: unknown): void;
      error(message: string, data?: unknown): void;
    };
    on(event: "players", fn: (players: PlayerPublic[]) => void): () => void;
  on(event: "message", fn: (msg: { from?: string; payload: unknown }) => void): () => void;
  on(event: "input", fn: (msg: { playerId: string; payload: unknown }) => void): () => void;
  on(event: "state", fn: (payload: unknown) => void): () => void;
  on(event: "end", fn: () => void): () => void;
  on(event: "displayGone" | "displayReady", fn: () => void): () => void;
};

export type ConnectGameOptions = {
  /** 默认在玩家页 / 手柄页显示外壳退出菜单。电视画面不加。 */
  shellMenu?: boolean;
};

export async function connectGame(opts: ConnectGameOptions = {}): Promise<GameSession> {
  const { role, gameId, token } = readSession();
  const socket = new WebSocket(wsUrl());
  const events = new Emitter();
  let me: PlayerPublic | undefined;
  let players: PlayerPublic[] = [];
  let starterId: string | null = null;
  let playMode: GameSession["playMode"] = "personal";
  let isAuthority = false;
  let displayConnected = false;
  let openedOnce = false;
  let ready!: (session: GameSession) => void;
  let fail!: (err: Error) => void;
  const opened = new Promise<GameSession>((resolve, reject) => {
    ready = resolve;
    fail = reject;
  });

  function sendJson(msg: object) {
    if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(msg));
  }

  function setDisplayConnected(next: boolean, emit: boolean) {
    if (displayConnected === next) return;
    displayConnected = next;
    session.displayConnected = next;
    if (emit) events.emit(next ? "displayReady" : "displayGone");
  }

  function applyState(msg: PartyStateMessage) {
    players = msg.online;
    starterId = msg.starterPlayerId;
    playMode = (msg.playMode ?? playMode) as GameSession["playMode"];
    isAuthority = msg.isAuthority;
    session.players = players;
    session.starterId = starterId;
    session.playMode = playMode;
    session.isAuthority = isAuthority;
    setDisplayConnected(msg.displayConnected, openedOnce);
    events.emit("players", players);
    if (msg.phase === "idle") {
      events.emit("end");
      location.href = role === "display" ? "/screen" : "/";
    }
  }

  const session: GameSession = {
    role,
    get me() {
      return me;
    },
    players,
    starterId,
    gameId,
    playMode,
    isAuthority,
    displayConnected,
    send(to, payload) {
      sendJson({ type: "game", to, payload });
    },
    broadcast(payload) {
      sendJson({ type: "game", to: "all", payload });
    },
    sendInput(payload) {
      sendJson({ type: "input", payload });
    },
    sendState(payload) {
      sendJson({ type: "state", payload });
    },
    save: {
      get: (key) => saveRequest(gameId, token, "private", key),
      set: async (key, value) => {
        await saveRequest(gameId, token, "private", key, value);
      },
      getShared: (key) => saveRequest(gameId, token, "shared", key),
      setShared: async (key, value) => {
        await saveRequest(gameId, token, "shared", key, value);
      },
    },
    end() {
      sendJson({ type: "party.end" });
    },
    log: {
      debug(message, data) {
        sendLog("debug", message, data);
      },
      info(message, data) {
        sendLog("info", message, data);
      },
      warn(message, data) {
        sendLog("warn", message, data);
      },
      error(message, data) {
        sendLog("error", message, data);
      },
    },
    on(event, fn) {
      return events.on(event, fn);
    },
  };

  function sendLog(level: "debug" | "info" | "warn" | "error", message: string, data?: unknown) {
    sendJson({ type: "log", level, message, data });
  }

  function attachWindowErrors() {
    window.addEventListener("error", (ev) => {
      const file = ev.filename ? ` @ ${ev.filename}:${ev.lineno}` : "";
      sendLog("error", `${ev.message || "未捕获错误"}${file}`);
    });
    window.addEventListener("unhandledrejection", (ev) => {
      const reason = ev.reason instanceof Error ? ev.reason.message : String(ev.reason);
      sendLog("error", `未处理的 Promise：${reason}`);
    });
  }

  socket.addEventListener("open", () => {
    if (role === "display") sendJson({ type: "hello", role: "display" });
    else sendJson({ type: "hello", role: "player", token });
  });

  socket.addEventListener("message", (ev) => {
    let msg: WsServerMessage;
    try {
      msg = JSON.parse(String(ev.data)) as WsServerMessage;
    } catch {
      return;
    }
    if (msg.type === "hello.ok") {
      if (msg.role === "player") me = msg.me;
      return;
    }
    if (msg.type === "hello.err") {
      fail(new Error(msg.message));
      socket.close();
      return;
    }
    if (msg.type === "player.replaced") {
      socket.close();
      return;
    }
    if (msg.type === "player.kicked" || msg.type === "display.replaced") {
      if (msg.type === "player.kicked") {
        localStorage.removeItem(STORAGE_TOKEN);
        localStorage.removeItem(STORAGE_ME);
        sessionStorage.removeItem(SESSION_TOKEN);
      }
      location.href = role === "display" ? "/screen" : "/";
      return;
    }
    if (msg.type === "party.state") {
      applyState(msg);
      if (!openedOnce) {
        openedOnce = true;
        attachWindowErrors();
        sendLog("info", "游戏页已连上", { role, isAuthority: session.isAuthority, gameId });
        if (opts.shellMenu !== false) attachGameMenu({ role, end: () => session.end() });
      }
      ready(session);
      return;
    }
    if (msg.type === "party.start") {
      isAuthority = msg.isAuthority;
      session.isAuthority = isAuthority;
      playMode = msg.playMode;
      session.playMode = playMode;
      starterId = msg.starterPlayerId;
      session.starterId = starterId;
      return;
    }
    if (msg.type === "party.end") {
      events.emit("end");
      location.href = role === "display" ? "/screen" : "/";
      return;
    }
    if (msg.type === "member.online" || msg.type === "member.offline") {
      return;
    }
    if (msg.type === "display.gone") setDisplayConnected(false, true);
    if (msg.type === "display.ready") setDisplayConnected(true, true);
    if (msg.type === "game") events.emit("message", { from: msg.from, payload: msg.payload });
    if (msg.type === "input") events.emit("input", { playerId: msg.playerId, payload: msg.payload });
    if (msg.type === "state") events.emit("state", msg.payload);
  });

  socket.addEventListener("close", () => {
    fail(new Error("连接已断开"));
  });

  const timer = setTimeout(() => fail(new Error("连接超时")), 8000);
  try {
    const result = await opened;
    clearTimeout(timer);
    return result;
  } catch (err) {
    clearTimeout(timer);
    throw err;
  }
}

type Player = { id: string; name: string; color: string };

type Hooks = {
  onStart?: (ctx: ServerCtx) => void | Promise<void>;
  onInput?: (playerId: string, payload: unknown, ctx: ServerCtx) => void;
  onMessage?: (fromPlayerId: string, payload: unknown, ctx: ServerCtx) => void;
  onTick?: (dtMs: number, ctx: ServerCtx) => void;
  onPlayerJoin?: (player: Player, ctx: ServerCtx) => void;
  onPlayerLeave?: (playerId: string, ctx: ServerCtx) => void;
  onDisplay?: (connected: boolean, ctx: ServerCtx) => void;
  onStop?: () => void;
};

type ServerCtx = {
  readonly players: Player[];
  readonly displayConnected: boolean;
  pushDisplay(state: unknown): void;
  pushController(playerId: string, payload: unknown): void;
  broadcastPlayers(payload: unknown): void;
  save: {
    get(playerId: string, key: string): Promise<unknown>;
    set(playerId: string, key: string, value: unknown): Promise<void>;
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
};

type SaveWait = { resolve: (value: unknown) => void; reject: (err: Error) => void };

let hooks: Hooks = {};
let players: Player[] = [];
let displayConnected = false;
let ready = false;
let stopped = false;
let timer: ReturnType<typeof setInterval> | undefined;
let lastTick = Date.now();
let saveSeq = 0;
const saveWait = new Map<number, SaveWait>();
const pending: Array<() => void> = [];

function post(msg: object) {
  postMessage(msg);
}

function crash(message: string) {
  if (stopped) return;
  stopped = true;
  if (timer) clearInterval(timer);
  post({ type: "crash", message });
}

const ctx: ServerCtx = {
  get players() {
    return players;
  },
  get displayConnected() {
    return displayConnected;
  },
  pushDisplay(state) {
    if (!stopped) post({ type: "pushDisplay", state });
  },
  pushController(playerId, payload) {
    if (!stopped) post({ type: "pushController", playerId, payload });
  },
  broadcastPlayers(payload) {
    if (!stopped) post({ type: "broadcastPlayers", payload });
  },
  save: {
    get: (playerId, key) => saveCall("get", playerId, key),
    set: async (playerId, key, value) => {
      await saveCall("set", playerId, key, value);
    },
    getShared: (key) => saveCall("get", "", key),
    setShared: async (key, value) => {
      await saveCall("set", "", key, value);
    },
  },
  end() {
    if (stopped) return;
    finish();
    post({ type: "end" });
  },
  log: {
    debug: (message, data) => log("debug", message, data),
    info: (message, data) => log("info", message, data),
    warn: (message, data) => log("warn", message, data),
    error: (message, data) => log("error", message, data),
  },
};

function log(level: string, message: string, data?: unknown) {
  if (stopped) return;
  post({ type: "log", level, message, data });
}

function saveCall(op: "get" | "set", playerId: string, key: string, value?: unknown) {
  const id = ++saveSeq;
  return new Promise((resolve, reject) => {
    saveWait.set(id, { resolve, reject });
    post({ type: "save", id, op, playerId, key, value });
  });
}

function run(fn: () => void) {
  if (stopped) return;
  if (!ready) pending.push(fn);
  else fn();
}

function callHook(fn: () => void) {
  try {
    fn();
  } catch (err) {
    crash(err instanceof Error ? err.message : String(err));
  }
}

function finish() {
  if (stopped) return;
  stopped = true;
  if (timer) clearInterval(timer);
  try {
    hooks.onStop?.();
  } catch {
    /* 结束时的钩子失败不再另开一局 */
  }
}

function startTicks(hz: number) {
  const capped = Math.min(60, Math.max(0, Math.round(hz) || 0));
  if (capped < 1) return;
  const interval = Math.round(1000 / capped);
  lastTick = Date.now();
  timer = setInterval(() => {
    if (stopped || !hooks.onTick) return;
    const now = Date.now();
    const dt = Math.min(100, Math.max(0, now - lastTick));
    lastTick = now;
    callHook(() => hooks.onTick!(dt, ctx));
  }, interval);
}

async function boot(scriptPath: string, tickHz: number) {
  try {
    const mod = (await import(scriptPath)) as { default?: Hooks };
    hooks = mod.default ?? {};
    await hooks.onStart?.(ctx);
  } catch (err) {
    crash(err instanceof Error ? err.message : String(err));
    return;
  }
  if (stopped) return;
  ready = true;
  const queued = pending.splice(0);
  for (const fn of queued) callHook(fn);
  startTicks(tickHz);
}

self.onmessage = (event: MessageEvent) => {
  const msg = event.data as {
    type?: string;
    scriptPath?: string;
    players?: Player[];
    tickHz?: number;
    displayConnected?: boolean;
    playerId?: string;
    payload?: unknown;
    player?: Player;
    connected?: boolean;
    id?: number;
    ok?: boolean;
    value?: unknown;
    message?: string;
  };
  if (!msg || typeof msg !== "object") return;
  if (msg.type === "saveResult") {
    const wait = msg.id !== undefined ? saveWait.get(msg.id) : undefined;
    if (!wait || msg.id === undefined) return;
    saveWait.delete(msg.id);
    if (msg.ok) wait.resolve(msg.value);
    else wait.reject(new Error(msg.message || "存档失败"));
    return;
  }
  if (stopped) return;
  if (msg.type === "load") {
    players = msg.players ?? [];
    displayConnected = !!msg.displayConnected;
    const scriptPath = msg.scriptPath ?? "";
    void boot(scriptPath, msg.tickHz ?? 20);
    return;
  }
  if (msg.type === "stop") {
    finish();
    return;
  }
  if (msg.type === "input" && msg.playerId) {
    const playerId = msg.playerId;
    const payload = msg.payload;
    run(() => hooks.onInput?.(playerId, payload, ctx));
    return;
  }
  if (msg.type === "message" && msg.playerId) {
    const playerId = msg.playerId;
    const payload = msg.payload;
    run(() => hooks.onMessage?.(playerId, payload, ctx));
    return;
  }
  if (msg.type === "join" && msg.player) {
    const player = msg.player;
    if (players.some((p) => p.id === player.id)) return;
    players = [...players, player];
    run(() => hooks.onPlayerJoin?.(player, ctx));
    return;
  }
  if (msg.type === "leave" && msg.playerId) {
    const playerId = msg.playerId;
    players = players.filter((p) => p.id !== playerId);
    run(() => hooks.onPlayerLeave?.(playerId, ctx));
    return;
  }
  if (msg.type === "display") {
    displayConnected = !!msg.connected;
    const connected = displayConnected;
    run(() => hooks.onDisplay?.(connected, ctx));
  }
};

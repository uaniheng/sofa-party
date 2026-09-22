import {
  SESSION_GAME_ID,
  SESSION_ROLE,
  SESSION_TOKEN,
  STORAGE_TOKEN,
  type GameEntries,
  type PartyStateMessage,
  type PlayerPublic,
  type View,
  type WsServerMessage,
} from "@family/protocol";

export function enterGame(
  view: View,
  gameId: string | null,
  entries: GameEntries | null,
  token: string,
) {
  if (!gameId || !entries) return false;
  if (!view.startsWith("game-")) return false;
  const role = view === "game-display" ? "display" : view === "game-controller" ? "controller" : "player";
  const url =
    view === "game-display" ? entries.display : view === "game-controller" ? entries.controller : entries.player;
  if (!url) return false;
  sessionStorage.setItem(SESSION_ROLE, role);
  sessionStorage.setItem(SESSION_GAME_ID, gameId);
  if (token) {
    sessionStorage.setItem(SESSION_TOKEN, token);
    localStorage.setItem(STORAGE_TOKEN, token);
  }
  location.assign(url);
  return true;
}

export function connectShell(opts: {
  role: "player" | "display";
  token?: string;
  onState: (msg: PartyStateMessage) => void;
  onError: (message: string) => void;
  onKicked: () => void;
  onHello?: (me?: PlayerPublic) => void;
}) {
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  const ws = new WebSocket(`${proto}//${location.host}/ws`);
  let closedByUs = false;
  let replaced = false;

  function send(msg: object) {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
  }

  ws.addEventListener("open", () => {
    if (opts.role === "display") send({ type: "hello", role: "display" });
    else send({ type: "hello", role: "player", token: opts.token });
  });

  ws.addEventListener("message", (ev) => {
    let msg: WsServerMessage;
    try {
      msg = JSON.parse(String(ev.data)) as WsServerMessage;
    } catch {
      return;
    }
    if (msg.type === "hello.ok") {
      opts.onHello?.(msg.role === "player" ? msg.me : undefined);
      return;
    }
    if (msg.type === "hello.err") {
      if (msg.error === "taken" || msg.error === "bad_token") opts.onKicked();
      opts.onError(msg.message);
      return;
    }
    if (msg.type === "player.replaced") {
      replaced = true;
      return;
    }
    if (msg.type === "player.kicked" || msg.type === "display.replaced") {
      opts.onKicked();
      return;
    }
    if (msg.type === "party.state") {
      opts.onState(msg);
      const token = opts.token ?? localStorage.getItem(STORAGE_TOKEN) ?? "";
      enterGame(msg.view, msg.gameId, msg.entries, token);
      return;
    }
    if (msg.type === "party.start") {
      const token = opts.token ?? localStorage.getItem(STORAGE_TOKEN) ?? "";
      enterGame(msg.view, msg.gameId, msg.entries, token);
      return;
    }
    if (msg.type === "error") opts.onError(msg.message);
  });

  ws.addEventListener("close", () => {
    if (!closedByUs && !replaced) opts.onError("连接断开了");
  });

  return {
    start(gameId: string) {
      send({ type: "party.start", gameId });
    },
    end() {
      send({ type: "party.end" });
    },
    close() {
      closedByUs = true;
      ws.close();
    },
  };
}

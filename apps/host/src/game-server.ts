import { pathToFileURL } from "node:url";
import type { PlayerPublic } from "@family/protocol";

export type GameServerHandlers = {
  onPushDisplay(state: unknown): void;
  onPushController(playerId: string, payload: unknown): void;
  onBroadcastPlayers(payload: unknown): void;
  onEnd(): void;
  onCrash(message: string): void;
  onLog(level: string, message: string, data?: unknown): void;
  onSave(
    op: "get" | "set",
    playerId: string,
    key: string,
    value: unknown,
  ): { ok: true; value?: unknown } | { ok: false; message: string };
};

export class GameServer {
  private worker: Worker;
  private closed = false;

  constructor(
    scriptPath: string,
    players: PlayerPublic[],
    tickHz: number,
    displayConnected: boolean,
    private handlers: GameServerHandlers,
  ) {
    this.worker = new Worker(new URL("./server-loader.ts", import.meta.url).href, { smol: true });
    this.worker.onmessage = (event: MessageEvent) => this.onMessage(event.data);
    this.worker.onerror = (event) => {
      event.preventDefault?.();
      this.fail(event.message || "主机脚本出错了");
    };
    this.worker.postMessage({
      type: "load",
      scriptPath: pathToFileURL(scriptPath).href,
      players,
      tickHz,
      displayConnected,
    });
  }

  input(playerId: string, payload: unknown) {
    this.send({ type: "input", playerId, payload });
  }

  message(playerId: string, payload: unknown) {
    this.send({ type: "message", playerId, payload });
  }

  playerJoin(player: PlayerPublic) {
    this.send({ type: "join", player });
  }

  playerLeave(playerId: string) {
    this.send({ type: "leave", playerId });
  }

  display(connected: boolean) {
    this.send({ type: "display", connected });
  }

  stop() {
    if (this.closed) return;
    this.closed = true;
    try {
      this.worker.postMessage({ type: "stop" });
    } catch {
      /* 线程已经退出 */
    }
    const worker = this.worker;
    setTimeout(() => {
      try {
        worker.terminate();
      } catch {
        /* 已经结束 */
      }
    }, 200);
  }

  private send(msg: object) {
    if (this.closed) return;
    this.worker.postMessage(msg);
  }

  private fail(message: string) {
    if (this.closed) return;
    this.closed = true;
    try {
      this.worker.terminate();
    } catch {
      /* 已经结束 */
    }
    this.handlers.onCrash(message);
  }

  private onMessage(data: unknown) {
    if (!data || typeof data !== "object") return;
    const msg = data as {
      type?: string;
      state?: unknown;
      playerId?: string;
      payload?: unknown;
      level?: string;
      message?: string;
      data?: unknown;
      id?: number;
      op?: "get" | "set";
      key?: string;
      value?: unknown;
    };
    if (this.closed && msg.type !== "save") return;
    if (msg.type === "pushDisplay") this.handlers.onPushDisplay(msg.state);
    else if (msg.type === "pushController" && msg.playerId) {
      this.handlers.onPushController(msg.playerId, msg.payload);
    } else if (msg.type === "broadcastPlayers") this.handlers.onBroadcastPlayers(msg.payload);
    else if (msg.type === "end") this.handlers.onEnd();
    else if (msg.type === "crash") this.fail(msg.message || "主机脚本出错了");
    else if (msg.type === "log") this.handlers.onLog(msg.level || "info", msg.message || "", msg.data);
    else if (msg.type === "save" && msg.id !== undefined && msg.op && msg.key !== undefined) {
      const result = this.handlers.onSave(msg.op, msg.playerId ?? "", msg.key, msg.value);
      try {
        this.worker.postMessage({ type: "saveResult", id: msg.id, ...result });
      } catch {
        /* 线程已经退出 */
      }
    }
  }
}

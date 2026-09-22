import type { Hono } from "hono";
import { upgradeWebSocket } from "hono/bun";
import type { WSContext } from "hono/ws";
import type { WsClientMessage } from "@family/protocol";
import { playerIdByToken, getPlayer } from "./db";
import type { HostApp } from "./host";
import type { Conn, SocketSink } from "./party";

function sinkOf(ws: WSContext): SocketSink {
  return {
    send(msg) {
      try {
        ws.send(JSON.stringify(msg));
      } catch {
        /* closed */
      }
    },
    close() {
      try {
        ws.close();
      } catch {
        /* closed */
      }
    },
  };
}

export function registerWs(app: Hono, host: HostApp) {
  app.get(
    "/ws",
    upgradeWebSocket(() => {
      let conn: Conn | null = null;
      let watcherId: string | null = null;
      let helloTimer: ReturnType<typeof setTimeout> | undefined;
      return {
        onOpen(_evt, ws) {
          helloTimer = setTimeout(() => {
            if (!conn && !watcherId) {
              ws.send(JSON.stringify({ type: "hello.err", error: "timeout", message: "没有握手" }));
              ws.close();
            }
          }, 5000);
        },
        onMessage(evt, ws) {
          let msg: WsClientMessage;
          try {
            msg = JSON.parse(String(evt.data)) as WsClientMessage;
          } catch {
            ws.send(JSON.stringify({ type: "error", error: "bad_json", message: "消息不是 JSON" }));
            return;
          }
          if (!conn && !watcherId) {
            if (msg.type !== "hello") {
              ws.send(
                JSON.stringify({ type: "hello.err", error: "need_hello", message: "请先握手" }),
              );
              ws.close();
              return;
            }
            if (helloTimer) clearTimeout(helloTimer);
            if (msg.role === "watcher") {
              watcherId = host.party.attachWatcher(sinkOf(ws));
              return;
            }
            if (msg.role === "display") {
              conn = host.party.attachDisplay(sinkOf(ws));
              return;
            }
            if (msg.role !== "player" || !msg.token) {
              ws.send(
                JSON.stringify({ type: "hello.err", error: "bad_role", message: "身份不对" }),
              );
              ws.close();
              return;
            }
            const playerId = playerIdByToken(host.db, msg.token);
            const player = playerId ? getPlayer(host.db, playerId) : undefined;
            if (!player) {
              ws.send(
                JSON.stringify({ type: "hello.err", error: "bad_token", message: "凭证无效，请重新选人" }),
              );
              ws.close();
              return;
            }
            const joined = host.party.attachPlayer(
              { id: player.id, name: player.name, color: player.color },
              sinkOf(ws),
              msg.token,
            );
            if (!joined.ok) {
              ws.send(JSON.stringify({ type: "hello.err", error: joined.error, message: joined.message }));
              ws.close();
              return;
            }
            conn = joined.conn;
            return;
          }
          if (watcherId) return;
          if (!conn) return;

          if (msg.type === "party.start") {
            if (conn.role !== "player" || !conn.player) {
              conn.sink.send({ type: "error", error: "forbidden", message: "只有玩家可以开始" });
              return;
            }
            const result = host.party.start(msg.gameId, conn.player.id);
            if ("error" in result) {
              host.logs.write({
                level: "warn",
                source: "host",
                gameId: msg.gameId,
                playerId: conn.player.id,
                playerName: conn.player.name,
                message: `无法开始：${result.message}`,
              });
              conn.sink.send({ type: "error", ...result });
            } else {
              host.logs.write({
                level: "info",
                source: "host",
                gameId: result.game.id,
                playerId: conn.player.id,
                playerName: conn.player.name,
                message: `开始「${result.game.name}」`,
              });
            }
            return;
          }
          if (msg.type === "party.end") {
            if (conn.role !== "player") {
              conn.sink.send({ type: "error", error: "forbidden", message: "只有玩家可以结束" });
              return;
            }
            const gameId = host.party.gameId;
            host.party.endParty();
            host.logs.write({
              level: "info",
              source: "host",
              gameId,
              playerId: conn.player?.id,
              playerName: conn.player?.name,
              message: "这局结束，回到大厅",
            });
            return;
          }
          if (msg.type === "game") {
            const err = host.party.handleGame(conn, msg.to, msg.payload);
            if (err) conn.sink.send({ type: "error", ...err });
            return;
          }
          if (msg.type === "input") {
            const err = host.party.handleInput(conn, msg.payload);
            if (err) conn.sink.send({ type: "error", ...err });
            return;
          }
          if (msg.type === "state") {
            const err = host.party.handleState(conn, msg.payload);
            if (err) conn.sink.send({ type: "error", ...err });
            return;
          }
          if (msg.type === "log") {
            const err = host.logs.ingest(conn, host.party.gameId, msg);
            if (err) conn.sink.send({ type: "error", ...err });
            return;
          }
        },
        onClose() {
          if (helloTimer) clearTimeout(helloTimer);
          if (watcherId) host.party.detachWatcher(watcherId);
          if (conn) {
            const playing = host.party.phase === "playing";
            const gameId = host.party.gameId;
            const role = conn.role;
            const name = conn.player?.name;
            host.party.detach(conn);
            if (playing && role === "display" && !host.party.displayConnected()) {
              host.logs.write({
                level: "warn",
                source: "host",
                gameId,
                role: "display",
                message: "大屏断开了",
              });
            } else if (playing && name && conn.player && !host.party.getPlayerConn(conn.player.id)) {
              host.logs.write({
                level: "debug",
                source: "host",
                gameId,
                role: "player",
                playerId: conn.player.id,
                playerName: name,
                message: `${name} 断开了`,
              });
            }
          }
        },
      };
    }),
  );
}

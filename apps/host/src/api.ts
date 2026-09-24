import {
  MAX_PLAYER_NAME,
  MAX_PLAYERS_TOTAL,
  MAX_SAVE_GAME_BYTES,
  MAX_SAVE_VALUE_BYTES,
  type SaveScope,
} from "@family/protocol";
import type { Context, Hono } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import {
  createPlayer,
  deletePlayer,
  getPlayer,
  getSave,
  issueToken,
  listPlayers,
  playerIdByToken,
  purgeSaves,
  putSave,
  renamePlayer,
  revokeTokens,
  saveGameBytes,
  saveValueBytes,
  writeHostConfig,
} from "./db";
import { qrSvg } from "./qr";
import type { HostApp } from "./host";

export function registerCertRoutes(app: Hono, host: HostApp) {
  app.get("/cert", (c) => {
    const meta = host.meta();
    if (!meta.cert.issued) {
      return c.html(`<!doctype html>
<html lang="zh-CN"><meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>还没有证书</title>
<body style="font-family:system-ui,sans-serif;background:#12141c;color:#f4f1ea;padding:28px">
<main style="max-width:520px;margin:0 auto">
<h1>还没有证书</h1>
<p>请先在电脑的管理页点「生成证书」，再回到这里安装。</p>
</main></body></html>`);
    }
    return c.html(host.certs.page({ ua: c.req.header("user-agent") ?? "", httpsJoinUrl: meta.cert.httpsJoinUrl }));
  });

  app.get("/cert/ca.crt", (c) => {
    const pem = host.certs.caPem();
    if (!pem) return c.text("证书还没生成", 503);
    return c.body(pem, 200, {
      "Content-Type": "application/x-x509-ca-cert",
      "Cache-Control": "no-store",
    });
  });

  app.get("/cert/ca.mobileconfig", (c) => {
    const body = host.certs.mobileconfig();
    if (!body) return c.text("证书还没生成", 503);
    return c.body(body, 200, {
      "Content-Type": "application/x-apple-aspen-config",
      "Cache-Control": "no-store",
    });
  });

  app.post("/api/cert/issue", (c) => {
    host.issueCert();
    return c.json(host.meta());
  });

  app.post("/api/cert/install", async (c) => {
    if (!host.certs.issued) return c.json({ error: "no_cert", message: "请先在管理页生成证书" }, 400);
    await host.certs.installLocal();
    return c.json(host.meta());
  });
}

function jsonError(c: Context, status: ContentfulStatusCode, error: string, message: string) {
  return c.json({ error, message }, status);
}

function bearer(c: Context): string | undefined {
  const header = c.req.header("authorization") ?? "";
  if (header.toLowerCase().startsWith("bearer ")) return header.slice(7).trim();
  return undefined;
}

export function registerApi(app: Hono, host: HostApp) {
  app.get("/api/meta", (c) => c.json(host.meta()));

  app.patch("/api/meta", async (c) => {
    const body = await c.req.json<{ selectedAddress?: string }>();
    if (body.selectedAddress && !host.lanAddresses.includes(body.selectedAddress)) {
      return jsonError(c, 400, "bad_address", "这不是本机的网卡地址");
    }
    host.selectedAddress = body.selectedAddress ?? host.selectedAddress;
    writeHostConfig(host.paths, { selectedAddress: host.selectedAddress });
    return c.json(host.meta());
  });

  app.get("/api/qr", (c) => {
    const kind = c.req.query("kind") ?? "join";
    const meta = host.meta();
    let text = meta.joinUrl;
    if (kind === "screen") text = meta.screenUrl;
    else if (kind === "cert") text = meta.cert.downloadUrl;
    else if (kind === "https") {
      if (!meta.cert.httpsJoinUrl) return c.text(meta.cert.httpsError ?? "https 还没起来", 404);
      text = meta.cert.httpsJoinUrl;
    }
    return c.body(qrSvg(text), 200, {
      "Content-Type": "image/svg+xml; charset=utf-8",
      "Cache-Control": "no-store",
    });
  });

  app.get("/api/players", (c) => {
    return c.json(
      listPlayers(host.db).map((p) => ({
        id: p.id,
        name: p.name,
        color: p.color,
        online: host.party.occupied(p.id),
      })),
    );
  });

  app.post("/api/players", async (c) => {
    const { name: raw } = await c.req.json<{ name?: string }>();
    const name = (raw ?? "").trim();
    if (!name || name.length > MAX_PLAYER_NAME) {
      return jsonError(c, 400, "bad_name", `名字需要 1～${MAX_PLAYER_NAME} 个字`);
    }
    if (listPlayers(host.db).length >= MAX_PLAYERS_TOTAL) {
      return jsonError(c, 400, "too_many", "家里档案已经满了");
    }
    try {
        const { player, token } = createPlayer(host.db, name);
        host.party.tryClaim(player.id, token);
        return c.json({ id: player.id, name: player.name, color: player.color, token });
    } catch (err) {
      const msg = String(err);
      if (msg.includes("UNIQUE")) return jsonError(c, 409, "duplicate_name", "这个名字已经有了");
      throw err;
    }
  });

  app.post("/api/players/claim", async (c) => {
    const { playerId } = await c.req.json<{ playerId?: string }>();
    const player = playerId ? getPlayer(host.db, playerId) : undefined;
    if (!player) return jsonError(c, 404, "not_found", "找不到这个人");
    if (host.party.occupied(player.id)) {
      return jsonError(c, 409, "taken", "已经被选走了");
    }
    const token = issueToken(host.db, player.id);
    if (!host.party.tryClaim(player.id, token)) {
      return jsonError(c, 409, "taken", "已经被选走了");
    }
    return c.json({
      token,
      player: { id: player.id, name: player.name, color: player.color },
    });
  });

  app.post("/api/players/leave", (c) => {
    const token = bearer(c);
    const playerId = token ? playerIdByToken(host.db, token) : undefined;
    if (playerId) host.party.dropPlayer(playerId);
    return c.json({ ok: true });
  });

  app.post("/api/players/:id/kick", (c) => {
    const id = c.req.param("id");
    const player = getPlayer(host.db, id);
    if (!player) return jsonError(c, 404, "not_found", "找不到这个人");
    host.party.dropPlayer(id);
    revokeTokens(host.db, id);
    host.logs.write({
      level: "info",
      source: "host",
      playerId: id,
      playerName: player.name,
      message: `管理踢下线：${player.name}`,
    });
    return c.json({ ok: true });
  });

  app.patch("/api/players/:id", async (c) => {
    const { name: raw } = await c.req.json<{ name?: string }>();
    const name = (raw ?? "").trim();
    if (!name || name.length > MAX_PLAYER_NAME) {
      return jsonError(c, 400, "bad_name", `名字需要 1～${MAX_PLAYER_NAME} 个字`);
    }
    try {
      const player = renamePlayer(host.db, c.req.param("id"), name);
      host.party.pushRoster();
      return c.json({ id: player.id, name: player.name, color: player.color });
    } catch (err) {
      const msg = String(err);
      if (msg.includes("UNIQUE")) return jsonError(c, 409, "duplicate_name", "这个名字已经有了");
      return jsonError(c, 404, "not_found", "找不到这个人");
    }
  });

  app.delete("/api/players/:id", (c) => {
    const id = c.req.param("id");
    host.party.dropPlayer(id);
    deletePlayer(host.db, id);
    return c.json({ ok: true });
  });

  app.get("/api/party", (c) => {
    return c.json({
      phase: host.party.phase,
      gameId: host.party.gameId,
      playMode: host.party.playMode,
      starterPlayerId: host.party.starterPlayerId,
      displayConnected: host.party.displayConnected(),
      displayCount: host.party.displayCount(),
      online: host.party.onlinePlayers(),
    });
  });

  app.get("/api/games", (c) => c.json(host.games.games));

  app.post("/api/games/refresh", (c) => {
    host.games.scan();
    return c.json(host.games.games);
  });

  app.get("/api/saves/:gameId", (c) => {
    const err = assertSaveAccess(host, c);
    if (err) return err;
    const gameId = c.req.param("gameId");
    const scope = (c.req.query("scope") ?? "private") as SaveScope;
    const key = c.req.query("key");
    if (!key) return jsonError(c, 400, "bad_request", "缺少 key");
    const playerId = scope === "shared" ? "" : savePlayerId(host, c)!;
    const value = getSave(host.db, gameId, playerId, key);
    if (value === undefined) return jsonError(c, 404, "not_found", "没有这条存档");
    return c.json({ key, value: JSON.parse(value) });
  });

  app.put("/api/saves/:gameId", async (c) => {
    const err = assertSaveAccess(host, c);
    if (err) return err;
    const gameId = c.req.param("gameId");
    const body = await c.req.json<{ scope?: SaveScope; key?: string; value?: unknown }>();
    const scope = body.scope ?? "private";
    const key = body.key ?? "";
    if (!key) return jsonError(c, 400, "bad_request", "缺少 key");
    const text = JSON.stringify(body.value ?? null);
    if (new TextEncoder().encode(text).length > MAX_SAVE_VALUE_BYTES) {
      return jsonError(c, 400, "too_large", "这一条存档太大了");
    }
    const playerId = scope === "shared" ? "" : savePlayerId(host, c)!;
    const old = saveValueBytes(host.db, gameId, playerId, key);
    const next = saveGameBytes(host.db, gameId) - old + new TextEncoder().encode(text).length;
    if (next > MAX_SAVE_GAME_BYTES) {
      return jsonError(c, 400, "too_large", "这个游戏的存档合计太大了");
    }
    putSave(host.db, gameId, playerId, key, text);
    return c.json({ ok: true });
  });

  app.post("/api/games/:id/saves/clear", (c) => {
    purgeSaves(host.db, c.req.param("id"));
    return c.json({ ok: true });
  });

  app.get("/api/sources", (c) => {
    return c.json(host.sources.list());
  });

  app.post("/api/sources", async (c) => {
    const { url } = await c.req.json<{ url?: string }>();
    if (!url) return jsonError(c, 400, "bad_request", "缺少网址");
    try {
      const source = host.sources.add(url);
      try {
        const refreshed = await host.sources.refresh(source.id);
        return c.json(refreshed);
      } catch {
        return c.json(source);
      }
    } catch (err) {
      const msg = String(err);
      if (msg.includes("UNIQUE")) return jsonError(c, 409, "duplicate", "这个源已经加过了");
      throw err;
    }
  });

  app.delete("/api/sources/:id", (c) => {
    host.sources.remove(c.req.param("id"));
    return c.json({ ok: true });
  });

  app.post("/api/sources/:id/refresh", async (c) => {
    try {
      return c.json(await host.sources.refresh(c.req.param("id")));
    } catch (err) {
      return jsonError(c, 400, (err as { error?: string }).error ?? "refresh_failed", (err as Error).message);
    }
  });

  app.post("/api/sources/:id/install", async (c) => {
    const { gameId } = await c.req.json<{ gameId?: string }>();
    if (!gameId) return jsonError(c, 400, "bad_request", "缺少 gameId");
    try {
      await host.sources.install(c.req.param("id"), gameId);
      return c.json({ ok: true, games: host.games.games });
    } catch (err) {
      host.sources.progress = null;
      return jsonError(c, 400, (err as { error?: string }).error ?? "install_failed", (err as Error).message);
    }
  });

  app.get("/api/installs", (c) => {
    return c.json({ active: host.sources.progress });
  });

  app.post("/api/games/:id/uninstall", async (c) => {
    const { purgeSaves: purge } = await c.req.json<{ purgeSaves?: boolean }>().catch(() => ({ purgeSaves: false }));
    const id = c.req.param("id");
    if (host.party.phase === "playing" && host.party.gameId === id) {
      return jsonError(c, 400, "busy", "正在玩这款游戏，先结束再卸");
    }
    host.sources.uninstall(id);
    if (purge) purgeSaves(host.db, id);
    return c.json({ ok: true, games: host.games.games });
  });

  app.get("/api/logs", (c) => {
    const after = Number(c.req.query("after") ?? 0) || 0;
    return c.json({
      gameId: host.party.gameId,
      entries: host.logs.after(after),
    });
  });

  app.delete("/api/logs", (c) => {
    host.logs.clear();
    return c.json({ ok: true });
  });
}

function savePlayerId(host: HostApp, c: Context): string | undefined {
  const token = bearer(c);
  return token ? playerIdByToken(host.db, token) : undefined;
}

function assertSaveAccess(host: HostApp, c: Context) {
  const gameId = c.req.param("gameId");
  if (host.party.phase !== "playing" || host.party.gameId !== gameId) {
    return jsonError(c, 403, "not_playing", "只有正在玩这款游戏时才能读写存档");
  }
  const playerId = savePlayerId(host, c);
  if (!playerId || !host.party.getPlayerConn(playerId)) {
    return jsonError(c, 401, "unauthorized", "存档需要玩家凭证");
  }
  return null;
}

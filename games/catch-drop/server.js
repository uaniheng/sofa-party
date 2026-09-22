const W = 1600;
const H = 900;
const TARGET = 8;
const BASKET_W = 150;
const BASKET_H = 36;
const SPEED = 680;
const SPAWN_MS = 900;
const GOOD_CHANCE = 0.78;

let onInputImpl = (_playerId, _payload) => {};
let onTickImpl = (_dt) => {};
let onPlayerJoinImpl = () => {};
let onPlayerLeaveImpl = (_playerId) => {};
let onDisplayImpl = (_connected) => {};

export default {
  async onStart(ctx) {
    const bodies = {};
    let items = [];
    let running = true;
    let paused = !ctx.displayConnected;
    let winnerId = null;
    let spawnAcc = 0;
    let stateAcc = 0;
    let banner = paused ? "等大屏回来" : "接住星星，躲开炸弹";
    let ended = false;
    let lastHudKey = "";

    function clamp(n, a, b) {
      return Math.max(a, Math.min(b, n));
    }

    function ensurePlayers() {
      for (const p of ctx.players) {
        if (!bodies[p.id]) {
          const i = Object.keys(bodies).length;
          bodies[p.id] = { x: 200 + i * 180, input: 0, score: 0 };
        }
      }
    }

    function hud(force = false) {
      const scores = Object.fromEntries(ctx.players.map((p) => [p.id, bodies[p.id]?.score ?? 0]));
      const key = banner + JSON.stringify(scores) + String(winnerId);
      if (!force && key === lastHudKey) return;
      lastHudKey = key;
      ctx.broadcastPlayers({ type: "hud", text: banner, scores, winnerId });
    }

    function pushState() {
      ctx.pushDisplay({ bodies, items, banner, paused, winnerId, running, ended });
    }

    function spawn() {
      items.push({
        x: 80 + Math.random() * (W - 160),
        y: -40,
        vy: 220 + Math.random() * 160,
        kind: Math.random() < GOOD_CHANCE ? "star" : "bomb",
      });
    }

    function finish(id) {
      if (ended) return;
      ended = true;
      running = false;
      winnerId = id;
      const winner = ctx.players.find((p) => p.id === id);
      banner = (winner?.name ?? "有人") + " 赢了";
      hud();
      pushState();
      ctx.log.info("本局结束", { winner: winner?.name });
      ctx.save.setShared("lastWinner", winner?.name ?? "").catch(() => {});
      setTimeout(() => ctx.end(), 2600);
    }

    function step(dt) {
      if (!running || paused || ended) return;
      spawnAcc += dt;
      while (spawnAcc >= SPAWN_MS) {
        spawnAcc -= SPAWN_MS;
        spawn();
      }
      for (const p of ctx.players) {
        const b = bodies[p.id];
        if (!b) continue;
        b.x = clamp(b.x + b.input * SPEED * (dt / 1000), BASKET_W / 2, W - BASKET_W / 2);
      }
      const keep = [];
      for (const it of items) {
        it.y += it.vy * (dt / 1000);
        let caught = false;
        for (const p of ctx.players) {
          const b = bodies[p.id];
          if (!b) continue;
          const top = H - 78;
          if (it.y < top - 20 || it.y > top + BASKET_H) continue;
          if (Math.abs(it.x - b.x) > BASKET_W / 2 + 16) continue;
          caught = true;
          if (it.kind === "star") b.score += 1;
          else b.score = Math.max(0, b.score - 1);
          hud();
          if (b.score >= TARGET) {
            finish(p.id);
            return;
          }
          break;
        }
        if (!caught && it.y < H + 40) keep.push(it);
      }
      items = keep;
    }

    onInputImpl = (playerId, payload) => {
      if (ended || !payload || typeof payload !== "object") return;
      const b = bodies[playerId];
      if (!b) return;
      if (payload.type === "stick" && typeof payload.x === "number") {
        b.input = clamp(payload.x, -1, 1);
      }
    };
    onTickImpl = (dt) => {
      step(dt);
      stateAcc += dt;
      if (stateAcc >= 100 && running && !paused) {
        stateAcc = 0;
        pushState();
      }
    };
    onPlayerJoinImpl = () => {
      ensurePlayers();
      hud();
      pushState();
    };
    onPlayerLeaveImpl = (playerId) => {
      delete bodies[playerId];
      hud(true);
      pushState();
    };
    onDisplayImpl = (connected) => {
      paused = !connected;
      if (!ended) banner = connected ? "接住星星，躲开炸弹" : "等大屏回来";
      hud(true);
      pushState();
    };

    ensurePlayers();
    ctx.log.info("开局", { players: ctx.players.map((p) => p.name) });
    hud(true);
    pushState();
    const lastWinner = await ctx.save.getShared("lastWinner");
    if (typeof lastWinner === "string" && lastWinner && !ended) {
      banner = "上场第一名：" + lastWinner;
      hud(true);
      pushState();
      setTimeout(() => {
        if (ended) return;
        banner = paused ? "等大屏回来" : "接住星星，躲开炸弹";
        hud();
        pushState();
      }, 2500);
    }
  },
  onInput(playerId, payload) {
    onInputImpl(playerId, payload);
  },
  onTick(dt) {
    onTickImpl(dt);
  },
  onPlayerJoin() {
    onPlayerJoinImpl();
  },
  onPlayerLeave(playerId) {
    onPlayerLeaveImpl(playerId);
  },
  onDisplay(connected) {
    onDisplayImpl(connected);
  },
};

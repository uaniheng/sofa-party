import { connectGame } from "/sdk/game.js";

const W = 1600;
const H = 900;
const GROUND = 820;
const FIGHTER_SCALE = 0.7;
const LEFT_X = 160;
const RIGHT_X = 1440;
const FEET_Y = 455;
const PILLAR_HW = 34;
const HEAD_H = 48 * FIGHTER_SCALE;
const PILLAR_CAP = 14;
const G = 310;
const V_MIN = 200;
const V_MAX = 650;
const ANGLE_MIN = 8 * Math.PI / 180;
const ANGLE_MAX = 72 * Math.PI / 180;
const BASE_ANGLE = 32 * Math.PI / 180;
const HP = 100;
const DMG = { head: 40, body: 22, legs: 13 };
const COOLDOWN = 2;
const START_LOCK = 2.8;

const canvas = document.getElementById("view");
const ctx = canvas.getContext("2d");

let game;
try {
  game = await connectGame();
} catch (err) {
  document.body.textContent = "连不上主机";
  throw err;
}

function clamp(n, a, b) {
  return Math.max(a, Math.min(b, n));
}

function playerOf(id) {
  return game.players.find((p) => p.id === id);
}

function tryLandscape() {
  screen.orientation?.lock?.("landscape").catch(() => {});
}

function fsFn(el) {
  return el.requestFullscreen || el.webkitRequestFullscreen || el.webkitRequestFullScreen || el.mozRequestFullScreen;
}

function nativeFullscreenEl() {
  return document.fullscreenElement || document.webkitFullscreenElement || document.mozFullScreenElement || null;
}

function isImmersive() {
  return document.documentElement.classList.contains("immersive");
}

function isFullscreen() {
  return !!(nativeFullscreenEl() || isImmersive() || window.matchMedia("(display-mode: fullscreen)").matches);
}

const fsBtn = document.getElementById("fs");

function syncFsButton() {
  if (!fsBtn) return;
  fsBtn.textContent = isFullscreen() ? "退出全屏" : "全屏";
}

async function requestNativeFullscreen(el) {
  const fn = fsFn(el);
  if (!fn) throw new Error("unsupported");
  try {
    await fn.call(el, { navigationUI: "hide" });
  } catch {
    await fn.call(el);
  }
}

function enterImmersive() {
  document.documentElement.classList.add("immersive");
  window.scrollTo(0, 1);
  tryLandscape();
  syncFsButton();
}

function exitImmersive() {
  document.documentElement.classList.remove("immersive");
  syncFsButton();
}

async function enterFullscreen() {
  const candidates = [document.documentElement, document.body, canvas];
  for (const el of candidates) {
    if (!el || !fsFn(el)) continue;
    try {
      await requestNativeFullscreen(el);
      tryLandscape();
      syncFsButton();
      if (nativeFullscreenEl()) return;
    } catch {
      /* 试下一个节点 */
    }
  }
  enterImmersive();
}

async function exitFullscreen() {
  try {
    if (document.exitFullscreen) await document.exitFullscreen();
    else if (document.webkitExitFullscreen) document.webkitExitFullscreen();
    else if (document.webkitCancelFullScreen) document.webkitCancelFullScreen();
  } catch {
    /* ignore */
  }
  exitImmersive();
}

function toggleFullscreen(e) {
  e?.stopPropagation();
  if (isFullscreen()) exitFullscreen();
  else enterFullscreen();
}

fsBtn?.addEventListener("click", toggleFullscreen);
fsBtn?.addEventListener("pointerdown", (e) => e.stopPropagation());
document.addEventListener("fullscreenchange", () => {
  if (nativeFullscreenEl()) exitImmersive();
  syncFsButton();
});
document.addEventListener("webkitfullscreenchange", () => {
  if (nativeFullscreenEl()) exitImmersive();
  syncFsButton();
});
syncFsButton();

window.visualViewport?.addEventListener("resize", () => resize());
window.visualViewport?.addEventListener("scroll", () => resize());

tryLandscape();
canvas.addEventListener("pointerdown", () => {
  tryLandscape();
});

/** @type {Record<string, any>} */
const fighters = {};
let arrows = [];
let pops = [];
let banner = "柱上对射";
let ended = false;
let winnerId = null;
let matchStartAt = Date.now();
let startLock = START_LOCK;
let last = performance.now();
let stateAcc = 0;

let localDrawing = false;
let localAngle = BASE_ANGLE;
let localPower = 0;
let pointerId = null;
let startX = 0;
let startY = 0;
let lastSend = 0;

function makeFighter(id, side) {
  return {
    id,
    side,
    x: side === "left" ? LEFT_X : RIGHT_X,
    y: FEET_Y,
    hp: HP,
    angle: BASE_ANGLE,
    power: 0,
    drawing: false,
    cooldown: 0,
    inFlight: false,
    dead: false,
    tilt: 0,
    flash: 0,
    needReset: false,
    stuck: [],
  };
}

function assignSides() {
  const list = game.players.slice(0, 2);
  list.forEach((p, i) => {
    if (!fighters[p.id]) fighters[p.id] = makeFighter(p.id, i === 0 ? "left" : "right");
  });
}

function snapshot() {
  return { fighters, pops, banner, ended, winnerId, matchStartAt };
}

function pushState() {
  if (game.isAuthority) game.broadcast({ type: "sync", ...snapshot() });
}

function applyState(s) {
  if (!s || typeof s !== "object") return;
  const mineId = game.me?.id;
  const wasReset = mineId && fighters[mineId]?.needReset;
  if (s.fighters) {
    for (const [id, next] of Object.entries(s.fighters)) {
      const cur = fighters[id];
      if (!cur) fighters[id] = next;
      else {
        cur.hp = next.hp;
        cur.dead = next.dead;
        cur.stuck = next.stuck ?? cur.stuck;
        cur.tilt = next.tilt;
        cur.flash = next.flash;
        cur.needReset = next.needReset;
        cur.side = next.side;
        cur.x = next.x;
        cur.y = next.y;
        if (id !== mineId) {
          cur.angle = next.angle;
          cur.power = next.power;
          cur.drawing = next.drawing;
        }
        if (!arrows.some((a) => a.live && a.fromId === id)) {
          cur.cooldown = next.cooldown;
          cur.inFlight = next.inFlight;
        }
      }
    }
  }
  pops = s.pops || pops;
  banner = s.banner || banner;
  ended = !!s.ended;
  winnerId = s.winnerId ?? null;
  if (typeof s.matchStartAt === "number") matchStartAt = s.matchStartAt;
  const mine = mineId ? fighters[mineId] : null;
  if (mine?.needReset && localDrawing) cancelLocalAim();
  else if (!wasReset && mine?.needReset) cancelLocalAim();
  if (localDrawing && mine && !mine.needReset && !mine.dead) {
    mine.drawing = true;
    mine.angle = localAngle;
    mine.power = localPower;
  }
}

function cancelLocalAim() {
  localDrawing = false;
  localPower = 0;
  pointerId = null;
}

function myFighter() {
  return game.me?.id ? fighters[game.me.id] : null;
}

function viewFlipped() {
  return myFighter()?.side === "right";
}

function withUnflip(x, y, fn) {
  ctx.save();
  ctx.translate(x, y);
  if (viewFlipped()) ctx.scale(-1, 1);
  fn();
  ctx.restore();
}

function canDraw() {
  const f = myFighter();
  return !!(f && !ended && startLock <= 0 && !f.dead && f.cooldown <= 0 && !f.inFlight);
}

function bowPoint(f) {
  const facing = f.side === "left" ? 1 : -1;
  const s = FIGHTER_SCALE;
  return {
    x: f.x + facing * 32 * s,
    y: f.y - 108 * s + f.tilt * 14,
    facing,
  };
}

function parts(f) {
  const t = f.tilt;
  const s = FIGHTER_SCALE;
  return {
    head: { x: f.x + t * 12, y: f.y - 148 * s + t * 6, r: 24 * s },
    body: { x: f.x - 18 * s + t * 7, y: f.y - 126 * s, w: 36 * s, h: 70 * s },
    legs: { x: f.x - 16 * s + t * 3, y: f.y - 56 * s, w: 32 * s, h: 56 * s },
  };
}

function hitsPillar(f, x, y) {
  if (y >= GROUND || y <= f.y - PILLAR_CAP) return false;
  const hw = y <= f.y ? PILLAR_HW + 8 : PILLAR_HW;
  return Math.abs(x - f.x) < hw;
}

function dropPillar(f) {
  const next = Math.min(GROUND, f.y + HEAD_H);
  if (next <= f.y) return;
  f.y = next;
  pops.push({ x: f.x, y: f.y - 36, text: "柱沉", life: 0.9 });
  interruptAim(f);
  if (game.isAuthority) {
    game.log.info("柱子下沉", { name: playerOf(f.id)?.name, y: f.y });
    pushState();
  }
}

function hitPart(f, x, y) {
  const p = parts(f);
  const dx = x - p.head.x;
  const dy = y - p.head.y;
  if (dx * dx + dy * dy <= p.head.r * p.head.r) return "head";
  if (x >= p.body.x && x <= p.body.x + p.body.w && y >= p.body.y && y <= p.body.y + p.body.h) return "body";
  if (x >= p.legs.x && x <= p.legs.x + p.legs.w && y >= p.legs.y && y <= p.legs.y + p.legs.h) return "legs";
  return null;
}

function speedOf(power) {
  return V_MIN + (V_MAX - V_MIN) * clamp(power, 0, 1);
}

function interruptAim(f) {
  const aiming = f.drawing || (f.id === game.me?.id && localDrawing);
  f.drawing = false;
  f.power = 0;
  f.needReset = true;
  if (aiming && f.id === game.me?.id) cancelLocalAim();
  if (aiming && game.isAuthority) game.log.info("打断拉弓", { name: playerOf(f.id)?.name });
}

function posAt(a, t) {
  return {
    x: a.x0 + a.vx0 * t,
    y: a.y0 + a.vy0 * t + 0.5 * G * t * t,
    vx: a.vx0,
    vy: a.vy0 + G * t,
  };
}

function spawnArrow(shot) {
  if (!shot?.id || arrows.some((a) => a.id === shot.id)) return false;
  arrows.push({
    id: shot.id,
    fromId: shot.fromId,
    x0: shot.x0,
    y0: shot.y0,
    vx0: shot.vx0,
    vy0: shot.vy0,
    t0: Date.now(),
    x: shot.x0,
    y: shot.y0,
    vx: shot.vx0,
    vy: shot.vy0,
    live: true,
    lastT: 0,
  });
  const f = fighters[shot.fromId];
  if (f) {
    f.inFlight = true;
    f.drawing = false;
    f.power = 0;
  }
  return true;
}

function makeShot(f) {
  if (ended || startLock > 0 || f.dead || f.cooldown > 0 || f.inFlight || f.needReset) return null;
  if (f.power < 0.18) {
    f.drawing = false;
    f.power = 0;
    return null;
  }
  const bow = bowPoint(f);
  const v = speedOf(f.power);
  return {
    id: `${f.id}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`,
    fromId: f.id,
    x0: bow.x,
    y0: bow.y,
    vx0: Math.cos(f.angle) * v * bow.facing,
    vy0: -Math.sin(f.angle) * v,
    t0: Date.now(),
  };
}

function fireShot(shot) {
  if (!spawnArrow(shot)) return;
  game.broadcast({ type: "shot", ...shot });
  if (game.isAuthority) game.log.info("射出", { name: playerOf(shot.fromId)?.name });
}

function resolveArrow(a) {
  if (!a.live) return;
  a.live = false;
  const shooter = fighters[a.fromId];
  if (shooter) {
    shooter.inFlight = false;
    shooter.cooldown = COOLDOWN;
  }
}

function finish(id) {
  if (ended) return;
  ended = true;
  winnerId = id;
  const winner = playerOf(id);
  banner = winner ? `${winner.name} 赢了` : "分出胜负了";
  if (!game.isAuthority) return;
  pushState();
  game.log.info("本局结束", { winner: winner?.name });
  game.save.setShared("lastWinner", winner?.name ?? "").catch(() => {});
  setTimeout(() => game.end(), 2800);
}

function maybeEnd() {
  const alive = Object.values(fighters).filter((f) => !f.dead);
  if (alive.length === 1) finish(alive[0].id);
  else if (alive.length === 0) {
    ended = true;
    banner = "两个人一起倒下了";
    pushState();
    setTimeout(() => game.end(), 2800);
  }
}

function hurt(f, part, ax, ay, rot) {
  if (f.dead) return;
  const dmg = DMG[part] ?? 20;
  f.hp = Math.max(0, f.hp - dmg);
  f.flash = 0.28;
  f.stuck.push({ lx: ax - f.x, ly: ay - f.y, rot });
  const label = part === "head" ? "头" : part === "body" ? "身" : "腿";
  pops.push({ x: ax, y: ay - 20, text: `-${dmg} ${label}`, life: 0.9 });
  interruptAim(f);
  if (game.isAuthority) game.log.info("中箭", { name: playerOf(f.id)?.name, part, dmg, hp: f.hp });
  if (f.hp <= 0) {
    f.dead = true;
    maybeEnd();
  }
  if (game.isAuthority) pushState();
}

function onAim(id, payload) {
  const f = fighters[id];
  if (!f || f.dead || ended || startLock > 0) return;
  if (payload.start) f.needReset = false;
  if (f.needReset) return;
  if (typeof payload.angle === "number") f.angle = clamp(payload.angle, ANGLE_MIN, ANGLE_MAX);
  if (typeof payload.power === "number") f.power = clamp(payload.power, 0, 1);
  f.drawing = !!payload.drawing && f.cooldown <= 0 && !f.inFlight;
}

function handleAction(id, payload) {
  if (!payload) return;
  if (payload.type === "aim") onAim(id, payload);
  if (payload.type === "shoot") {
    onAim(id, payload);
    if (payload.id && payload.vx0 != null) spawnArrow(payload);
    else {
      const f = fighters[id];
      const shot = f ? makeShot(f) : null;
      if (shot) fireShot(shot);
    }
  }
  if (payload.type === "cancel") {
    const f = fighters[id];
    if (f && !f.needReset) {
      f.drawing = false;
      f.power = 0;
    }
  }
}

function step(dt) {
  startLock = Math.max(0, START_LOCK - (Date.now() - matchStartAt) / 1000);
  if (!ended) {
    banner = startLock <= 0 ? "射！" : String(Math.max(1, Math.ceil(startLock)));
  }
  for (const f of Object.values(fighters)) {
    if (f.cooldown > 0) f.cooldown = Math.max(0, f.cooldown - dt);
    if (f.flash > 0) f.flash = Math.max(0, f.flash - dt);
    if (f.dead) f.tilt = clamp(f.tilt + dt * 1.6, 0, 1.2);
  }
  const now = Date.now();
  for (const a of arrows) {
    if (!a.live) continue;
    const t = Math.max(0, (now - a.t0) / 1000);
    const prev = a.lastT ?? 0;
    const n = Math.max(1, Math.ceil((t - prev) / 0.008));
    for (let i = 1; i <= n && a.live; i++) {
      const ti = prev + ((t - prev) * i) / n;
      const pos = posAt(a, ti);
      a.x = pos.x;
      a.y = pos.y;
      a.vx = pos.vx;
      a.vy = pos.vy;
      const rot = Math.atan2(a.vy, a.vx);
      if (a.y > GROUND || a.x < -40 || a.x > W + 40) {
        resolveArrow(a);
        break;
      }
      for (const f of Object.values(fighters)) {
        if (f.id === a.fromId) {
          if (hitsPillar(f, a.x, a.y)) resolveArrow(a);
          continue;
        }
        if (f.dead) {
          if (hitsPillar(f, a.x, a.y)) resolveArrow(a);
          continue;
        }
        const part = hitPart(f, a.x, a.y);
        if (part) {
          resolveArrow(a);
          hurt(f, part, a.x, a.y, rot);
          break;
        }
        if (hitsPillar(f, a.x, a.y)) {
          resolveArrow(a);
          dropPillar(f);
          break;
        }
      }
    }
    a.lastT = t;
  }
  arrows = arrows.filter((a) => a.live);
  for (const p of pops) p.life -= dt;
  pops = pops.filter((p) => p.life > 0);
}

function resize() {
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const vv = window.visualViewport;
  const cssW = vv?.width || canvas.clientWidth || window.innerWidth;
  const cssH = vv?.height || canvas.clientHeight || window.innerHeight;
  if (isImmersive() && vv) {
    canvas.style.position = "fixed";
    canvas.style.left = `${vv.offsetLeft}px`;
    canvas.style.top = `${vv.offsetTop}px`;
    canvas.style.width = `${cssW}px`;
    canvas.style.height = `${cssH}px`;
  } else {
    canvas.style.position = "";
    canvas.style.left = "";
    canvas.style.top = "";
    canvas.style.width = "";
    canvas.style.height = "";
  }
  const pw = Math.max(1, Math.floor(cssW * dpr));
  const ph = Math.max(1, Math.floor(cssH * dpr));
  if (canvas.width !== pw || canvas.height !== ph) {
    canvas.width = pw;
    canvas.height = ph;
  }
  const scale = Math.min(pw / W, ph / H);
  ctx.setTransform(scale, 0, 0, scale, (pw - W * scale) / 2, (ph - H * scale) / 2);
}

function drawSky() {
  const g = ctx.createLinearGradient(0, 0, 0, H);
  g.addColorStop(0, "#152038");
  g.addColorStop(0.55, "#3a3d62");
  g.addColorStop(1, "#c4784a");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = "rgba(255,210,140,0.9)";
  ctx.beginPath();
  ctx.arc(1280, 140, 58, 0, Math.PI * 2);
  ctx.fill();
}

function drawPillar(x, topY) {
  const hw = PILLAR_HW;
  const top = Math.min(topY, GROUND);
  if (top >= GROUND) return;
  ctx.fillStyle = "#3d342c";
  ctx.fillRect(x - hw, top, hw * 2, GROUND - top);
  ctx.fillStyle = "#53473c";
  ctx.fillRect(x - hw - 8, top - PILLAR_CAP, hw * 2 + 16, PILLAR_CAP);
  ctx.strokeStyle = "rgba(0,0,0,0.25)";
  ctx.lineWidth = 2;
  for (let y = top + 22; y < GROUND; y += 28) {
    ctx.beginPath();
    ctx.moveTo(x - hw, y);
    ctx.lineTo(x + hw, y);
    ctx.stroke();
  }
}

function drawFighter(f) {
  const p = playerOf(f.id);
  const color = p?.color ?? "#4C8BF5";
  const facing = f.side === "left" ? 1 : -1;
  const mine = f.id === game.me?.id;
  const s = FIGHTER_SCALE;
  ctx.save();
  ctx.translate(f.x, f.y);
  ctx.rotate(f.side === "left" ? f.tilt : -f.tilt);
  if (f.flash > 0) ctx.globalAlpha = 0.55 + Math.sin(f.flash * 40) * 0.25;

  ctx.fillStyle = color;
  ctx.fillRect(-16 * s, -56 * s, 32 * s, 56 * s);
  ctx.fillRect(-18 * s, -126 * s, 36 * s, 70 * s);
  ctx.beginPath();
  ctx.arc(0, -148 * s, 24 * s, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = "#1a140f";
  ctx.beginPath();
  ctx.arc(facing * 8 * s, -150 * s, 5 * s, 0, Math.PI * 2);
  ctx.fill();

  const bowX = facing * 30 * s;
  const bowY = -108 * s;
  ctx.strokeStyle = "#e8d5b0";
  ctx.lineWidth = 5 * s;
  ctx.beginPath();
  ctx.arc(bowX, bowY, 34 * s, facing > 0 ? -1.15 : Math.PI - 1.15, facing > 0 ? 1.15 : Math.PI + 1.15);
  ctx.stroke();
  const pull = (f.drawing ? 10 + f.power * 26 : 8) * s;
  ctx.strokeStyle = "#f4f1ea";
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(bowX, bowY - 32 * s);
  ctx.lineTo(bowX - facing * pull, bowY);
  ctx.lineTo(bowX, bowY + 32 * s);
  ctx.stroke();
  if (f.drawing) {
    ctx.save();
    ctx.translate(bowX - facing * (pull - 18 * s), bowY);
    ctx.rotate(facing > 0 ? -f.angle : Math.PI + f.angle);
    ctx.fillStyle = "#f0c75e";
    ctx.fillRect(-28 * s, -3 * s, 46 * s, 6 * s);
    ctx.beginPath();
    ctx.moveTo(18 * s, 0);
    ctx.lineTo(8 * s, -7 * s);
    ctx.lineTo(8 * s, 7 * s);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }
  for (const st of f.stuck) {
    ctx.save();
    ctx.translate(st.lx, st.ly);
    ctx.rotate(st.rot);
    ctx.fillStyle = "#d8c39a";
    ctx.fillRect(-14, -2, 22, 3);
    ctx.restore();
  }
  ctx.restore();

  const barW = 110;
  const barY = f.y - 168 * s;
  ctx.fillStyle = "rgba(0,0,0,0.45)";
  ctx.fillRect(f.x - barW / 2, barY, barW, 12);
  ctx.fillStyle = f.hp > 35 ? "#2ecc71" : "#e74c3c";
  ctx.fillRect(f.x - barW / 2, barY, barW * (f.hp / HP), 12);
  ctx.strokeStyle = mine ? "#f0c75e" : "#f4f1ea";
  ctx.lineWidth = mine ? 3 : 2;
  ctx.strokeRect(f.x - barW / 2, barY, barW, 12);

  ctx.font = "800 22px Segoe UI, Microsoft YaHei, sans-serif";
  ctx.lineWidth = 5;
  ctx.strokeStyle = "rgba(12,18,32,0.85)";
  ctx.fillStyle = mine ? "#f0c75e" : "#f4f1ea";
  withUnflip(f.x, barY - 10, () => {
    ctx.textAlign = "center";
    ctx.strokeText(p?.name ?? "玩家", 0, 0);
    ctx.fillText(p?.name ?? "玩家", 0, 0);
  });
}

function drawArrow(a) {
  const rot = Math.atan2(a.vy, a.vx);
  ctx.save();
  ctx.translate(a.x, a.y);
  ctx.rotate(rot);
  ctx.fillStyle = "#f0c75e";
  ctx.fillRect(-22, -3, 36, 6);
  ctx.beginPath();
  ctx.moveTo(20, 0);
  ctx.lineTo(8, -8);
  ctx.lineTo(8, 8);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = "#e74c3c";
  ctx.beginPath();
  ctx.moveTo(-22, 0);
  ctx.lineTo(-30, -7);
  ctx.lineTo(-26, 0);
  ctx.lineTo(-30, 7);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

function draw() {
  resize();
  ctx.save();
  if (viewFlipped()) {
    ctx.translate(W, 0);
    ctx.scale(-1, 1);
  }
  drawSky();
  const drawn = new Set();
  for (const f of Object.values(fighters)) {
    drawPillar(f.x, f.y);
    drawn.add(f.side);
  }
  if (!drawn.has("left")) drawPillar(LEFT_X, FEET_Y);
  if (!drawn.has("right")) drawPillar(RIGHT_X, FEET_Y);
  ctx.fillStyle = "#2a211c";
  ctx.fillRect(0, GROUND, W, H - GROUND);
  ctx.fillStyle = "#3a2c24";
  ctx.fillRect(0, GROUND, W, 16);

  for (const f of Object.values(fighters)) drawFighter(f);
  for (const a of arrows) drawArrow(a);
  ctx.font = "800 26px Segoe UI, Microsoft YaHei, sans-serif";
  for (const p of pops) {
    ctx.globalAlpha = clamp(p.life / 0.9, 0, 1);
    ctx.fillStyle = "#f0c75e";
    withUnflip(p.x, p.y - (0.9 - p.life) * 40, () => {
      ctx.textAlign = "center";
      ctx.fillText(p.text, 0, 0);
    });
  }
  ctx.globalAlpha = 1;
  ctx.restore();

  const mine = myFighter();
  ctx.fillStyle = "#f4f1ea";
  ctx.font = "800 36px Segoe UI, Microsoft YaHei, sans-serif";
  ctx.textAlign = "left";
  ctx.fillText("柱上对射", 36, 52);
  ctx.font = "700 26px Segoe UI, Microsoft YaHei, sans-serif";
  ctx.fillStyle = "#f0c75e";
  ctx.fillText(banner, 36, 92);
  ctx.fillStyle = "#9aa3b8";
  ctx.font = "700 18px Segoe UI, Microsoft YaHei, sans-serif";
  ctx.fillText("往左拉弓　上滑压低　下滑抬高　头-40 身-22 腿-13　中柱下沉", 36, 124);
  if (mine && !ended) {
    ctx.fillStyle = "#f0c75e";
    if (mine.inFlight) ctx.fillText("箭还在飞", 36, 154);
    else if (mine.cooldown > 0) ctx.fillText("装填 " + mine.cooldown.toFixed(1) + " 秒", 36, 154);
  }

  if (ended) {
    ctx.fillStyle = "rgba(0,0,0,0.35)";
    ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = "#f4f1ea";
    ctx.textAlign = "center";
    ctx.font = "800 72px Segoe UI, Microsoft YaHei, sans-serif";
    ctx.fillText(banner, W / 2, H / 2);
    ctx.textAlign = "left";
  }
}

function maxPull() {
  return Math.max(90, Math.min(180, canvas.clientWidth * 0.22));
}

function applyDrag(x, y) {
  const f = myFighter();
  if (!f) return;
  localPower = clamp((startX - x) / maxPull(), 0, 1);
  localAngle = clamp(BASE_ANGLE + ((y - startY) / 110) * (ANGLE_MAX - BASE_ANGLE), ANGLE_MIN, ANGLE_MAX);
}

function sendAction(payload, force = false) {
  const now = Date.now();
  if (!force && payload.type === "aim" && now - lastSend < 50) return;
  lastSend = now;
  if (game.isAuthority) handleAction(game.me.id, payload);
  else game.sendInput(payload);
}

function onDown(e) {
  if (pointerId != null || !canDraw()) return;
  pointerId = e.pointerId;
  canvas.setPointerCapture(pointerId);
  localDrawing = true;
  startX = e.clientX;
  startY = e.clientY;
  localPower = 0;
  applyDrag(e.clientX, e.clientY);
  sendAction({ type: "aim", start: true, drawing: true, angle: localAngle, power: localPower }, true);
}

function onMove(e) {
  if (e.pointerId !== pointerId || !localDrawing) return;
  applyDrag(e.clientX, e.clientY);
  const f = myFighter();
  if (f) {
    f.drawing = true;
    f.angle = localAngle;
    f.power = localPower;
  }
  sendAction({ type: "aim", drawing: true, angle: localAngle, power: localPower });
}

function onUp(e) {
  if (e.pointerId !== pointerId) return;
  if (!localDrawing) {
    pointerId = null;
    return;
  }
  applyDrag(e.clientX, e.clientY);
  const f = myFighter();
  if (f) {
    f.angle = localAngle;
    f.power = localPower;
  }
  const shot = localPower >= 0.18 && canDraw() && !f?.needReset ? makeShot(f) : null;
  if (shot) {
    spawnArrow(shot);
    game.broadcast({ type: "shot", ...shot });
    if (!game.isAuthority) game.sendInput({ type: "shoot", ...shot });
    else game.log.info("射出", { name: playerOf(shot.fromId)?.name });
  } else {
    sendAction({ type: "cancel" }, true);
  }
  cancelLocalAim();
}

canvas.addEventListener("pointerdown", onDown);
canvas.addEventListener("pointermove", onMove);
canvas.addEventListener("pointerup", onUp);
canvas.addEventListener("pointercancel", onUp);

function loop(now) {
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;
  step(dt);
  if (game.isAuthority) {
    stateAcc += dt;
    if (stateAcc >= 0.1) {
      stateAcc = 0;
      pushState();
    }
  }
  draw();
  requestAnimationFrame(loop);
}

game.on("players", () => {
  assignSides();
  if (game.isAuthority) {
    for (const p of game.players) {
      if (p.id !== game.me?.id) game.send({ playerId: p.id }, { type: "sync", ...snapshot() });
    }
  }
});
game.on("message", ({ payload }) => {
  if (!payload || typeof payload !== "object") return;
  if (payload.type === "sync") applyState(payload);
  if (payload.type === "shot") spawnArrow(payload);
  if (payload.type === "interrupt" && payload.playerId === game.me?.id) cancelLocalAim();
});
game.on("input", ({ playerId, payload }) => {
  if (game.isAuthority) handleAction(playerId, payload);
});

assignSides();
const lastWinner = await game.save.getShared("lastWinner").catch(() => undefined);
if (typeof lastWinner === "string" && lastWinner) banner = "上场赢的人：" + lastWinner;
if (game.isAuthority) {
  game.log.info("开局", { players: game.players.map((p) => p.name) });
  pushState();
}
requestAnimationFrame(loop);

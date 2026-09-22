import { connectGame } from "/sdk/game.js";

const W = 1600;
const H = 900;
const BASKET_W = 150;
const BASKET_H = 36;

const canvas = document.getElementById("view");
const ctx = canvas.getContext("2d");

let game;
try {
  game = await connectGame();
} catch (err) {
  document.body.textContent = "连不上主机";
  throw err;
}

const bodies = {};
let items = [];
let banner = "等待开局的人把画面送来";
let ended = false;

function applyState(s) {
  if (!s || typeof s !== "object") return;
  for (const id of Object.keys(bodies)) delete bodies[id];
  Object.assign(bodies, s.bodies || {});
  items = Array.isArray(s.items) ? s.items : [];
  banner = s.banner || banner;
  ended = !!s.ended;
}

function drawStar(x, y, r, color) {
  ctx.fillStyle = color;
  ctx.beginPath();
  for (let i = 0; i < 5; i++) {
    const a = -Math.PI / 2 + (i * 2 * Math.PI) / 5;
    const b = a + Math.PI / 5;
    ctx.lineTo(x + Math.cos(a) * r, y + Math.sin(a) * r);
    ctx.lineTo(x + Math.cos(b) * r * 0.42, y + Math.sin(b) * r * 0.42);
  }
  ctx.closePath();
  ctx.fill();
}

function draw() {
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const rect = canvas.getBoundingClientRect();
  const pw = Math.max(1, Math.floor(rect.width * dpr));
  const ph = Math.max(1, Math.floor(rect.height * dpr));
  if (canvas.width !== pw || canvas.height !== ph) {
    canvas.width = pw;
    canvas.height = ph;
  }
  const scale = Math.min(pw / W, ph / H);
  const ox = (pw - W * scale) / 2;
  const oy = (ph - H * scale) / 2;
  ctx.setTransform(scale, 0, 0, scale, ox, oy);
  ctx.fillStyle = "#0c1220";
  ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = "#14203a";
  ctx.fillRect(0, H - 54, W, 54);

  ctx.fillStyle = "#f4f1ea";
  ctx.font = "800 42px Segoe UI, Microsoft YaHei, sans-serif";
  ctx.fillText("接住它", 40, 64);
  ctx.font = "700 28px Segoe UI, Microsoft YaHei, sans-serif";
  ctx.fillStyle = "#9aa3b8";
  ctx.fillText(banner, 40, 106);

  let labelX = 40;
  for (const p of game.players) {
    const b = bodies[p.id];
    ctx.fillStyle = p.color;
    ctx.font = "800 26px Segoe UI, Microsoft YaHei, sans-serif";
    const text = `${p.name} ${b?.score ?? 0}`;
    ctx.fillText(text, labelX, 154);
    labelX += ctx.measureText(text).width + 28;
  }

  for (const it of items) {
    if (it.kind === "star") drawStar(it.x, it.y, 22, "#f0c75e");
    else {
      ctx.fillStyle = "#2a2f3c";
      ctx.beginPath();
      ctx.arc(it.x, it.y, 20, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = "#e74c3c";
      ctx.lineWidth = 5;
      ctx.beginPath();
      ctx.moveTo(it.x - 8, it.y - 8);
      ctx.lineTo(it.x + 8, it.y + 8);
      ctx.moveTo(it.x + 8, it.y - 8);
      ctx.lineTo(it.x - 8, it.y + 8);
      ctx.stroke();
    }
  }

  for (const p of game.players) {
    const b = bodies[p.id];
    if (!b) continue;
    ctx.fillStyle = p.color;
    ctx.fillRect(b.x - BASKET_W / 2, H - 78, BASKET_W, BASKET_H);
    ctx.fillStyle = "#0c1220";
    ctx.font = "800 20px Segoe UI, Microsoft YaHei, sans-serif";
    ctx.textAlign = "center";
    ctx.fillText(p.name, b.x, H - 54);
    ctx.textAlign = "left";
  }

  if (ended) {
    ctx.fillStyle = "rgba(0,0,0,0.35)";
    ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = "#f4f1ea";
    ctx.textAlign = "center";
    ctx.font = "800 84px Segoe UI, Microsoft YaHei, sans-serif";
    ctx.fillText(banner, W / 2, H / 2);
    ctx.textAlign = "left";
  }
}

function loop() {
  draw();
  requestAnimationFrame(loop);
}

game.on("state", applyState);
game.on("players", () => draw());
requestAnimationFrame(loop);

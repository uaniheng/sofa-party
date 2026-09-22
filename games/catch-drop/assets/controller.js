import { connectGame } from "/sdk/game.js";

const name = document.getElementById("name");
const hint = document.getElementById("hint");
const score = document.getElementById("score");
const left = document.getElementById("left");
const right = document.getElementById("right");

let game;
try {
  game = await connectGame();
} catch (err) {
  name.textContent = "连不上主机";
  hint.textContent = err instanceof Error ? err.message : String(err);
  throw err;
}

name.textContent = game.me?.name ?? "手柄";
if (game.me?.color) {
  document.body.style.setProperty("--c", game.me.color);
}

let held = 0;

function sendStick() {
  game.sendInput({ type: "stick", x: held, y: 0 });
}

function bind(el, dir) {
  const on = (e) => {
    e.preventDefault();
    held = dir;
    sendStick();
  };
  const off = (e) => {
    e.preventDefault();
    if (held === dir) held = 0;
    sendStick();
  };
  el.addEventListener("pointerdown", on);
  el.addEventListener("pointerup", off);
  el.addEventListener("pointercancel", off);
  el.addEventListener("pointerleave", off);
}

bind(left, -1);
bind(right, 1);

setInterval(() => {
  if (held !== 0) sendStick();
}, 50);

game.on("message", ({ payload }) => {
  if (!payload || payload.type !== "hud") return;
  if (typeof payload.text === "string") hint.textContent = payload.text;
  const mine = game.me?.id ? payload.scores?.[game.me.id] : undefined;
  if (typeof mine === "number") score.textContent = mine + " 分";
});

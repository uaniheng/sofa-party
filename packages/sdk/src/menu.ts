import type { PageRole } from "@family/protocol";

const HOST_ID = "family-game-shell-menu";

const CSS = `
:host { all: initial; }
* { box-sizing: border-box; font-family: "Segoe UI", "PingFang SC", "Microsoft YaHei", system-ui, sans-serif; }
.fab {
  pointer-events: auto;
  position: fixed;
  top: max(10px, env(safe-area-inset-top));
  right: max(10px, env(safe-area-inset-right));
  z-index: 2;
  min-height: 44px;
  padding: 8px 14px;
  border: 0;
  border-radius: 999px;
  background: rgba(18, 20, 28, 0.82);
  color: #f4f1ea;
  font-size: 15px;
  font-weight: 700;
  letter-spacing: 0.04em;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.35);
  backdrop-filter: blur(8px);
  -webkit-backdrop-filter: blur(8px);
  cursor: pointer;
}
.fab.controller {
  min-height: 48px;
  padding: 10px 16px;
  font-size: 16px;
}
.scrim {
  pointer-events: auto;
  position: fixed;
  inset: 0;
  background: rgba(8, 10, 16, 0.55);
  display: flex;
  align-items: flex-end;
  justify-content: center;
  padding: 16px 16px max(20px, env(safe-area-inset-bottom));
}
.panel {
  width: min(420px, 100%);
  background: #1b1f2b;
  color: #f4f1ea;
  border-radius: 20px;
  padding: 22px 18px 16px;
  box-shadow: 0 18px 50px rgba(0, 0, 0, 0.45);
}
.panel h2 {
  margin: 0 0 8px;
  font-size: 20px;
}
.panel p {
  margin: 0 0 18px;
  color: #a8b0c2;
  line-height: 1.45;
}
.row {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
button.action {
  border: 0;
  border-radius: 14px;
  padding: 14px 18px;
  font-size: 16px;
  font-weight: 700;
  cursor: pointer;
}
.stay {
  background: #242a3a;
  color: #f4f1ea;
}
.exit {
  background: #ef6b6b;
  color: #fff;
}
.hidden { display: none; }
`;

export function attachGameMenu(opts: { role: PageRole; end: () => void }) {
  if (typeof document === "undefined") return;
  if (opts.role === "display") return;
  if (document.getElementById(HOST_ID)) return;

  const isController = opts.role === "controller";
  const exitLabel = isController ? "关闭游戏" : "退出游戏";

  const host = document.createElement("div");
  host.id = HOST_ID;
  host.style.cssText =
    "position:fixed;top:0;left:0;width:0;height:0;overflow:visible;pointer-events:none;z-index:2147483646";
  const shadow = host.attachShadow({ mode: "open" });
  shadow.innerHTML = `
    <style>${CSS}</style>
    <button class="fab${isController ? " controller" : ""}" type="button" aria-haspopup="dialog">菜单</button>
    <div class="scrim hidden" role="dialog" aria-modal="true" aria-labelledby="family-menu-title">
      <div class="panel">
        <h2 id="family-menu-title">要结束这局吗？</h2>
        <p>所有人都会回到大厅，可以再选别的游戏。</p>
        <div class="row">
          <button class="action stay" type="button">再玩一会</button>
          <button class="action exit" type="button">${exitLabel}</button>
        </div>
      </div>
    </div>
  `;

  const fab = shadow.querySelector(".fab") as HTMLButtonElement;
  const scrim = shadow.querySelector(".scrim") as HTMLElement;
  const stay = shadow.querySelector(".stay") as HTMLButtonElement;
  const exitBtn = shadow.querySelector(".exit") as HTMLButtonElement;

  const open = () => scrim.classList.remove("hidden");
  const close = () => scrim.classList.add("hidden");

  const stop = (ev: Event) => ev.stopPropagation();
  fab.addEventListener("pointerdown", stop);
  fab.addEventListener("click", (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    open();
  });
  stay.addEventListener("click", (ev) => {
    ev.preventDefault();
    close();
  });
  scrim.addEventListener("pointerdown", stop);
  scrim.addEventListener("click", (ev) => {
    if (ev.target === scrim) close();
  });
  exitBtn.addEventListener("click", (ev) => {
    ev.preventDefault();
    exitBtn.disabled = true;
    opts.end();
  });

  const root = document.body ?? document.documentElement;
  root.appendChild(host);
}

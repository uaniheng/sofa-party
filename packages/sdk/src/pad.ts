import {
  MAX_PAD_BUTTONS,
  PAD_HEARTBEAT_MS,
  PAD_STICK_THROTTLE_MS,
  type PadButton,
  type PadInput,
  type PadStick,
} from "@family/protocol";

const HOST_ID = "family-game-pad";
const KNOB_HALF = 28;
const DEFAULT_COLOR = "#4C8BF5";

const CSS = `
:host { all: initial; }
* { box-sizing: border-box; }
.pad {
  position: fixed;
  left: 0;
  right: 0;
  bottom: 0;
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  gap: 14px;
  padding: 14px 16px calc(16px + env(safe-area-inset-bottom, 0px));
  pointer-events: none;
  touch-action: none;
  -webkit-user-select: none;
  user-select: none;
  -webkit-tap-highlight-color: transparent;
  font-family: "Segoe UI", "PingFang SC", "Microsoft YaHei", system-ui, sans-serif;
}
.stick {
  pointer-events: auto;
  position: relative;
  flex: 0 0 auto;
  width: min(132px, 34vw);
  height: min(132px, 34vw);
  border-radius: 50%;
  background: rgba(18, 21, 30, 0.74);
  border: 2px solid rgba(255, 255, 255, 0.14);
  box-shadow: inset 0 2px 12px rgba(0, 0, 0, 0.4);
  touch-action: none;
}
.knob {
  position: absolute;
  left: 50%;
  top: 50%;
  width: 56px;
  height: 56px;
  margin: -28px 0 0 -28px;
  border-radius: 50%;
  background: var(--pad-c, ${DEFAULT_COLOR});
  box-shadow: 0 6px 18px rgba(0, 0, 0, 0.45);
}
.btns {
  pointer-events: auto;
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  justify-content: flex-end;
  max-width: 58%;
}
.btn {
  pointer-events: auto;
  min-width: 84px;
  min-height: 56px;
  padding: 10px 16px;
  border: 0;
  border-radius: 16px;
  background: rgba(30, 34, 46, 0.92);
  color: #f2f4f8;
  font-size: 16px;
  font-weight: 700;
  letter-spacing: 0.02em;
  touch-action: none;
  cursor: pointer;
}
.btn.hold {
  border-bottom: 3px solid rgba(0, 0, 0, 0.35);
}
.btn.on {
  background: var(--pad-c, ${DEFAULT_COLOR});
  color: #fff;
}
.off {
  opacity: 0.32;
}
`;

export type PadOptions = {
  /** 摇杆能推哪个轴。不写就是没有摇杆。 */
  stick?: PadStick;
  /** 动作键。最多 MAX_PAD_BUTTONS 个。 */
  buttons?: PadButton[];
  /** 玩家颜色，一般传 game.me?.color。 */
  color?: string;
  /** 按下时震一下。默认开。 */
  haptic?: boolean;
  /** 收到输入时回调。通常写 onInput: (i) => game.sendInput(i)。 */
  onInput: (input: PadInput) => void;
};

export type PadHandle = {
  /** 服务端说哪些键现在能按，例如 { light: true, heavy: false }。 */
  setEnabled(map: Record<string, boolean>): void;
  /** 整个摇杆禁用 / 启用。 */
  setStickEnabled(on: boolean): void;
  /** 拆掉手柄并停掉心跳。 */
  destroy(): void;
};

function clamp1(v: number) {
  if (!Number.isFinite(v)) return 0;
  return Math.max(-1, Math.min(1, Math.round(v * 100) / 100));
}

function buzz(ms: number) {
  try {
    navigator.vibrate?.(ms);
  } catch {
    /* 不支持就算了 */
  }
}

/**
 * 在页面上叠一只官方手柄。用 Shadow DOM，不吃游戏自己的样式。
 * 内部已经处理好指针捕获、节流、安全区和「按住状态重发」，游戏只需要声明布局。
 */
export function attachPad(opts: PadOptions): PadHandle {
  const stickMode: PadStick = opts.stick ?? "none";
  const buttons = (opts.buttons ?? []).slice(0, MAX_PAD_BUTTONS);
  const haptic = opts.haptic !== false;
  const emit = opts.onInput;

  document.getElementById(HOST_ID)?.remove();

  const host = document.createElement("div");
  host.id = HOST_ID;
  host.style.cssText = "position:fixed;inset:0;z-index:2147483645;pointer-events:none";
  if (opts.color) host.style.setProperty("--pad-c", opts.color);

  const shadow = host.attachShadow({ mode: "open" });
  const stickHtml =
    stickMode === "none" ? "" : `<div class="stick" data-stick><i class="knob"></i></div>`;
  const buttonHtml = buttons
    .map(
      (b) =>
        `<button class="btn${b.hold ? " hold" : ""}" type="button" data-id="${b.id}">${b.label}</button>`,
    )
    .join("");
  shadow.innerHTML = `<style>${CSS}</style><div class="pad">${stickHtml}<div class="btns">${buttonHtml}</div></div>`;

  (document.body ?? document.documentElement).appendChild(host);

  const stickEl = shadow.querySelector("[data-stick]") as HTMLElement | null;
  const knobEl = shadow.querySelector(".knob") as HTMLElement | null;
  const btnEls = new Map<string, HTMLButtonElement>();
  for (const el of shadow.querySelectorAll<HTMLButtonElement>(".btn")) {
    btnEls.set(el.dataset.id ?? "", el);
  }

  let stickX = 0;
  let stickY = 0;
  let stickPointer: number | null = null;
  let lastStickSent = 0;
  let stickEnabled = true;
  const held = new Set<string>();

  function moveKnob() {
    if (!knobEl || !stickEl) return;
    const r = stickEl.getBoundingClientRect();
    const reach = Math.max(1, Math.min(r.width, r.height) / 2 - KNOB_HALF);
    knobEl.style.transform = `translate(${stickX * reach}px, ${stickY * reach}px)`;
  }

  function pushStick(force: boolean) {
    if (!stickEnabled) return;
    const now = performance.now();
    if (!force && now - lastStickSent < PAD_STICK_THROTTLE_MS) return;
    lastStickSent = now;
    emit({ type: "stick", x: stickX, y: stickY });
  }

  function setStick(x: number, y: number, force: boolean) {
    let nx = clamp1(x);
    let ny = clamp1(y);
    if (stickMode === "horizontal") ny = 0;
    else if (stickMode === "vertical") nx = 0;
    else {
      const len = Math.hypot(nx, ny);
      if (len > 1) {
        nx = nx / len;
        ny = ny / len;
      }
    }
    stickX = nx;
    stickY = ny;
    moveKnob();
    pushStick(force);
  }

  if (stickEl) {
    const fromEvent = (e: PointerEvent) => {
      const r = stickEl.getBoundingClientRect();
      const reach = Math.max(1, Math.min(r.width, r.height) / 2 - KNOB_HALF);
      const nx = (e.clientX - (r.left + r.width / 2)) / reach;
      const ny = (e.clientY - (r.top + r.height / 2)) / reach;
      setStick(nx, ny, false);
    };
    stickEl.addEventListener("pointerdown", (e) => {
      if (!stickEnabled) return;
      e.preventDefault();
      stickPointer = e.pointerId;
      try {
        stickEl.setPointerCapture(e.pointerId);
      } catch {
        /* 有的浏览器不支持捕获，退化为普通拖动 */
      }
      fromEvent(e);
    });
    stickEl.addEventListener("pointermove", (e) => {
      if (stickPointer !== e.pointerId) return;
      e.preventDefault();
      fromEvent(e);
    });
    const releaseStick = (e: PointerEvent) => {
      if (stickPointer !== null && e.pointerId !== stickPointer) return;
      stickPointer = null;
      setStick(0, 0, true);
    };
    stickEl.addEventListener("pointerup", releaseStick);
    stickEl.addEventListener("pointercancel", releaseStick);
    stickEl.addEventListener("contextmenu", (e) => e.preventDefault());
    moveKnob();
  }

  for (const spec of buttons) {
    const el = btnEls.get(spec.id);
    if (!el) continue;
    const press = (e: PointerEvent) => {
      e.preventDefault();
      if (el.classList.contains("off")) return;
      try {
        el.setPointerCapture(e.pointerId);
      } catch {
        /* 忽略 */
      }
      el.classList.add("on");
      if (haptic) buzz(12);
      emit({ type: "button", id: spec.id, down: true });
      if (spec.hold) held.add(spec.id);
      else emit({ type: "button", id: spec.id, down: false });
    };
    const lift = (e: PointerEvent) => {
      if (e.type === "pointerleave") {
        try {
          if (el.hasPointerCapture(e.pointerId)) return;
        } catch {
          /* 忽略 */
        }
      }
      e.preventDefault();
      el.classList.remove("on");
      if (!spec.hold) return;
      if (!held.delete(spec.id)) return;
      emit({ type: "button", id: spec.id, down: false });
    };
    el.addEventListener("pointerdown", press);
    el.addEventListener("pointerup", lift);
    el.addEventListener("pointercancel", lift);
    el.addEventListener("pointerleave", lift);
    el.addEventListener("contextmenu", (e) => e.preventDefault());
  }

  // input 是尽力送达的，持续状态必须周期重发，否则丢一次包就「卡住不放」。
  const timer = setInterval(() => {
    if (stickEnabled && (stickX !== 0 || stickY !== 0)) {
      emit({ type: "stick", x: stickX, y: stickY });
    }
    for (const id of held) emit({ type: "button", id, down: true });
  }, PAD_HEARTBEAT_MS);

  // 切到别的 App 再回来时，手指已经不在屏幕上了，必须主动松开，避免角色一直走。
  const releaseAll = () => {
    stickPointer = null;
    if (stickX !== 0 || stickY !== 0) setStick(0, 0, true);
    for (const id of [...held]) {
      held.delete(id);
      btnEls.get(id)?.classList.remove("on");
      emit({ type: "button", id, down: false });
    }
  };
  const onHidden = () => {
    if (document.hidden) releaseAll();
  };
  window.addEventListener("blur", releaseAll);
  document.addEventListener("visibilitychange", onHidden);
  window.addEventListener("pagehide", releaseAll);

  return {
    setEnabled(map) {
      for (const [id, on] of Object.entries(map)) {
        const el = btnEls.get(id);
        if (!el) continue;
        el.classList.toggle("off", !on);
        if (!on && held.delete(id)) {
          el.classList.remove("on");
          emit({ type: "button", id, down: false });
        }
      }
    },
    setStickEnabled(on) {
      stickEnabled = on;
      stickEl?.classList.toggle("off", !on);
      if (!on && (stickX !== 0 || stickY !== 0)) {
        stickPointer = null;
        setStick(0, 0, true);
      }
    },
    destroy() {
      clearInterval(timer);
      window.removeEventListener("blur", releaseAll);
      document.removeEventListener("visibilitychange", onHidden);
      window.removeEventListener("pagehide", releaseAll);
      host.remove();
    },
  };
}

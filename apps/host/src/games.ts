import {
  MAX_PAD_BUTTONS,
  PAD_STICKS,
  type GameInfo,
  type Manifest,
  type PadButton,
  type PadSpec,
  type PlayMode,
} from "@family/protocol";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const ID_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const VER_RE = /^\d+\.\d+\.\d+/;
const PAD_ID_RE = /^[a-z0-9_]+$/;
const MODES: PlayMode[] = ["personal", "shared-screen", "hybrid"];

export type ManifestResult =
  | { ok: true; manifest: Manifest; info: GameInfo }
  | { ok: false; info: GameInfo };

type PadResult = { ok: true; pad?: PadSpec } | { ok: false; error: string };

/** 校验 manifest.pad。不写 pad 表示这款游戏自己做手柄页，不算错。 */
export function validatePad(raw: unknown): PadResult {
  if (raw === undefined) return { ok: true };
  if (!raw || typeof raw !== "object") return { ok: false, error: "pad 需要是对象" };
  const spec = raw as Partial<PadSpec>;

  let stick: PadSpec["stick"];
  if (spec.stick !== undefined) {
    if (!PAD_STICKS.includes(spec.stick)) {
      return { ok: false, error: `pad.stick 只能是 ${PAD_STICKS.join(" / ")}` };
    }
    if (spec.stick !== "none") stick = spec.stick;
  }

  let buttons: PadButton[] | undefined;
  if (spec.buttons !== undefined) {
    if (!Array.isArray(spec.buttons)) return { ok: false, error: "pad.buttons 需要是数组" };
    if (spec.buttons.length > MAX_PAD_BUTTONS) {
      return { ok: false, error: `pad.buttons 最多 ${MAX_PAD_BUTTONS} 个` };
    }
    buttons = [];
    const seen = new Set<string>();
    for (const entry of spec.buttons) {
      if (!entry || typeof entry !== "object") {
        return { ok: false, error: "pad.buttons 里每一项都要是对象" };
      }
      const item = entry as Partial<PadButton>;
      if (typeof item.id !== "string" || !PAD_ID_RE.test(item.id)) {
        return { ok: false, error: "pad.buttons 的 id 只能是小写字母、数字和下划线" };
      }
      if (seen.has(item.id)) return { ok: false, error: `pad.buttons 的 id 重复：${item.id}` };
      seen.add(item.id);
      if (typeof item.label !== "string" || !item.label.trim()) {
        return { ok: false, error: `pad.buttons 的 ${item.id} 缺少 label` };
      }
      const button: PadButton = { id: item.id, label: item.label.trim() };
      if (item.hold !== undefined) button.hold = !!item.hold;
      buttons.push(button);
    }
  }

  const pad: PadSpec = {};
  if (stick) pad.stick = stick;
  if (buttons?.length) pad.buttons = buttons;
  return { ok: true, pad: Object.keys(pad).length ? pad : undefined };
}

export function validateManifest(
  raw: unknown,
  folderId: string,
  gamesDir: string,
): ManifestResult {
  const source = raw as Partial<Manifest> | undefined;
  const base = (partial: Partial<GameInfo>, error: string): GameInfo => ({
    id: folderId,
    name: typeof source?.name === "string" ? source.name : folderId,
    version: typeof source?.version === "string" ? source.version : "0.0.0",
    description: typeof source?.description === "string" ? source.description : "",
    minPlayers: 1,
    maxPlayers: 8,
    playMode: "personal",
    supportsTV: false,
    usesSave: false,
    tickHz: 20,
    broken: true,
    error,
    hasServer: false,
    entries: {},
    ...partial,
  });

  if (!raw || typeof raw !== "object") {
    return { ok: false, info: base({}, "manifest 不是对象") };
  }
  const m = raw as Manifest;
  if (m.id !== folderId) {
    return { ok: false, info: base({}, `id 必须与文件夹名一致（${folderId}）`) };
  }
  if (typeof m.id !== "string" || !ID_RE.test(m.id)) {
    return { ok: false, info: base({}, "id 只能是小写字母、数字和连字符") };
  }
  if (typeof m.name !== "string" || !m.name.trim()) {
    return { ok: false, info: base({}, "缺少 name") };
  }
  if (typeof m.version !== "string" || !VER_RE.test(m.version)) {
    return { ok: false, info: base({}, "version 需要类似 1.0.0") };
  }
  if (typeof m.minPlayers !== "number" || typeof m.maxPlayers !== "number") {
    return { ok: false, info: base({}, "缺少人数范围") };
  }
  if (m.minPlayers < 1 || m.maxPlayers > 16 || m.minPlayers > m.maxPlayers) {
    return { ok: false, info: base({}, "人数范围不合法") };
  }
  if (!MODES.includes(m.playMode)) {
    return { ok: false, info: base({}, "playMode 不合法") };
  }
  const padResult = validatePad(m.pad);
  if (!padResult.ok) {
    return { ok: false, info: base({ playMode: m.playMode }, padResult.error) };
  }
  if (!m.entry || typeof m.entry !== "object") {
    return { ok: false, info: base({}, "缺少 entry") };
  }

  const root = join(gamesDir, folderId);
  const missing: string[] = [];
  const need = (rel: string | undefined, label: string) => {
    if (!rel) {
      missing.push(`缺少 ${label}`);
      return;
    }
    if (rel.includes("..") || rel.startsWith("/") || rel.startsWith("\\")) {
      missing.push(`${label} 路径不合法`);
      return;
    }
    if (!existsSync(join(root, rel))) missing.push(`找不到 ${rel}`);
  };

  if (m.playMode === "personal") need(m.entry.player, "player 入口");
  if (m.playMode === "shared-screen" || m.playMode === "hybrid") {
    need(m.entry.display, "display 入口");
    need(m.entry.controller, "controller 入口");
  }
  if (m.entry.server) need(m.entry.server, "server 入口");
  if (missing.length) {
    return {
      ok: false,
      info: base({ playMode: m.playMode, hasServer: Boolean(m.entry.server) }, missing.join("；")),
    };
  }

  const entries = {
    player: m.entry.player ? `/games/${folderId}/${m.entry.player}` : undefined,
    display: m.entry.display ? `/games/${folderId}/${m.entry.display}` : undefined,
    controller: m.entry.controller ? `/games/${folderId}/${m.entry.controller}` : undefined,
  };
  const coverFile = m.cover && existsSync(join(root, m.cover)) ? `/games/${folderId}/${m.cover}` : undefined;

  const info: GameInfo = {
    id: m.id,
    name: m.name.trim(),
    version: m.version,
    description: m.description?.trim() ?? "",
    cover: coverFile,
    minPlayers: m.minPlayers,
    maxPlayers: m.maxPlayers,
    playMode: m.playMode,
    supportsTV: m.supportsTV ?? m.playMode !== "personal",
    usesSave: !!m.usesSave,
    tickHz: m.tickHz ?? 20,
    broken: false,
    hasServer: Boolean(m.entry.server),
    entries,
    ...(padResult.pad ? { pad: padResult.pad } : {}),
  };
  return { ok: true, manifest: m, info };
}

export class GameRegistry {
  games: GameInfo[] = [];
  manifests = new Map<string, Manifest>();

  constructor(private gamesDir: string) {}

  scan(): GameInfo[] {
    this.games = [];
    this.manifests.clear();
    let names: string[] = [];
    try {
      names = readdirSync(this.gamesDir);
    } catch {
      return this.games;
    }
    for (const name of names) {
      if (name.startsWith(".")) continue;
      const dir = join(this.gamesDir, name);
      try {
        if (!statSync(dir).isDirectory()) continue;
      } catch {
        continue;
      }
      const manifestPath = join(dir, "manifest.json");
      if (!existsSync(manifestPath)) {
        this.games.push({
          id: name,
          name,
          version: "0.0.0",
          description: "",
          minPlayers: 1,
          maxPlayers: 1,
          playMode: "personal",
          supportsTV: false,
          usesSave: false,
          tickHz: 20,
          broken: true,
          error: "缺少 manifest.json",
          hasServer: false,
          entries: {},
        });
        continue;
      }
      let raw: unknown;
      try {
        raw = JSON.parse(readFileSync(manifestPath, "utf8"));
      } catch {
        this.games.push({
          id: name,
          name,
          version: "0.0.0",
          description: "",
          minPlayers: 1,
          maxPlayers: 1,
          playMode: "personal",
          supportsTV: false,
          usesSave: false,
          tickHz: 20,
          broken: true,
          error: "manifest.json 无法解析",
          hasServer: false,
          entries: {},
        });
        continue;
      }
      const result = validateManifest(raw, name, this.gamesDir);
      if (result.ok) this.manifests.set(name, result.manifest);
      this.games.push(result.info);
    }
    this.games.sort((a, b) => a.name.localeCompare(b.name, "zh"));
    return this.games;
  }

  get(id: string): GameInfo | undefined {
    return this.games.find((g) => g.id === id);
  }

  serverScript(id: string): string | null {
    const rel = this.manifests.get(id)?.entry.server;
    if (!rel || rel.includes("..") || rel.startsWith("/") || rel.startsWith("\\")) return null;
    const full = join(this.gamesDir, id, rel);
    return existsSync(full) ? full : null;
  }
}

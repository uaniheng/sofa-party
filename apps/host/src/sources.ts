import type { Catalog, CatalogGame, SourceInfo } from "@family/protocol";
import { MAX_ZIP_BYTES } from "@family/protocol";
import type { Database } from "bun:sqlite";
import { mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  deleteSource,
  getSource,
  insertSource,
  listSources,
  recordInstalled,
  removeInstalled,
  updateSourceCatalog,
  type SourceRow,
} from "./db";
import { GameRegistry } from "./games";
import type { HostPaths } from "./paths";
import { unpackGameZip } from "./zip";

export type InstallProgress = {
  gameId: string;
  phase: "download" | "verify" | "unpack" | "done";
  message: string;
};

function toInfo(row: SourceRow): SourceInfo {
  let catalog: Catalog | null = null;
  if (row.catalog) {
    try {
      catalog = JSON.parse(row.catalog) as Catalog;
    } catch {
      catalog = null;
    }
  }
  return {
    id: row.id,
    name: row.name || row.url,
    url: row.url,
    enabled: row.enabled === 1,
    catalog,
  };
}

export class SourceManager {
  progress: InstallProgress | null = null;

  constructor(
    private db: Database,
    private paths: HostPaths,
    private games: GameRegistry,
  ) {}

  list(): SourceInfo[] {
    return listSources(this.db).map(toInfo);
  }

  add(url: string): SourceInfo {
    const row = insertSource(this.db, url);
    return toInfo(row);
  }

  remove(id: string) {
    deleteSource(this.db, id);
  }

  async refresh(id: string): Promise<SourceInfo> {
    const row = getSource(this.db, id);
    if (!row) throw Object.assign(new Error("找不到这个游戏源"), { error: "not_found" });
    const res = await fetch(row.url);
    if (!res.ok) throw Object.assign(new Error("拉目录失败"), { error: "fetch_failed" });
    const catalog = (await res.json()) as Catalog;
    if (!catalog || !Array.isArray(catalog.games)) {
      throw Object.assign(new Error("catalog 格式不对"), { error: "bad_catalog" });
    }
    updateSourceCatalog(this.db, id, catalog.name || row.name || row.url, JSON.stringify(catalog));
    return toInfo(getSource(this.db, id)!);
  }

  async install(sourceId: string, gameId: string) {
    const row = getSource(this.db, sourceId);
    if (!row) throw Object.assign(new Error("找不到这个游戏源"), { error: "not_found" });
    const info = toInfo(row);
    const item = info.catalog?.games.find((g) => g.id === gameId);
    if (!item) throw Object.assign(new Error("目录里没有这个游戏"), { error: "game_not_in_catalog" });
    await this.installCatalogGame(item, sourceId);
  }

  async installCatalogGame(item: CatalogGame, sourceId: string | null) {
    if (!item.sha256) {
      throw Object.assign(new Error("没有校验码，拒绝安装"), { error: "no_sha256" });
    }
    this.progress = { gameId: item.id, phase: "download", message: "正在下载" };
    const zipPath = join(this.paths.tmpDir, `${item.id}.zip`);
    const unpackPath = join(this.paths.tmpDir, `${item.id}-unpack`);
    mkdirSync(this.paths.tmpDir, { recursive: true });
    try {
      const res = await fetch(item.download);
      if (!res.ok) throw Object.assign(new Error("下载失败"), { error: "download_failed" });
      const size = Number(res.headers.get("content-length") ?? "0");
      if (size > MAX_ZIP_BYTES) {
        throw Object.assign(new Error("包太大了"), { error: "too_large" });
      }
      const buf = new Uint8Array(await res.arrayBuffer());
      if (buf.byteLength > MAX_ZIP_BYTES) {
        throw Object.assign(new Error("包太大了"), { error: "too_large" });
      }
      writeFileSync(zipPath, buf);

      this.progress = { gameId: item.id, phase: "verify", message: "正在校验" };
      const hash = new Bun.CryptoHasher("sha256").update(buf).digest("hex");
      if (hash !== item.sha256.toLowerCase()) {
        throw Object.assign(new Error("校验码对不上，没有安装"), { error: "sha256_mismatch" });
      }

      this.progress = { gameId: item.id, phase: "unpack", message: "正在解压" };
      unpackGameZip(buf, unpackPath, item.id);
      const dest = join(this.paths.gamesDir, item.id);
      rmSync(dest, { recursive: true, force: true });
      renameSync(unpackPath, dest);
      recordInstalled(this.db, item.id, item.version, sourceId);
      this.games.scan();
      this.progress = { gameId: item.id, phase: "done", message: "安装完成" };
    } finally {
      rmSync(zipPath, { force: true });
      rmSync(unpackPath, { recursive: true, force: true });
      setTimeout(() => {
        if (this.progress?.gameId === item.id && this.progress.phase === "done") this.progress = null;
      }, 2000);
    }
  }

  uninstall(gameId: string) {
    rmSync(join(this.paths.gamesDir, gameId), { recursive: true, force: true });
    removeInstalled(this.db, gameId);
    this.games.scan();
  }
}

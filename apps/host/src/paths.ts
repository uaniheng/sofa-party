import { mkdirSync } from "node:fs";
import { join } from "node:path";

export type HostPaths = {
  workdir: string;
  gamesDir: string;
  dataDir: string;
  tmpDir: string;
  sqlitePath: string;
  configPath: string;
  publicDir: string;
  sdkEntry: string;
};

export function resolveWorkdir(): string {
  if (process.env.FAMILY_GAME_DIR) return process.env.FAMILY_GAME_DIR;
  const here = import.meta.dir.replace(/\\/g, "/");
  if (here.endsWith("/apps/host/src")) return join(import.meta.dir, "..", "..", "..");
  return import.meta.dir;
}

export function resolvePaths(workdir = resolveWorkdir()): HostPaths {
  const here = import.meta.dir.replace(/\\/g, "/");
  const dataDir = join(workdir, "data");
  const tmpDir = join(dataDir, "tmp");
  mkdirSync(tmpDir, { recursive: true });
  mkdirSync(join(workdir, "games"), { recursive: true });
  const publicDir = here.endsWith("/apps/host/src")
    ? join(import.meta.dir, "..", "public")
    : join(workdir, "public");
  const sdkEntry = join(workdir, "packages", "sdk", "src", "game.ts");
  return {
    workdir,
    gamesDir: join(workdir, "games"),
    dataDir,
    tmpDir,
    sqlitePath: join(dataDir, "family.sqlite"),
    configPath: join(dataDir, "config.json"),
    publicDir,
    sdkEntry,
  };
}

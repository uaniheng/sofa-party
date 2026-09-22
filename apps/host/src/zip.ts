import { unzipSync } from "fflate";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export function isUnsafeZipPath(name: string): boolean {
  const n = name.replace(/\\/g, "/").replace(/\/+$/, "");
  if (!n || n.startsWith("/") || n.startsWith("~")) return true;
  if (/^[a-zA-Z]:/.test(n)) return true;
  return n.split("/").some((part) => part === ".." || part === "");
}

export function findZipManifestRoot(names: string[]): string | null {
  const normalized = names.map((n) => n.replace(/\\/g, "/"));
  if (normalized.includes("manifest.json")) return "";
  const nested = normalized.find((n) => /^[^/]+\/manifest\.json$/.test(n));
  if (nested) return nested.split("/")[0]!;
  return null;
}

export function unpackGameZip(bytes: Uint8Array, destDir: string, expectedId: string) {
  const files = unzipSync(bytes);
  const names = Object.keys(files);
  for (const name of names) {
    if (isUnsafeZipPath(name)) {
      throw Object.assign(new Error("压缩包路径不合法"), { error: "unsafe_path" });
    }
  }
  const root = findZipManifestRoot(names);
  if (root === null) {
    throw Object.assign(new Error("压缩包里没有 manifest.json"), { error: "no_manifest" });
  }
  const prefix = root ? `${root}/` : "";
  const manifestFile = files[`${prefix}manifest.json`];
  if (!manifestFile) {
    throw Object.assign(new Error("压缩包里没有 manifest.json"), { error: "no_manifest" });
  }
  let manifest: { id?: string };
  try {
    manifest = JSON.parse(new TextDecoder().decode(manifestFile));
  } catch {
    throw Object.assign(new Error("manifest.json 无法解析"), { error: "bad_manifest" });
  }
  if (manifest.id !== expectedId) {
    throw Object.assign(new Error("游戏 id 和要安装的不一致"), { error: "id_mismatch" });
  }

  rmSync(destDir, { recursive: true, force: true });
  mkdirSync(destDir, { recursive: true });
  for (const [name, data] of Object.entries(files)) {
    const n = name.replace(/\\/g, "/");
    if (prefix && !n.startsWith(prefix)) continue;
    const rel = prefix ? n.slice(prefix.length) : n;
    if (!rel || rel.endsWith("/")) continue;
    const out = join(destDir, ...rel.split("/"));
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, data);
  }
}

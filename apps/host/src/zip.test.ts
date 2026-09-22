import { describe, expect, test } from "bun:test";
import { zipSync } from "fflate";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { unpackGameZip } from "./zip";

describe("unpackGameZip", () => {
  const tmp = join(import.meta.dir, "..", "..", "..", "data", "tmp-zip-test");

  test("unpacks a nested game folder", () => {
    const zipped = zipSync({
      "quiz-party/manifest.json": new TextEncoder().encode(JSON.stringify({ id: "quiz-party" })),
      "quiz-party/player/index.html": new TextEncoder().encode("<html>ok</html>"),
    });
    const dest = join(tmp, "nested");
    unpackGameZip(zipped, dest, "quiz-party");
    expect(readFileSync(join(dest, "manifest.json"), "utf8")).toContain("quiz-party");
    expect(existsSync(join(dest, "player", "index.html"))).toBe(true);
    rmSync(tmp, { recursive: true, force: true });
  });

  test("rejects path traversal", () => {
    const zipped = zipSync({
      "../evil.json": new TextEncoder().encode("{}"),
      "manifest.json": new TextEncoder().encode(JSON.stringify({ id: "quiz-party" })),
    });
    expect(() => unpackGameZip(zipped, join(tmp, "evil"), "quiz-party")).toThrow();
    rmSync(tmp, { recursive: true, force: true });
  });

  test("rejects id mismatch", () => {
    const zipped = zipSync({
      "manifest.json": new TextEncoder().encode(JSON.stringify({ id: "other" })),
    });
    expect(() => unpackGameZip(zipped, join(tmp, "mismatch"), "quiz-party")).toThrow(/不一致/);
    rmSync(tmp, { recursive: true, force: true });
  });
});

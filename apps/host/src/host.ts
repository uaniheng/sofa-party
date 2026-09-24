import type { Database } from "bun:sqlite";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { MAX_SAVE_GAME_BYTES, MAX_SAVE_VALUE_BYTES } from "@family/protocol";
import { getSave, openDatabase, putSave, readHostConfig, saveGameBytes, saveValueBytes } from "./db";
import { GameRegistry } from "./games";
import { listLanAddresses, pickDefaultAddress } from "./lan";
import { GameLogBuffer } from "./logs";
import { PartyRoom } from "./party";
import { resolvePaths, type HostPaths } from "./paths";
import { LocalCerts } from "./certs";
import { SourceManager } from "./sources";

function readSaveValue(db: Database, gameId: string, playerId: string, key: string): unknown {
  const raw = getSave(db, gameId, playerId, key);
  if (raw === undefined) return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

function writeSaveValue(db: Database, gameId: string, playerId: string, key: string, value: unknown): string | null {
  let text: string;
  try {
    text = JSON.stringify(value ?? null);
  } catch {
    return "存档不能序列化";
  }
  const nextBytes = new TextEncoder().encode(text).length;
  if (nextBytes > MAX_SAVE_VALUE_BYTES) return "这一条存档太大了";
  const old = saveValueBytes(db, gameId, playerId, key);
  if (saveGameBytes(db, gameId) - old + nextBytes > MAX_SAVE_GAME_BYTES) return "这个游戏的存档合计太大了";
  putSave(db, gameId, playerId, key, text);
  return null;
}

export class HostApp {
  paths: HostPaths;
  db: Database;
  games: GameRegistry;
  party: PartyRoom;
  sources: SourceManager;
  logs: GameLogBuffer;
  lanAddresses: string[];
  selectedAddress: string | null;
  port: number;
  certs: LocalCerts;

  constructor(port = Number(process.env.PORT ?? 8080), httpsPort = 8443) {
    this.port = port;
    this.paths = resolvePaths();
    this.db = openDatabase(this.paths);
    this.games = new GameRegistry(this.paths.gamesDir);
    this.games.scan();
    this.logs = new GameLogBuffer();
    this.party = new PartyRoom(this.games, {
      log: (input) => this.logs.write(input),
      readSave: (gameId, playerId, key) => readSaveValue(this.db, gameId, playerId, key),
      writeSave: (gameId, playerId, key, value) => writeSaveValue(this.db, gameId, playerId, key, value),
    });
    this.sources = new SourceManager(this.db, this.paths, this.games);
    this.lanAddresses = listLanAddresses();
    const saved = readHostConfig(this.paths).selectedAddress ?? null;
    this.selectedAddress = pickDefaultAddress(this.lanAddresses, saved);
    this.certs = new LocalCerts(join(this.paths.dataDir, "certs"), httpsPort);
    this.certs.rememberExisting();
  }

  issueCert() {
    this.certs.issue(this.certificateIps());
  }

  meta() {
    this.lanAddresses = listLanAddresses();
    if (this.selectedAddress && !this.lanAddresses.includes(this.selectedAddress)) {
      this.selectedAddress = pickDefaultAddress(this.lanAddresses, null);
    }
    const host = this.selectedAddress ?? "127.0.0.1";
    return {
      port: this.port,
      joinUrl: `http://${host}:${this.port}/`,
      screenUrl: `http://${host}:${this.port}/s`,
      lanAddresses: this.lanAddresses,
      selectedAddress: this.selectedAddress,
      cert: this.certs.status(this.selectedAddress, this.port, this.certificateIps()),
    };
  }

  private certificateIps(): string[] {
    return this.selectedAddress ? [...this.lanAddresses, this.selectedAddress] : this.lanAddresses;
  }

  async sdkJavascript(): Promise<string> {
    const built = join(this.paths.publicDir, "sdk", "game.js");
    if (existsSync(built)) return readFileSync(built, "utf8");
    const result = await Bun.build({
      entrypoints: [this.paths.sdkEntry],
      format: "esm",
      target: "browser",
    });
    if (!result.success) {
      const logs = result.logs.map((l) => String(l)).join("\n");
      throw new Error(logs || "SDK 构建失败");
    }
    return await result.outputs[0]!.text();
  }

  shellIndex(): string | null {
    const file = join(this.paths.publicDir, "index.html");
    if (!existsSync(file)) return null;
    return readFileSync(file, "utf8");
  }
}

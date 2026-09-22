export const PROTOCOL_VERSION = "1.0.0";
export const SDK_VERSION = "1.0.0";

export const MAX_PLAYERS_TOTAL = 16;
export const MAX_SAVE_VALUE_BYTES = 64 * 1024;
export const MAX_SAVE_GAME_BYTES = 1024 * 1024;
export const MAX_GAME_MESSAGE_BYTES = 64 * 1024;
export const MAX_INPUT_BYTES = 2 * 1024;
export const MAX_INPUT_HZ = 30;
export const MAX_ZIP_BYTES = 80 * 1024 * 1024;
export const MAX_PLAYER_NAME = 12;
export const MAX_LOG_ENTRIES = 500;
export const MAX_LOG_MESSAGE_BYTES = 2 * 1024;
export const MAX_LOG_HZ = 20;

export const PLAYER_COLORS = [
  "#4C8BF5",
  "#E74C3C",
  "#2ECC71",
  "#F39C12",
  "#9B59B6",
  "#1ABC9C",
  "#E67E22",
  "#3498DB",
  "#E91E63",
  "#00BCD4",
  "#8BC34A",
  "#FF5722",
  "#3F51B5",
  "#009688",
  "#FFC107",
  "#795548",
] as const;

export type PlayMode = "personal" | "shared-screen" | "hybrid";
export type Phase = "idle" | "playing";
export type ConnRole = "display" | "player";
export type PageRole = "player" | "display" | "controller";
export type View = "lobby" | "game-display" | "game-player" | "game-controller" | "wait";
export type Authority = "host" | "starter";
export type SaveScope = "private" | "shared";
export type SendTo = "all" | "display" | "players" | { playerId: string };
export type GameLogLevel = "debug" | "info" | "warn" | "error";
export type GameLogSource = "game" | "host" | "server";

export type PlayerPublic = {
  id: string;
  name: string;
  color: string;
};

export type PlayerRecord = PlayerPublic & {
  createdAt: number;
  updatedAt: number;
};

export type GameEntries = {
  player?: string;
  display?: string;
  controller?: string;
};

export type GameInfo = {
  id: string;
  name: string;
  version: string;
  description: string;
  cover?: string;
  minPlayers: number;
  maxPlayers: number;
  playMode: PlayMode;
  supportsTV: boolean;
  usesSave: boolean;
  tickHz: number;
  broken: boolean;
  error?: string;
  hasServer: boolean;
  entries: GameEntries;
};

export type Manifest = {
  id: string;
  name: string;
  version: string;
  description?: string;
  cover?: string;
  minPlayers: number;
  maxPlayers: number;
  playMode: PlayMode;
  supportsTV?: boolean;
  usesSave?: boolean;
  tickHz?: number;
  entry: {
    player?: string;
    display?: string;
    controller?: string;
    server?: string;
  };
};

export type PartySnapshot = {
  phase: Phase;
  gameId: string | null;
  playMode: PlayMode | null;
  starterPlayerId: string | null;
  displayConnected: boolean;
  displayCount: number;
  online: PlayerPublic[];
};

export type PartyStateMessage = {
  type: "party.state";
  phase: Phase;
  gameId: string | null;
  playMode: PlayMode | null;
  starterPlayerId: string | null;
  displayConnected: boolean;
  displayCount: number;
  online: PlayerPublic[];
  view: View;
  isAuthority: boolean;
  entries: GameEntries | null;
};

export type WsHello =
  | { type: "hello"; role: "display" }
  | { type: "hello"; role: "player"; token: string }
  | { type: "hello"; role: "watcher" };

export type WsClientMessage =
  | WsHello
  | { type: "party.start"; gameId: string }
  | { type: "party.end" }
  | { type: "game"; to: SendTo; payload: unknown }
  | { type: "input"; payload: unknown }
  | { type: "state"; payload: unknown }
  | { type: "log"; level?: GameLogLevel; message: string; data?: unknown };

export type WsServerMessage =
  | { type: "hello.ok"; role: "display" }
  | { type: "hello.ok"; role: "player"; me: PlayerPublic }
  | { type: "hello.ok"; role: "watcher" }
  | { type: "hello.err"; error: string; message: string }
  | { type: "display.replaced" }
  | { type: "player.kicked" }
  | { type: "player.replaced" }
  | PartyStateMessage
  | {
      type: "party.start";
      gameId: string;
      playMode: PlayMode;
      starterPlayerId: string;
      view: View;
      isAuthority: boolean;
      entries: GameEntries;
    }
  | { type: "party.end" }
  | { type: "member.online"; player: PlayerPublic }
  | { type: "member.offline"; playerId: string }
  | { type: "roster"; onlineIds: string[] }
  | { type: "display.ready" }
  | { type: "display.gone" }
  | { type: "game"; from?: string; payload: unknown }
  | { type: "input"; playerId: string; payload: unknown }
  | { type: "state"; payload: unknown }
  | { type: "error"; error: string; message: string };

export type ApiError = {
  error: string;
  message: string;
};

export type MetaResponse = {
  port: number;
  joinUrl: string;
  screenUrl: string;
  lanAddresses: string[];
  selectedAddress: string | null;
};

export type CatalogGame = {
  id: string;
  name: string;
  version: string;
  description?: string;
  cover?: string;
  download: string;
  sha256: string;
  size?: number;
  minPlayers?: number;
  maxPlayers?: number;
  playMode?: PlayMode;
  supportsTV?: boolean;
  sdkRange?: string;
};

export type Catalog = {
  name: string;
  homepage?: string;
  games: CatalogGame[];
};

export type SourceInfo = {
  id: string;
  name: string;
  url: string;
  enabled: boolean;
  catalog: Catalog | null;
};

export type GameLogEntry = {
  id: number;
  ts: number;
  level: GameLogLevel;
  source: GameLogSource;
  gameId: string | null;
  role?: PageRole | ConnRole;
  playerId?: string;
  playerName?: string;
  message: string;
  data?: unknown;
};

export type LogsResponse = {
  gameId: string | null;
  entries: GameLogEntry[];
};

export const STORAGE_TOKEN = "family-game:token";
export const STORAGE_ME = "family-game:me";
export const SESSION_TOKEN = "family-game:token";
export const SESSION_GAME_ID = "family-game:gameId";
export const SESSION_ROLE = "family-game:role";

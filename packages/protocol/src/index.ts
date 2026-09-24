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

export const MAX_PAD_BUTTONS = 8;
export const PAD_STICKS = ["none", "horizontal", "vertical", "free"] as const;
/** 按住状态重发间隔。input 是尽力送达的，持续状态必须周期重发才不会卡住。 */
export const PAD_HEARTBEAT_MS = 60;
/** 摇杆变化的最小发送间隔，避免超出 MAX_INPUT_HZ。 */
export const PAD_STICK_THROTTLE_MS = 34;

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
/** 一条真实连接的身份。watcher 不算连接，只是旁听的发送端。 */
export type ConnRole = "display" | "player";
/** 握手时可以声明的身份。watcher 只收占用名单，不会成为一条 Conn。 */
export type HelloRole = ConnRole | "watcher";
export type PageRole = "player" | "display" | "controller";
export type View = "lobby" | "game-display" | "game-player" | "game-controller" | "wait";
export type Authority = "host" | "starter";
export type SaveScope = "private" | "shared";
export type SendTo = "all" | "display" | "players" | { playerId: string };
export type GameLogLevel = "debug" | "info" | "warn" | "error";
export type GameLogSource = "game" | "host" | "server";

/** 摇杆能用哪个轴。none 表示这款游戏不需要摇杆。 */
export type PadStick = (typeof PAD_STICKS)[number];

export type PadButton = {
  /** 发给服务端的 id，只能小写字母、数字和下划线。 */
  id: string;
  /** 按钮上显示的中文短词。 */
  label: string;
  /**
   * 按住键：按下时发 down:true 并周期性重发，松开才发 down:false。
   * 适合「格挡」「蓄力」这类状态型操作，服务端按布尔状态处理。
   * 点按键（默认）只在按下那一刻发一组 down:true + down:false，
   * 适合「出拳」「跳跃」这类一次性动作，不会被重发重复触发。
   */
  hold?: boolean;
};

/** 游戏在 manifest 里声明它需要一只什么样的手柄。 */
export type PadSpec = {
  stick?: PadStick;
  buttons?: PadButton[];
};

/** 官方手柄控件发出的输入。服务端照这个形状解析即可。 */
export type PadInput =
  | { type: "stick"; x: number; y: number }
  | { type: "button"; id: string; down: boolean };

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
  /** 这款游戏声明的手柄布局。没有声明则没有官方手柄控件。 */
  pad?: PadSpec;
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
  /** 声明手柄布局，交给官方控件渲染。不写则由游戏自己做手柄页。 */
  pad?: PadSpec;
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

export type WsHello = {
  [R in HelloRole]: R extends "player"
    ? { type: "hello"; role: R; token: string }
    : { type: "hello"; role: R };
}[HelloRole];

export type WsHelloOk = {
  [R in HelloRole]: R extends "player"
    ? { type: "hello.ok"; role: R; me: PlayerPublic }
    : { type: "hello.ok"; role: R };
}[HelloRole];

export type WsClientMessage =
  | WsHello
  | { type: "party.start"; gameId: string }
  | { type: "party.end" }
  | { type: "game"; to: SendTo; payload: unknown }
  | { type: "input"; payload: unknown }
  | { type: "state"; payload: unknown }
  | { type: "log"; level?: GameLogLevel; message: string; data?: unknown };

export type WsServerMessage =
  | WsHelloOk
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

/** 本机证书库的安装结果。unknown 表示还没点过安装。手机要另扫二维码自己装。 */
export type LocalTrust = "unknown" | "trusted" | "pending" | "failed";

/** 家里这台主机给手机准备的 https 证书。只有管理页点过生成，issued 才为 true。 */
export type CertStatus = {
  issued: boolean;
  /** 当前选中的局域网地址是否写在证书里。 */
  coversAddress: boolean;
  downloadUrl: string;
  httpsJoinUrl: string | null;
  httpsPort: number;
  httpsError: string | null;
  localTrust: LocalTrust;
  localTrustMessage: string;
};

export type MetaResponse = {
  port: number;
  joinUrl: string;
  screenUrl: string;
  lanAddresses: string[];
  selectedAddress: string | null;
  cert: CertStatus;
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

# 沙发派对 · 服务框架

> 对应需求：`docs/requirements.md` v0.20  
> 范围：只写 **主机（服务框架）** 怎么实现。游戏怎么开发见 `docs/game-module.md`。  
> 版本：v0.9

---

## 1. 这份文档解决什么

实现 **沙发派对**：跑在家里电脑上的那一个进程，给电视和手机提供网页、记住家里的人、装游戏、转发消息、可选地跑某款游戏的主机脚本。

**框架要做**

- HTTP 静态页 + 少量 JSON API  
- WebSocket 长连接  
- SQLite：成员档案、存档、游戏源配置  
- 扫描 / 安装游戏包  
- 唯一一场「聚会」的状态  

**框架不做**

- 具体玩法规则（除非该游戏带了 `server` 脚本，由框架 **加载**，不由框架 **编写**）  
- 房间号、多桌  
- 云账号  

---

## 2. 总结构

```
电脑上的主机进程
├── 管理页（只给这台电脑看也可以，实际是普通网页）
│     大屏地址（超大字）、手机二维码、「本机当大屏」
├── 大屏页   GET /screen     → 电视浏览器
├── 加入页   GET /           → 手机浏览器
├── 游戏静态文件 GET /games/{id}/...
├── JSON API
└── WebSocket /ws
      ├── role=display   大屏（最多 1 条）
      └── role=player    已认领档案的手机
            开玩后页面换成「个人游戏」或「手柄」，连接身份不变
```

同一时刻只有一款游戏在进行。没有 `roomId`。

权威规则在哪边算，由游戏声明；框架只保证：**每条连接有身份，消息能按身份送到。**

---

## 3. 技术选型（已定）

| 部分 | 选择 |
|------|------|
| 运行时 | Bun + TypeScript |
| HTTP | Hono |
| 实时 | WebSocket（Bun 原生即可，不必上 Socket.IO） |
| 数据 | `bun:sqlite` |
| 大厅 / 大屏 / 加入 / 管理外壳 | Vite + Svelte 5 |
| 二维码 | 选一个小库（如 `uqr`）在服务端生成 SVG/PNG |
| 压缩包 | 校验 sha256 后解压；解压库选 Bun 能用的 unzip |
| 发行 | `bun build --compile` 打成单文件 |

开发机需要安装 Bun。发给家人的是编译产物，不要求他们装 Bun。

---

## 4. 仓库布局（建议）

```
game-service/
  apps/host/                 # 主机进程
  apps/web/                  # Svelte 外壳：管理 / 大屏 / 加入 / 大厅
  packages/protocol/         # 前后端共用的消息与 API 类型
  packages/sdk/              # 给游戏网页用（本篇只约定框架要支持的通道，SDK 细节另写）
  apps/host/src/server-loader.ts  # 工作线程里加载游戏 server.js
  games/                     # 运行时已安装模块（可进 git 放示例）
  data/                      # sqlite、下载临时文件（不进 git）
  docs/
```

`apps/host` 负责：找局域网 IP、听端口、挂静态资源、WS、SQLite、装游戏。  
`apps/web` 构建产物由 host 托管，路径如下。

---

## 5. 启动与目录

### 5.1 工作目录

可执行文件旁边（或开发时的仓库根）：

```
sofa-party.exe
games/                 # 已装游戏
data/
  family.sqlite
  tmp/                 # 下载 zip 的临时目录
sources.json           # 已添加的游戏源，也可放进 sqlite
```

端口默认 `8080`，可用环境变量或启动参数改：`PORT=8080`。

绑定 `0.0.0.0`。启动时枚举网卡，挑一个局域网 IPv4（排除 `127.0.0.1`），打印：

```
加入（手机）： http://192.168.1.8:8080/
大屏（电视手输）： http://192.168.1.8:8080/s
管理（本机）： http://127.0.0.1:8080/admin
```

`/s` 与 `/screen` 同一页。管理页：**大屏 URL 超大号字体**（电视遥控器对着打），**二维码只生成加入页**。默认不要自动打开 `/screen`。提供按钮：本机打开 `/screen`（电脑已接到电视时用）。

若有多块网卡，管理页列出候选 IP，可手选「家里 Wi‑Fi 那块」。

### 5.2 网页路由（外壳）

| 路径 | 谁打开 | 作用 |
|------|--------|------|
| `/screen` 或 `/s` | 电视（手输地址） | 大屏：空闲时大厅；开玩时加载游戏的 display 页 |
| `/admin` | 电脑 | 超大字大屏 URL、手机加入码、本机当大屏、游戏源 |
| `/` | 手机 | 选人 → 大厅；开玩时加载 player 或 controller 页 |
| `/games/{id}/...` | 游戏页 | 模块静态文件 |
| `/sdk/...` | 游戏页 | 框架提供的浏览器 SDK |

大屏和手机大厅都是外壳。开始游戏后，外壳用 iframe 或同域跳转到 `/games/{id}/display/` 等入口；**WebSocket 仍由外壳维持**，通过 `postMessage` 或注入的 SDK 把通道交给游戏页。推荐：**SDK 自己连 WS**（游戏页与外壳同域），用 cookie/token，外壳只负责跳转。

同域更简单：游戏入口是 `/games/{id}/display/index.html`，SDK 连 `/ws`。外壳在跳转前把 token 放进 `sessionStorage`。

---

## 6. 数据存储

一个 SQLite 文件。框架自己建表，游戏不准直接碰这个库。

### 6.1 成员档案 `players`

| 列 | 类型 | |
|----|------|--|
| id | TEXT PK | UUID |
| name | TEXT UNIQUE | 显示名 |
| color | TEXT | 如 `#4C8BF5` |
| created_at | INTEGER | unix ms |
| updated_at | INTEGER | |

上限建议 16 条。创建时服务端分配 id 和颜色（轮询一组预设色）。

### 6.2 认领凭证 `player_tokens`

| 列 | 类型 | |
|----|------|--|
| token | TEXT PK | 随机 32 字节 hex |
| player_id | TEXT | |
| created_at | INTEGER | |

手机选人成功后下发 token，存 `localStorage`。WS 握手必须带这个 token。  
同一 `player_id` 同时只允许一个人占用：**先选到的人占住**。别人再 claim 或用别的 token 握手会失败。同一份 token 刷新本机页面，可以顶掉自己的旧连接。  

选人页（还未认领）用 `role=watcher` 收占用名单，实时灰掉已选走的名字。

不设密码。删除档案时删其 token 和私有存档。

### 6.3 存档 `saves`

| 列 | 类型 | |
|----|------|--|
| game_id | TEXT | |
| player_id | TEXT NULL | NULL = 全家共享 |
| key | TEXT | |
| value | TEXT | JSON 文本 |
| updated_at | INTEGER | |

主键：`(game_id, player_id, key)`，共享档用 `player_id = ''`。

限制：单 value ≤ 64KiB；单 `game_id` 合计 ≤ 1MiB。超出 API 返回错误。

卸载游戏默认 **不删** 存档。提供管理 API 清除某 `game_id`。

### 6.4 游戏源 `sources`

| 列 | 类型 | |
|----|------|--|
| id | TEXT PK | |
| name | TEXT | 拉取 catalog 后填 |
| url | TEXT UNIQUE | catalog.json |
| enabled | INTEGER | 0/1 |

已装游戏记录 `installed_games`：`id, version, source_id, installed_at`。本地拷贝的 `source_id` 为空。

---

## 7. HTTP API

统一 JSON。家庭网里管理接口（改网卡、踢人、装游戏、清存档、看日志）**不另做登录**。谁连上这台主机就能调。

### 7.1 系统

`GET /api/meta`

```json
{
  "port": 8080,
  "joinUrl": "http://192.168.1.8:8080/",
  "screenUrl": "http://192.168.1.8:8080/screen",
  "lanAddresses": ["192.168.1.8"]
}
```

`GET /api/qr?kind=join|screen` → SVG。

### 7.2 档案

`GET /api/players` → `[{ id, name, color, online }]`

`POST /api/players` `{ "name": "小明" }` → `{ id, name, color, token }`  
重名 409。

`POST /api/players/claim` `{ "playerId": "..." }` → `{ token, player }`  
这个人已被占用则 **409** `taken`（「已经被选走了」）。创建新名字同样：点创建即占住。

`POST /api/players/leave` 带当前 token：主动让出角色，立刻解除占用。这是让出角色的唯一入口，选人页「换一个人」走这里。

`POST /api/players/:id/kick` 管理页：踢下线，发 `player.kicked`，作废 token，名字立刻可再选。不删档案。

`PATCH /api/players/:id` `{ "name" }` 改名后推一次 `roster`，选人页据此重新拉名单。  
`DELETE /api/players/:id` 管理删除档案。

### 7.3 聚会状态（只读，实时以 WS 为准）

`GET /api/party`

```json
{
  "phase": "idle",
  "gameId": null,
  "playMode": null,
  "starterPlayerId": null,
  "displayConnected": false,
  "displayCount": 0,
  "online": [{ "id": "...", "name": "小明", "color": "#..." }]
}
```

`phase`：`idle` | `playing`。开始和结束只走第 8 节的 `party.start` / `party.end`，规则见第 9 节。

### 7.4 游戏列表

`GET /api/games` 扫描 `games/*/manifest.json`，坏包标 `broken: true`。

`POST /api/games/refresh` 重新扫描。

### 7.5 存档（游戏 SDK 用，须带玩家 token 或 server 内部调用）

`GET /api/saves/:gameId?scope=private|shared&key=...`  
`PUT /api/saves/:gameId` `{ "scope": "private"|"shared", "key": "...", "value": {} }`

校验：当前 `party.gameId === gameId`，且 token 对应在线玩家。  
`server` 脚本走进程内函数，不走 HTTP。

### 7.6 游戏源（管理）

`GET /api/sources`  
`POST /api/sources` `{ "url": "https://..." }`  
`DELETE /api/sources/:id`  
`POST /api/sources/:id/refresh` 拉 catalog  
`POST /api/sources/:id/install` `{ "gameId": "quiz-party" }`  
`POST /api/games/:id/uninstall` `{ "purgeSaves": false }`

安装流程见第 11 节。

### 7.7 游戏日志（管理，给开发者看）

电视和手机浏览器不好开开发者工具。游戏页和主机把排错信息集中写到主机内存，**只在管理页看**。

不进 SQLite，重启进程即清空。环形缓冲，默认最多 **500** 条。

`GET /api/logs?after={id}`

```json
{
  "gameId": "quiz-party",
  "entries": [
    {
      "id": 12,
      "ts": 1774000000123,
      "level": "error",
      "source": "game",
      "gameId": "quiz-party",
      "role": "player",
      "playerId": "...",
      "playerName": "小明",
      "message": "Uncaught TypeError: ...",
      "data": { "file": "app.js", "line": 40 }
    }
  ]
}
```

- `after`：只返回 `id > after` 的新条目；省略或 `0` 则从缓冲里仍在的最早一条开始。  
- `gameId`：当前正在玩的游戏，空闲为 `null`。  
- `level`：`debug` | `info` | `warn` | `error`。  
- `source`：`game`（网页 SDK）| `host`（框架自己）| `server`（`server.js`）。  

`DELETE /api/logs` 清空缓冲。

管理页每秒左右轮询 `after`，**不要**把管理页接到聚会 WS。家人不必看这块；做游戏的人开着 `/admin` 即可。

---

## 8. WebSocket 协议

地址：`ws://{host}:{port}/ws`

### 8.1 握手（第一条客户端消息，或用 query）

推荐 **连接后第一条 JSON**：

大屏：

```json
{ "type": "hello", "role": "display" }
```

玩家：

```json
{ "type": "hello", "role": "player", "token": "..." }
```

服务端回：

```json
{ "type": "hello.ok", "role": "display" }
```

```json
{ "type": "hello.ok", "role": "player", "me": { "id": "", "name": "", "color": "" } }
```

失败：`hello.err`，然后断开。

规则：

- `role` 只能是 `display` | `player` | `watcher`。没有 `controller` 这种连接角色——手柄只是玩家连接在 `playMode=shared-screen` 时换了页面。  
- `watcher`：选人页用，不算玩家，只收占用名单。  
- 又来一块大屏：留下，和已有的一起收同一份坐标。新连上的补发最近一份。不再顶掉旧的。  
- token 无效：断开。  
- 同一 player 已被别人占用：`hello.err` `taken`，**不**踢当前那个人。同一份 token 重连可以顶掉自己的旧页（`player.replaced`，外壳不要清凭证、不要当被踢）。真正让出角色用 `POST /api/players/leave`，或管理页踢下线。这两条都会发 `player.kicked`；踢下线还会作废 token。  
- 玩家 WS 断开后座位先保留约 10 秒，方便进游戏页重连；超时仍未回来才释放名字。若是本局发起者且权威在 starter，超时才结束这局。进游戏时大厅卸掉连接不得立刻 `endParty`。

握手成功后推一次完整 `party.state`。

### 8.2 服务端 → 客户端

| type | 含义 | 发给谁 |
|------|------|--------|
| `party.state` | 完整快照：phase、gameId、playMode、starterId、displayConnected、online[]、各端应打开的页面 | 全体 |
| `party.start` | 开玩，带 `gameId`、`playMode`、各角色入口 URL | 全体 |
| `party.end` | 回大厅 | 全体 |
| `member.online` / `member.offline` | 某人上下线 | 玩家和大屏 |
| `roster` | 当前被占用的 playerId 列表。选人页收到后重新拉 `GET /api/players`，不另做定时轮询；这条连接断了会自己重连 | watcher |
| `display.ready` / `display.gone` | 从没有大屏到有，或从有到没有。中间增减不发。框架不暂停对局 | 玩家（游戏页经 SDK） |
| `game` | 透传玩法消息 | 见 to |
| `input` | 手柄输入（转给权威端） | 权威端 |
| `state` | 权威端的画面快照 | 大屏，必要时手柄 |
| `display.replaced` | 旧协议。现在不发。多块大屏同时留着 | — |
| `player.replaced` | 同一份 token 的新页顶掉旧页（不要清凭证） | 旧 player |
| `player.kicked` | 主动让出 / 管理删除，清凭证回选人 | 被踢的 player |
| `error` | 可读错误 | 请求方 |

`party.state` 里给每个连接一份 `view`：

- display + idle → `lobby`  
- display + playing + shared-screen/hybrid → `game-display`  
- player + idle → `lobby`  
- player + playing + personal → `game-player`  
- player + playing + shared-screen → `game-controller`  

外壳根据 `view` 跳转，不要游戏自己猜。

### 8.3 客户端 → 服务端

| type | 谁可以发 | 含义 |
|------|----------|------|
| `party.start` | player | `{ gameId }` |
| `party.end` | 已进这局的 player（含手柄页；第一版任一在线玩家） | 整桌回大厅。SDK 在手机游戏页 / 手柄页提供菜单，不必游戏自己画退出按钮。大屏页不注入菜单。 |
| `game` | player / display | 透传 `{ to, payload }` |
| `input` | player | `{ payload }` 小包，权威端是谁由框架转发 |
| `state` | 负责计算的玩家（没有主机脚本时就是点开始的那位） | 画面快照，转给大屏和其他玩家。大屏不能发。有主机脚本时客户端不能发。 |
| `log` | player / display（已握手） | 开发日志，**只进主机缓冲，不转给其他人** |

`log` 形状：`{ "type": "log", "level": "info", "message": "...", "data": {} }`。  
`level` 缺省为 `info`；`message` 必填字符串。`data` 可选，必须能 JSON 序列化。  
限制：整条（含 data）≤ 2KiB；同一连接约 20 次/秒，超出丢弃（可偶尔 `error: rate_limited`）。框架不把 log 当玩法消息转发。

`game.to`：

- `all` 除自己外所有连接  
- `display`  
- `players` 所有玩家  
- `{ playerId }` 某个玩家  

框架 **不解析** `payload`。限制：`game` / `state` ≤ 64KiB；`input` ≤ 2KiB。  
`input` 建议 ≤ 30 次/秒，超出丢弃并偶尔 `error`。

### 8.4 权威端是谁（转发用）

开玩时框架记下 `authority`：

| 条件 | authority |
|------|-----------|
| 游戏有 `entry.server` 且已加载成功 | `host`（主机里的小游戏服务） |
| 否则，不论每人一屏还是大屏+手柄 | `starter`（点开始的那位玩家） |

大屏只是显示角色，**不算**权威，也不算玩家。手机、平板、电脑打开大屏地址，扮演的都是这一个角色。

转发：

- `input` → 只送给 authority（玩家计算端，或将来的主机脚本）  
- 若 authority 是 `host`：由主机脚本收，再把 `state` 给大屏，把需要的消息给玩家  
- 客户端发来的 `state`：仅当发送者就是 `starter` 权威时，转给大屏和其他在局玩家；否则丢弃  

display 不在线且本局需要 display（shared-screen）：`party.start` 直接失败，见第 9 节。用户打开大屏后再点一次。

---

## 9. 聚会状态机

```
idle ──start 成功──► playing ──end──► idle
              │
              └── 人数不够 / 缺大屏 / 游戏损坏 ──► 仍 idle，回 error
```

无房间、无排队多局。

**start 校验**

1. 当前 `idle`  
2. 游戏存在且 manifest 合法  
3. 在线玩家数 ∈ [minPlayers, maxPlayers]  
4. 若 `playMode` 为 `shared-screen` 或 `hybrid`：必须已有 display；否则 `error`：`need_display`（外壳提示「请打开电视」）。第一版不做长时间等待队列，点开始时没有大屏就失败，用户开好电视再点一次。  

**playing 时新玩家连上**

- 在线人数 < maxPlayers：加入本局，对其推 `party.start`（他的 view 按模式是 player 或 controller）  
- 已满：可以连着待在大厅外壳，`view=wait`，不进游戏  

**end**

- 任一玩家请求（第一版）  
- 游戏 server 调用 `ctx.end()`  
- 可选：personal 模式权威玩家断开则结束（第一版建议结束并回大厅，避免残局）  
- shared-screen 且最后一块 display 断开：不自动 end，也不由框架暂停。给仍在线的玩家发 `display.gone`，并在 `party.state` 里把 `displayConnected` 设为 false。还有别的大屏时不发。游戏通过 SDK 的 `displayConnected` / `displayGone` 自己决定暂停、提示或继续。从没有大屏到有一块时发 `display.ready` 和一份新的 `party.state`。主机记住最近一份坐标，后连上的大屏马上补发。  

**在线人数**只计 `role=player`，不计 display。

---

## 10. 游戏包（框架如何加载）

目录：`games/{id}/`

```
games/quiz-party/
  manifest.json
  player/index.html      # personal 需要
  display/index.html     # shared-screen / hybrid 需要
  controller/index.html  # shared-screen / hybrid 需要
  server.js              # 可选
  assets/
```

### 10.1 manifest.json

```json
{
  "id": "quiz-party",
  "name": "家庭抢答",
  "version": "1.0.0",
  "description": "",
  "cover": "cover.png",
  "minPlayers": 2,
  "maxPlayers": 8,
  "playMode": "personal",
  "supportsTV": false,
  "usesSave": true,
  "tickHz": 20,
  "entry": {
    "player": "player/index.html",
    "display": "display/index.html",
    "controller": "controller/index.html",
    "server": "server.js"
  }
}
```

`playMode`：`personal` | `shared-screen` | `hybrid`。  
`hybrid` 第一、二步协议预留，外壳可按 shared-screen 同样加载 display+controller；手机页由游戏自己画私密 UI。

校验失败的包：`GET /api/games` 里出现，`broken` + `error` 字符串，不能 start。

静态文件只读托管，禁止 `server.js` 被浏览器直接当有意义的玩法入口（可以 404 或不当 HTML 用）。

### 10.2 扫描

启动时扫一遍；`POST /api/games/refresh` 再扫。不监视文件系统也行，管理页提供刷新按钮。

---

## 11. 从游戏源安装

catalog.json（远程）：

```json
{
  "name": "示例源",
  "homepage": "",
  "games": [
    {
      "id": "quiz-party",
      "name": "家庭抢答",
      "version": "1.2.0",
      "description": "",
      "cover": "https://...",
      "download": "https://.../quiz-party-1.2.0.zip",
      "sha256": "小写 hex",
      "size": 1048576,
      "minPlayers": 2,
      "maxPlayers": 8,
      "playMode": "personal",
      "supportsTV": false,
      "sdkRange": ">=1.0.0 <2.0.0"
    }
  ]
}
```

安装步骤（主机进程内）：

1. 下载到 `data/tmp/{id}.zip`  
2. 算 sha256，与 catalog 不一致则删临时文件并失败（无 sha256 直接失败）  
3. 解压到 `data/tmp/{id}-unpack/`，拒绝 `..`、绝对路径、符号链接  
4. 找到 `manifest.json`（允许 zip 内多一层同名目录）  
5. `manifest.id` 必须等于要装的 id  
6. 替换 `games/{id}/`（先写临时再 rename）  
7. 刷新游戏列表  

体积上限默认 80MiB。卸载：删目录，默认留存档。

游戏源下载仅主机访问外网；玩家设备只访问主机。

---

## 12. 主机运算

对局 start 且 manifest 有 `entry.server` 时，权威是 `host`。主机另开一个工作线程，加载该脚本的 `export default` 钩子（见游戏模块文档第 7 节）。脚本自己不是线程入口，避免游戏还要自己接 `postMessage`。

传入：当时在局的玩家列表、`tickHz`、大屏是否连着。  
脚本能做的：收 `onInput` / `onMessage`、`pushDisplay`、`pushController`、`broadcastPlayers`、存档、`end`、`log`、可选 `onDisplay` / `onTick` / 进出玩家。  
不传入网络、子进程或磁盘 API。家庭里自己装的脚本仍跑在本机进程里，这道边界靠不给多余能力，不是操作系统沙箱。

脚本抛错或线程退出：给所有连接发 `error: game_server_crash`，然后 `party.end`。主机进程继续。`ctx.end()` 或玩家结束这一局后，线程先收到停止，再被关掉。

找不到脚本文件：这包标损坏，不能开局。

---

## 13. 外壳页面职责

### 管理 `/admin`

- 超大号大屏 URL（给人在电视上打字），短路径 `/s`  
- 手机加入二维码（电视不要扫这个）  
- 「本机当大屏」  
- 选择网卡 IP  
- 在线成员：**踢下线**（对方回选人，名字放开；不删档案）  
- 游戏源、安装进度、刷新游戏、清存档。卸载已装游戏前先在页上确认一次  
- **游戏日志**：开局/结束、游戏 `log`、页面未捕获错误；可清空、复制、按级别筛选。给做游戏的人用  
- 不参与 WS 聚会（除非点了本机当大屏，那是另开 `/screen`）

### 大屏 `/screen`

- 连 WS `role=display`  
- idle：游戏列表只读、在线玩家、手机二维码（可再显示一次加入码，方便电视正对沙发）  
- playing：跳到游戏 display 入口  

### 手机 `/`

- 未 token：选人 / 新建  
- 有 token：连 WS `role=player`，大厅顶部标明「你是谁」（名字 + 颜色）  
- idle：大厅。人数落在该游戏 `minPlayers`～`maxPlayers`（两人相等就是固定人数）且该模式需要的大屏已连上时，才能点开始；否则按钮不可用并说明原因  
- playing：按 `view` 打开 player 或 controller 入口  
- 游戏页连上后，SDK 在 **玩家页** 和 **手柄页** 叠一层外壳菜单（Shadow DOM，不吃游戏样式）：角上「菜单」，可确认后 `party.end`。电视 display 页不加，避免挡画面。游戏仍可自己调 `end()`。  

UI 中文。名字 + 颜色块。无房间号输入。

---

## 14. 安全（家庭网，做最低限度）

- 只绑定局域网使用，不搞 HTTPS（第一版）  
- 限制消息大小和 input 频率  
- zip 路径穿越防护 + 强制 sha256  
- 存档按 gameId 隔离  
- 管理接口在家庭网内不做登录限制  
- 不信任客户端自称的 playerId，只信 token  

不防专业作弊。需要防改分的游戏把规则写在 `server.js` 里。

---

## 15. 实现顺序（只含框架）

与需求「分步做」对齐，游戏示例可并行，但本列表是框架本身。

### 第一步（能开会）

- [ ] 启动、LAN IP、端口、`/admin` 两张码  
- [ ] `/screen` `/` 静态外壳  
- [ ] SQLite 档案 + claim token  
- [ ] WS hello、多块大屏收同一份坐标、选人先到先得（占用后别人不能选）  
- [ ] `party.state` 广播  
- [ ] 扫描内置示例游戏目录（可先写死两个假游戏）  
- [ ] start/end、view 跳转  
- [ ] `input` / `state` 按权威端转发（无主机脚本时权威=点开始的玩家；大屏只收画面）  
- [ ] 极简存档 GET/PUT  

### 第二步

- [ ] 完整 manifest 校验与 broken 展示  
- [ ] 游戏源 catalog / zip / sha256 / 卸载  
- [ ] 管理页安装进度  
- [ ] start 时检查 display（shared-screen）  
- [ ] 中途加入  
- [ ] 管理页游戏日志（SDK `log` + 未捕获错误 + 开局/结束）  

### 第三步

- [x] Worker 加载 server.js  
- [ ] display 短重连（断开通知已经有；暂停由游戏决定）  

---

## 16. 本地开发

```
bun install
bun run dev          # 并行：host watch + web vite
```

开发时 Vite 管外壳，host 把 `/` `/screen` `/admin` 反代到 Vite；`/api` `/ws` `/games` 走 host。

家人发行：

```
bun run build        # web 打进 host 的 public/
bun build --compile apps/host/src/index.ts --outfile dist/sofa-party
```

把 `dist/sofa-party`、空的 `games/`、说明一起打包。

---

## 17. 框架侧验收（对应需求）

1. 电脑启动后，管理页能看到加入码和大屏码。  
2. 电视只开 `/screen`，不选名字；手机只开 `/`，必须选名字。  
3. 两部手机两个档案，大厅互相看得见。  
4. 第二块电视打开 `/screen`，两块都留着，看到同一份画面。关掉一块，另一块还在；最后一块关掉才通知游戏。  
5. 同一档案已经被选走后，另一部手机不能再选；选人页马上显示「已加入」。同一部手机刷新可以接着用。  
6. 透传消息按 playerId 送到，框架不改 payload。  
7. 存档写入后重启进程仍在。  
8. 坏 zip / 错 sha256 不会出现在可开始列表里。  
9. 游戏里 `game.log.error(...)` 或页面抛错后，本机 `/admin` 的游戏日志里能看到，且不会出现在其他玩家屏幕上。  
10. 手机游戏页和手柄页能打开菜单结束这一局，全体回大厅；电视游戏画面没有这层菜单。  
11. 本机管理页能把在线玩家踢回选人，该名字立刻可再选。  

游戏能不能好玩，不算框架验收。

---

## 18. 和后续文档的边界

| 文档 | 内容 |
|------|------|
| 本文 | 主机进程、API、WS、目录、状态机 |
| `docs/game-module.md` | manifest、浏览器 SDK、server SDK、打包与上架 |

框架开发者实现本文即可把聚会跑起来；不要在 host 里写死某款游戏的规则。

# 游戏模块开发文档

> 给外部小游戏开发者的完整说明见 [`docs/game-dev.md`](game-dev.md)。本文与框架实现对照，不单独发给开发者。  
> 对应需求：`docs/requirements.md` v0.20  
> 对应框架：`docs/framework.md`  
> 版本：v0.3

---

## 1. 你在做什么

游戏是一个 **文件夹**（或打成 zip 供游戏源下载）。里面是网页，外加一份说明文件。

主机负责：家里有谁、开哪一款、把消息送到人、代为存档。  
**规则、画面、按钮长什么样，全部由你的网页（以及可选的主机脚本）负责。**

玩家不会单独「安装你的 App」。他们打开家里电脑上的 **沙发派对**，在大厅点你的游戏。

---

## 2. 先选一种玩法

写进 `manifest.json` 的 `playMode`，玩家不用配置。

### `personal` — 每人看自己的手机

适合：答题、卧底、各看各的牌。

你要提供：`player/index.html`（每个人打开同一套页面，用「我是谁」显示不同内容）。

电视可以开着当大厅，**不必**提供大屏游戏画面。

规则默认在 **点开始的那个人的手机网页** 里算，再通知别人。需要防改分时，再加 `server.js`，由主机在工作线程里算。

### `shared-screen` — 电视出画，手机当手柄

适合：派对小游戏、一起盯着电视看的操作游戏。

你要提供：

- `display/index.html`：只给电视  
- `controller/index.html`：只给手机，不要画完整战场  

没带 `server.js` 时，规则在 **点开始的那位玩家** 的页面里算。大屏只收画面快照来画。手机用 `input` 发按键。带了 `server.js` 之后，规则改在主机里算，网页不再是权威。

### `hybrid` — 电视公共画面 + 手机上有私密信息

协议预留。页面仍是 display + controller，controller 里可以显示只有自己能看的牌。官方模板后做，有需要可先按 `shared-screen` 自己画。

---

## 3. 目录约定

```
quiz-party/
  manifest.json              # 必填，id 必须和文件夹名一致（安装后以文件夹名为准，校验 id）
  cover.png                  # 可选，大厅封面
  player/index.html          # personal 必填
  display/index.html         # shared-screen / hybrid 必填
  controller/index.html      # shared-screen / hybrid 必填
  server.js                  # 可选；有了它，这一局的规则在主机里算
  assets/
    app.js
    app.css
```

不要 `server/` 里再起一个 HTTP 服务。不要在主机上自己建数据库文件。

最终交给主机的必须是 **已经构建好的静态文件**。开发时用 Vite 可以，发布时把 `dist` 变成上面这个结构。

---

## 4. manifest.json

```json
{
  "id": "quiz-party",
  "name": "家庭抢答",
  "version": "1.0.0",
  "description": "看题抢答，适合 2～8 人",
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

| 字段 | 必填 | 说明 |
|------|------|------|
| `id` | 是 | 英文数字和连字符，稳定不变。存档按它隔离。改 id = 新游戏 |
| `name` | 是 | 大厅显示的中文名 |
| `version` | 是 | semver，如 `1.2.0` |
| `description` | 建议 | 一两句 |
| `cover` | 建议 | 相对本目录的图片 |
| `minPlayers` / `maxPlayers` | 是 | 只算选了名字的人，不算大屏。两者相等就是固定人数（如 2 人、4 人）；不等就是一段范围（如 1～4 人）。当前在线人数不在这里面时，大厅不能开始 |
| `playMode` | 是 | `personal` \| `shared-screen` \| `hybrid` |
| `supportsTV` | 建议 | 大屏是否适合客厅电视。`shared-screen` 应为 `true` |
| `usesSave` | 否 | 大厅可提示「有进度」 |
| `tickHz` | 否 | 仅 `server.js` 用，默认 20 |
| `entry.*` | 按模式 | 缺了对应入口则包损坏，大厅不能开始 |

`id` 全主机唯一。两个源都有同 id 时，安装时由用户选覆盖哪一个。

---

## 5. 页面怎么被打开

你不用自己处理「现在是大厅还是游戏」。外壳已经连上 WebSocket，开始后会跳到你的 html。

跳转前会往 `sessionStorage` 写入（键名以框架实现为准，SDK 会读）：

- 玩家 token（仅 player / controller 页）  
- 当前 `gameId`  
- 本页角色：`player` | `display` | `controller`

你的页面与主机 **同域**（例如 `http://192.168.1.8:8080/games/quiz-party/player/index.html`），SDK 连 `ws://同一主机/ws`。

**资源路径**：所有 CSS/JS/图必须用相对路径，或构建时 `base` 设为 `./`。不要写死 `/assets/xxx`，否则会打到主机外壳上。

Vite 示例：

```ts
// vite.config.ts
export default {
  base: "./",
  build: {
    outDir: "dist",
    rollupOptions: {
      input: {
        player: "player/index.html",
        display: "display/index.html",
        controller: "controller/index.html",
      },
    },
  },
};
```

只做 personal 时，input 只保留 `player`。

---

## 6. 浏览器 SDK

主机提供脚本，例如：

```html
<script type="module">
  import { connectGame } from "/sdk/game.js";
  const game = await connectGame();
  // 手机游戏页 / 手柄页会自动出现「菜单」；电视画面不会。
  // connectGame({ shellMenu: false }) 可关掉外壳菜单。
</script>
```

不要自己手写握手，除非你在调试协议。SDK 会用 `sessionStorage` 里的 token 完成 `hello`。

### 6.1 连上之后你能拿到什么

```ts
type Player = { id: string; name: string; color: string };

type GameSession = {
  role: "player" | "display" | "controller";
  me?: Player;                 // display 没有 me
  players: Player[];           // 当前在线、已进这局的人
  starterId: string | null;
  gameId: string;
  playMode: "personal" | "shared-screen" | "hybrid";
  isAuthority: boolean;        // 本页是不是规则权威（无 server 时）
  displayConnected: boolean;   // 此刻有没有大屏连着

  send(to: SendTo, payload: unknown): void;
  broadcast(payload: unknown): void;          // 除自己外所有连接
  sendInput(payload: unknown): void;          // 仅 player；转给权威端
  sendState(payload: unknown): void;          // 仅「负责计算的玩家」调用，主机转给大屏

  save: {
    get(key: string): Promise<unknown>;
    set(key: string, value: unknown): Promise<void>;
    getShared(key: string): Promise<unknown>;
    setShared(key: string, value: unknown): Promise<void>;
  };

  end(): void;                 // 请求整桌回大厅

  log: {
    debug(message: string, data?: unknown): void;
    info(message: string, data?: unknown): void;
    warn(message: string, data?: unknown): void;
    error(message: string, data?: unknown): void;
  };

  on(event: "players", fn: (players: Player[]) => void): void;
  on(event: "message", fn: (msg: { from?: string; payload: unknown }) => void): void;
  on(event: "input", fn: (msg: { playerId: string; payload: unknown }) => void): void;
  on(event: "state", fn: (payload: unknown) => void): void;
  on(event: "end", fn: () => void): void;
  on(event: "displayGone" | "displayReady", fn: () => void): void;
};
```

连上后立刻看 `game.displayConnected`。之后电视拔掉或再打开：

```ts
if (game.displayConnected) { /* 有电视 */ }

game.on("displayGone", () => { /* 大屏断了，可暂停或提示去开电视 */ });
game.on("displayReady", () => { /* 大屏又来了 */ });
```

`personal` 游戏不强制要电视，但也可以用这个决定要不要在大屏上放公共信息（若你提供了 display 页）。`shared-screen` 开局时主机已经要求有大屏；中途断开不会自动结束这局，也**不会由框架暂停**。要不要停，在 `displayGone` 里自己处理。

`SendTo`：`"all"` | `"display"` | `"players"` | `{ playerId: string }`。

### 6.2 三种消息，别混用

| 方法 | 用途 | 大小 | 谁收 |
|------|------|------|------|
| `send` / `broadcast` | 玩法事件：出牌、答题、聊天式指令 | ≤ 64KB | 你指定的人 |
| `sendInput` | 手柄：按键、摇杆，高频 | ≤ 2KB，约 30Hz | **只有权威端** |
| `sendState` | 整屏快照：分数、角色坐标 | ≤ 64KB | 大屏（及你若还 `send` 给手柄） |

**personal 答题**：用 `send` / `broadcast` 即可，一般不用 `input`。  
**大屏+手柄**：手柄只 `sendInput`。点开始的那位玩家在自己的手柄页里改状态，用 `sendState` 把画面发给大屏，用 `send("players", ...)` 把分数发给其他手柄。大屏页只画收到的快照。

### 6.3 谁是权威（没有 server.js 时）

| playMode | 权威 | `isAuthority === true` 的页面 |
|----------|------|------------------------------|
| personal | 点开始的那位玩家 | 他的 `player` 页 |
| shared-screen / hybrid | 点开始的那位玩家 | 他的 `controller` 页 |

大屏页永远 `isAuthority === false`。打开大屏地址的可以是电视、手机、平板或电脑，角色一样：只显示。

不是权威的页面：只显示、只发操作，不要本地偷偷改「官方分数」再广播当真相。家庭网防不住高手，但这是正确写法。

有 `server.js`：所有网页 `isAuthority === false`，只收 `state` / `message`，只发 `input` / `send`。规则在主机进程里算。

### 6.4 存档

只在 **当前这局已经开始、且 gameId 就是你** 时能读写。大厅页读不到。

```ts
await game.save.set("highScore", 12);
await game.save.get("highScore");
await game.save.setShared("trophy", { count: 3 });
```

值必须能 `JSON.stringify`。不要把大图塞进去。私有档跟 `me.id` 走，换手机还能读。

不要把正式进度只放在 `localStorage`。

### 6.5 结束

框架会在 **手机游戏页** 和 **手柄页** 自动放一个「菜单」，里面可以退出 / 关闭这一局。电视画面不加这层，避免挡操作。你不必自己画退出按钮。

谁都可以调 `game.end()`（第一版）。调了之后全体回大厅，你的页会被卸掉。在 `on("end")` 里做清理即可，不必自己跳转。

若你要完全自己做退出 UI：`connectGame({ shellMenu: false })`。

### 6.6 日志（管理页可见）

电视和别人的手机上看不到这些字。写到主机，本机 `/admin` 的「游戏日志」里出现。

```ts
game.log.info("发题", { index: 3 });
game.log.warn("有人抢答太晚");
game.log.error("判题失败", { playerId: game.me.id });
```

`data` 可省略，必须能 `JSON.stringify`。不要打大对象、不要打题目答案给每台设备的 `console` 就算完——**管理页才是给开发者看的地方**。

SDK 会自动把本页 **未捕获的 JS 错误**（`error` / `unhandledrejection`）打成 `error` 送上去。你自己 `try/catch` 住的，要查的话请再调 `game.log.error`。

限制：每条大约 2KB，同一页大约每秒 20 条。打太多会被丢掉。

`server.js` 里的 `ctx.log(...)` 走同一份缓冲。

---

## 7. 主机脚本 `server.js`

`manifest.entry.server` 指向这份脚本。浏览器打不开它。主机在工作线程里 `import` 它，调用默认导出的钩子。带了它的游戏，网页全部 `isAuthority === false`。

```js
export default {
  async onStart(ctx) {},
  onInput(playerId, payload, ctx) {},
  onMessage(fromPlayerId, payload, ctx) {},
  onTick(dtMs, ctx) {},
  onPlayerJoin(player, ctx) {},
  onPlayerLeave(playerId, ctx) {},
  onDisplay(connected, ctx) {},
  onStop() {},
};
```

`onTick` 的频率是 manifest 的 `tickHz`（默认 20，最高 60）。`onDisplay` 在大屏连上或断开时调用，用来暂停或把当前画面再推一次。

`ctx`：

- `ctx.players`：`{ id, name, color }[]`  
- `ctx.displayConnected`  
- `ctx.pushDisplay(state)`：画面快照，只送给大屏，大屏在 `on("state")` 里画  
- `ctx.pushController(playerId, payload)`：送给某一个手柄，对方在 `on("message")` 里收  
- `ctx.broadcastPlayers(payload)`：送给所有在局玩家  
- `await ctx.save.get(playerId, key)` / `set(playerId, key, value)`  
- `await ctx.save.getShared(key)` / `setShared(key, value)`  
- `ctx.end()`：结束这一局，大家回大厅  
- `ctx.log.info / warn / error / debug`：管理页游戏日志，与网页 SDK 同一缓冲  

玩家发来的 `sendInput` 进 `onInput`。玩家发来的 `send` / `broadcast` 进 `onMessage`，不再在手机之间互转。

不能做的：开端口、读其它游戏存档、写任意磁盘、自己发 HTTP、起子进程。钩子抛错只结束这一局，主机还在。

示例「接住它」的下落和计分就在 `games/catch-drop/server.js`。

---

## 8. 手柄页怎么写（shared-screen）

- 竖屏、大按钮、少字。  
- 用 `me.color` 当按钮颜色，电视上对应角色同色。  
- 摇杆：按触点算 -1～1，用 `sendInput({ type: "stick", x, y })`，自己节流到 20～30Hz。  
- 按下/抬起分开：`{ type: "button", id: "a", down: true }`。  
- 可以显示本局分数条，**不要**把整张地图画在手机上。  

官方以后提供 `controller-kit`（方向键、A/B）。第一版游戏可以先自己画两个大按钮。

点开始的那位玩家要能容忍大屏断开：在 `displayGone` 里暂停或提示。大屏再连上后用 `sendState` 把当前画面再发一次。框架会在该玩家重连后继续把 `input` 送来（第三步才保证短重连；第一版断了就是人走了）。

---

## 9. 大屏页怎么写

- 按 16:9 想，字要大，坐在沙发上看得清。  
- 不要依赖鼠标悬停。  
- 空闲时的大厅 **不是你写的**；你的 display 只在开玩后出现。  
- 这一页不算规则。在 `on("state")` 里把收到的快照画出来。  
- 打开这个地址的设备不必是电视。手机、平板、电脑都可以当这块画面。可以同时开多块，每块收到同一份坐标。游戏只看 `displayConnected`：还有一块连着就是有大屏。

---

## 10. 每人一屏怎么写

同一份 `player/index.html` 每人打开一份。

用 `game.me.id` 区分「这是我的题面 / 我是卧底」。

推荐：权威端（发起者）持有题目和分数，`broadcast` 阶段变化；其他人只 `send({ playerId: starterId }, { type: "answer", ... })` 或 `broadcast` 答题事件。

发起者若关掉手机，第一版整局会结束。可在页上提示「开局的人不要把页面划掉」。

---

## 11. 本地怎么调

1. 家里电脑上的主机已按框架文档跑起来。  
2. 把构建结果拷到主机工作目录 `games/{id}/`，管理页点刷新（或重启主机）。  
3. 手机扫加入码；电视在浏览器里输入管理页上的大屏地址（或电脑 HDMI 后点本机当大屏）。  
4. 改代码后重新构建再拷一次。

开发期可把 Vite `base` 配好，用脚本 `bun run sync-game quiz-party` 把 dist 同步到 `games/`（框架仓库以后会加模板命令）。

调试：开着电脑上的 **管理页 → 游戏日志**。浏览器开发者工具仍可看 WS 帧；不要在游戏里打到外网。

---

## 12. 打包装到游戏源

1. 确认 `games/quiz-party/manifest.json` 能被主机扫描且能开始一局。  
2. 打 zip：压缩包解开后能直接看到 `manifest.json`，或只有一层 `quiz-party/manifest.json`。  
3. 计算 sha256（小写 hex）。  
4. 把 zip 放到任意静态托管（GitHub Releases、自己的网盘直链）。  
5. 写 `catalog.json`：

```json
{
  "name": "沙发派对游戏源",
  "homepage": "https://example.com",
  "games": [
    {
      "id": "quiz-party",
      "name": "家庭抢答",
      "version": "1.0.0",
      "description": "看题抢答",
      "cover": "https://example.com/quiz-cover.png",
      "download": "https://example.com/quiz-party-1.0.0.zip",
      "sha256": "aabbcc...",
      "size": 123456,
      "minPlayers": 2,
      "maxPlayers": 8,
      "playMode": "personal",
      "supportsTV": false,
      "sdkRange": ">=1.0.0 <2.0.0"
    }
  ]
}
```

6. 把 catalog 的 URL 发给主机用户，在管理页添加游戏源。

没有 sha256 的包，主机会拒绝安装。zip 里禁止 `../`。不要超过约 80MB。

框架不审核你的游戏。别人添你的源，等于信任你。

---

## 13. 官方推荐技术（不是强制）

| 情况 | 建议 |
|------|------|
| 语言 | TypeScript |
| 构建 | Vite，`base: "./"` |
| personal / 手柄 DOM | Svelte 或原生 HTML |
| 电视 2D | Phaser 3，只放在 display 页 |
| 手柄 | 大按钮；以后用 controller-kit |

可以用 Vue/React，只要打出来是静态文件。包越大，电视和手机越慢。

---

## 14. 不要做的事

- 要求玩家再装 App、再装 Node  
- 自己监听端口、自己起数据库  
- 把进度只存在某台手机的 localStorage 当正式存档  
- 在手柄页画完整游戏世界（shared-screen）  
- 依赖外网才能玩（资源请打进包里）  
- 用 User-Agent 判断自己是不是电视（你打开的就是对应入口 html）  
- 信任别的客户端发来的「我赢了」而不经权威端  

---

## 15. 两个最小例子（逻辑说明）

### 例子 A：`personal` 抢答

1. 发起者 `isAuthority`：抽题，`broadcast({ type: "question", text, deadline })`。  
2. 每人显示题目和按钮，抢到发 `broadcast({ type: "buzz", playerId: me.id })`。  
3. 权威端只认第一份 buzz，`broadcast({ type: "lock", winnerId })`，再判对错、改分。  
4. `save.setShared("lastWinner", name)`。  
5. 若干题后 `end()`。

### 例子 B：`shared-screen` 谁先按

1. 没带 `server.js` 时，点开始的那位在手柄页算规则。带了 `server.js` 时，在主机脚本里算。大屏只画收到的坐标。  
2. 变绿后接受 input：`{ type: "button", id: "a", down: true }`。  
3. 第一个有效按键的人加分，用 `sendState` 或 `pushDisplay` 把名字和颜色发给大屏。  
4. 手柄页只有一个大按钮。

这两例作为主机第一步的内置示例游戏，模块开发者也按同样结构写。

---

## 16. 和框架文档怎么分工

| 你要改游戏 | 看本文 |
| 你要改主机、协议、扫描 zip | 看 `docs/framework.md` |
| 你要知道客厅里人怎么玩 | 看 `docs/requirements.md` |

SDK 的最终函数名以仓库里 `packages/sdk` 为准；若实现时改名，会同步改本文。

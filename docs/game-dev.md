# 小游戏接入文档

> 产品：沙发派对  
> SDK：`/sdk/game.js`，版本 1.0.0  
> 读者：要做一款能装进这台主机的小游戏的人  
> 这份文档写完了你需要知道的框架行为和接入方法。按它做，游戏就能在沙发派对里开局。

沙发派对跑在家里一台电脑上。电视、手机、平板、另一台电脑用浏览器打开它，一起玩。玩家不安装你的 App，也不注册账号。他们在大厅点你的游戏，主机会打开你交来的网页。

你交的是一套**已经构建好的静态文件**，加上一份 `manifest.json`。可选再加一份在主机里运行的 `server.js`。规则、画面、按钮由你写。主机不解释你的玩法。

---

## 1. 主机替你做的事

这些不用你做：

- 在家里的 Wi-Fi 上开一个网址。手机扫码加入，大屏地址用文字打开。
- 记住家里的人：名字、颜色、谁正在占用这个名字。先点到的人占住，别人不能再选。全主机最多 16 个名字。
- 一个大厅、同时只开一局。没有房间号，没有多桌。
- 按你声明的人数决定能不能开始。人数对不上时，大厅里的「开始」是灰的。
- 开局后按玩法打开你的页面：每人一屏、大屏、或手机手柄。
- 在手机游戏页和手柄页放一个「菜单」，里面可以退出这一局。大屏上不加，避免挡画面。
- 把操作和坐标在设备之间转发。它不改你的分数。
- 按游戏 id 隔离存档。
- 把你打的日志收集到电脑上的管理页。电视和手机上看不到这些字。
- 若你提供了 `server.js`，在主机的工作线程里跑它。脚本抛错只结束这一局，主机还在。

主机不做：外网对战、账号、应用商店、替你暂停、替你画游戏画面。

---

## 2. 三种身份

连上主机的每一页只是一种身份。电视、手机、平板、电脑都可以扮演其中一种，看它打开的是哪个地址。

| 身份 | 谁打开 | 你的页面 | 做什么 |
|------|--------|----------|--------|
| 玩家 | 选了名字的人 | `player/index.html` | 每人一屏时，这就是他的游戏画面 |
| 大屏 | 打开大屏地址的设备 | `display/index.html` | 只显示。可以同时有多块，看到的是同一份坐标 |
| 手柄 | 选了名字的人，在大屏类游戏里 | `controller/index.html` | 按钮和摇杆，不画整场比赛 |

大屏不选名字，不算玩家，不算进 `minPlayers` / `maxPlayers`。

可以同时开多块大屏。你推一次坐标，主机转给每一块。后连上的屏会马上收到最近一份，不用你按屏幕再推一遍。游戏里只看「有没有大屏」：还有至少一块连着就是有；最后一块离开才算没了。

---

## 3. 先选玩法

写在 `manifest.json` 的 `playMode` 里。玩家不用配置。

### `personal` — 每人看自己的屏幕

适合答题、卧底、各看各的牌。

提供 `player/index.html`。每个人打开同一套页面，用「我是谁」显示不同内容。大屏可以不参与。

### `shared-screen` — 一块或多块大屏出画面，手机当手柄

适合大家盯着同一块画面的派对游戏。

提供 `display/index.html` 和 `controller/index.html`。开局时必须已经有至少一块大屏，否则大厅不能开始。

### `hybrid` — 大屏看公共画面，手机上还有只有自己能看的信息

页面仍然是 display + controller。手机上的私密内容由你自己画。主机不会另外发一条「私密通道」。

---

## 4. 规则在哪儿算

两条路，写不写 `server.js` 就定了。

**不写 `server.js`。** 点「开始」的那个人的页面是权威。

| 玩法 | `isAuthority === true` 的页面 |
|------|------------------------------|
| personal | 他的玩家页 |
| shared-screen / hybrid | 他的手柄页 |

大屏永远不是权威。权威页改分数和坐标，用 `sendState` 把画面数据发给所有大屏，用 `send` / `broadcast` 通知别人。其他页面只显示、只发操作，不要把自己算的分数再广播成官方结果。

这个人关掉页面后，大约 10 秒内没有用同一个名字回来，这一局会结束。可以在页上提示「开局的人不要把页面划掉」。

**写了 `server.js`。** 所有网页的 `isAuthority` 都是 `false`。规则在主机工作线程里算。网页只发操作、只画收到的数据。点开始的人关掉页面，这一局还在。

---

## 5. 人数

`minPlayers` 和 `maxPlayers` 只算选了名字的人。

- 两个数相等：固定人数。大厅显示「2 人」「4 人」。
- 两个数不等：一段范围。大厅显示「1～4 人」。
- 现在在线的人数不在这里面，不能开始。
- 合法范围是最少 1、最多 16，且最少不超过最多。

对局进行中，后来的人如果还没到 `maxPlayers`，会直接进这一局。满了就停在外面等这局结束。

---

## 6. 你要交的目录

```
my-game/
  manifest.json
  cover.png                 # 可选，大厅封面
  player/index.html         # personal 必填
  display/index.html        # shared-screen / hybrid 必填
  controller/index.html     # shared-screen / hybrid 必填
  server.js                 # 可选
  assets/
```

`manifest.json` 的 `id` 必须和文件夹名一致。只写小写字母、数字和连字符，例如 `quiz-party`。改 id 等于一款新游戏，旧存档不会跟着走。

不要在包里再开一个 HTTP 服务，不要自己建数据库。图片、脚本都用相对路径。构建时把 Vite 的 `base` 设为 `./`。写成 `/assets/xxx` 会打到主机外壳上，而不是你的游戏里。

浏览器打不开 `server.js`。它只给主机的工作线程加载。

### manifest.json

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
| `id` | 是 | 与文件夹名相同 |
| `name` | 是 | 大厅上的名字 |
| `version` | 是 | `1.2.0` 这种三段数字 |
| `description` | 建议 | 一两句 |
| `cover` | 建议 | 相对本目录的图片 |
| `minPlayers` / `maxPlayers` | 是 | 见上一节 |
| `playMode` | 是 | `personal`、`shared-screen`、`hybrid` |
| `supportsTV` | 建议 | 大屏适不适合客厅电视。大屏类游戏写 `true` |
| `usesSave` | 否 | 有进度时写 `true` |
| `tickHz` | 否 | 只给 `server.js` 用。默认 20，最高 60 |
| `entry` | 是 | 缺了当前玩法要的页面，大厅会把这包标成损坏，不能开始 |

只做每人一屏时，`entry` 里只写 `player`。只做大屏加手柄时，只写 `display` 和 `controller`。

---

## 7. 页面是怎么被打开的

你不用自己判断「现在是大厅还是游戏」。玩家在大厅点开始之后，主机会打开你的 html。

页面和主机同域，例如 `http://192.168.1.8:8080/games/quiz-party/player/index.html`。SDK 会自己连上这台主机。

手机游戏页和手柄页会自动出现角上的「菜单」，确认后结束这一局。大屏页没有这层。不想用它时：

```js
const game = await connectGame({ shellMenu: false });
```

全屏不是 SDK 的功能。需要时在按钮的点击里自己调用 `document.documentElement.requestFullscreen()`。很多手机浏览器对全屏限制很严。

再开一回合不用重新调用 SDK。你广播一份新的开局数据即可。`game.end()` 结束的是整局，大家回到大厅，没有「跳过大厅直接重开」的接口。

---

## 8. 网页 SDK

在页面里：

```html
<script type="module">
  import { connectGame } from "/sdk/game.js";

  const game = await connectGame();
</script>
```

不要自己握手。`connectGame()` 失败会抛错，例如连不上主机。

### 8.1 连上之后

```ts
type Player = { id: string; name: string; color: string };

type GameSession = {
  role: "player" | "display" | "controller";
  me?: Player;                  // 大屏没有 me
  players: Player[];            // 当前连着、选了名字的人
  starterId: string | null;    // 点开始的那个人
  gameId: string;
  playMode: "personal" | "shared-screen" | "hybrid";
  isAuthority: boolean;
  displayConnected: boolean;    // 此刻是否至少有一块大屏

  send(to: SendTo, payload: unknown): void;
  broadcast(payload: unknown): void;
  sendInput(payload: unknown): void;
  sendState(payload: unknown): void;

  save: {
    get(key: string): Promise<unknown>;
    set(key: string, value: unknown): Promise<void>;
    getShared(key: string): Promise<unknown>;
    setShared(key: string, value: unknown): Promise<void>;
  };

  end(): void;

  log: {
    debug(message: string, data?: unknown): void;
    info(message: string, data?: unknown): void;
    warn(message: string, data?: unknown): void;
    error(message: string, data?: unknown): void;
  };

  on(event: "players", fn: (players: Player[]) => void): () => void;
  on(event: "message", fn: (msg: { from?: string; payload: unknown }) => void): () => void;
  on(event: "input", fn: (msg: { playerId: string; payload: unknown }) => void): () => void;
  on(event: "state", fn: (payload: unknown) => void): () => void;
  on(event: "end", fn: () => void): () => void;
  on(event: "displayGone" | "displayReady", fn: () => void): () => void;
};
```

`SendTo` 是 `"all"`、`"display"`、`"players"` 或 `{ playerId: string }`。

`on` 的返回值可以拿来取消监听。颜色由主机分配，按钮和大屏上的角色用 `me.color` / `player.color`，不要自己另造一套。

`players` 会在人员变化时更新，同时触发 `players` 事件。

### 8.2 三种发送，不要混

推出去的是 **JSON 数据**（分数、坐标、题目），不是画好的图片。大屏收到后自己画。一份太大会被丢掉。

| 方法 | 用来做什么 | 上限 | 谁收到 |
|------|------------|------|--------|
| `send` / `broadcast` | 出牌、答题、阶段变化 | 64KB | 你指定的人。有 `server.js` 时改为进入主机脚本，不再在手机之间互转 |
| `sendInput` | 按键、摇杆。请自己节流到大约每秒 20～30 次 | 2KB，每秒最多约 30 次 | 只有权威。有 `server.js` 时是主机脚本 |
| `sendState` | 整屏要画的数据：坐标、分数、提示文字 | 64KB | 所有大屏，以及除自己以外的在局玩家。没有 `server.js` 时，只有权威页可以发 |

`broadcast` 是发给除自己以外的连接。`send("players", payload)` 发给其他玩家。`send("display", payload)` 发给大屏，但画面数据请用 `sendState`，大屏在 `on("state")` 里画。

没有 `server.js` 的大屏加手柄，典型写法：

```js
// 手柄页：只发操作
game.sendInput({ type: "stick", x, y: 0 });
game.sendInput({ type: "button", id: "a", down: true });

// 权威的那一页：改完世界再推
game.sendState({
  bodies: { [playerId]: { x: 120, score: 3 } },
  banner: "接住星星",
});
game.send("players", { type: "hud", scores });
```

```js
// 大屏页：只画
game.on("state", (snapshot) => {
  draw(snapshot);
});
```

`await connectGame()` 返回后，紧接着写 `game.on("state", ...)`，中间不要再 `await`。后连上的大屏会在这一刻收到最近一份坐标；监听挂晚了，这一份补发就错过了。之后新推的坐标仍会正常到达。

### 8.3 大屏有没有连着

```js
if (game.displayConnected) {
  // 至少有一块大屏
}

game.on("displayGone", () => {
  // 最后一块大屏离开了。要不要暂停由你决定，主机会继续转发
});

game.on("displayReady", () => {
  // 从一块都没有，到有了第一块。可以取消暂停
});
```

多开一块、关掉其中一块但还剩别的，都不会触发这两个事件。`shared-screen` 开局时已经有大屏。中途全部离开不会自动结束这一局，也不会被框架暂停。

`personal` 不要求大屏。你如果另外做了 display 页，可以用这两个事件决定要不要在大屏上放公共信息。

### 8.4 存档

只有这一局已经开始、而且就是你这款游戏时才能读写。

```js
await game.save.set("highScore", 12);
const score = await game.save.get("highScore"); // 没有这条时是 undefined

await game.save.setShared("lastWinner", "小明");
const name = await game.save.getShared("lastWinner");
```

值必须能 `JSON.stringify`。一条最多约 64KB，这一款游戏的存档合计大约 1MB。私有档跟这个人走，换一台手机、重新选同一个名字，还能读到。共享档全家人一份。

正式进度不要只放在某台设备的 `localStorage`。

### 8.5 结束和日志

任何在局玩家都可以调用 `game.end()`，全体回到大厅。外壳菜单走的也是它。在 `on("end")` 里做清理即可，不用自己跳转，页面会被卸掉。

```js
game.log.info("发题", { index: 3 });
game.log.warn("有人抢答太晚");
game.log.error("判题失败", { playerId: game.me.id });
```

日志出现在跑主机的那台电脑的管理页，不会出现在玩家屏幕上。`data` 可省略，必须能序列化。每条约 2KB，同一页大约每秒 20 条，多了会被丢。

页面上没接住的异常，SDK 会记成错误日志。你自己 `try/catch` 住的，要查就再调 `game.log.error`。

---

## 9. 主机脚本 server.js

适合不能让某一台手机改分数的玩法。在 manifest 里写上 `"server": "server.js"`。

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

`onTick` 按 `tickHz` 调用，默认每秒 20 次，最高 60 次。`dtMs` 是距上一拍的毫秒数，最大按 100 计。

`onDisplay(connected)` 只在「从没有大屏到有」或「最后一块离开」时调用。用来暂停，或在大屏回来时再推一次画面。中途多连一块屏时，主机已经把最近一份坐标补过去了。

`ctx` 能做的：

| 成员 | 作用 |
|------|------|
| `ctx.players` | `{ id, name, color }[]` |
| `ctx.displayConnected` | 此刻是否至少有一块大屏 |
| `ctx.pushDisplay(state)` | 把画面数据发给所有大屏。大屏在 `on("state")` 里画 |
| `ctx.pushController(playerId, payload)` | 发给某一个玩家，对方在 `on("message")` 里收 |
| `ctx.broadcastPlayers(payload)` | 发给所有在局玩家 |
| `await ctx.save.get(playerId, key)` | 读这个人的私有档 |
| `await ctx.save.set(playerId, key, value)` | 写这个人的私有档 |
| `await ctx.save.getShared(key)` / `setShared(key, value)` | 共享档 |
| `ctx.end()` | 结束这一局 |
| `ctx.log.info / warn / error / debug` | 和管理页是同一份日志 |

玩家的 `sendInput` 进入 `onInput`。玩家的 `send` / `broadcast` 进入 `onMessage`。

不能做的：开端口、读其他游戏的存档、写任意磁盘、自己发 HTTP、起子进程。钩子抛错时这一局结束，大家回大厅，主机继续可用。

仓库里的「接住它」就是这种接法：`games/catch-drop/`。下落和计分在 `server.js`，大屏只画，手机只发左右。

---

## 10. 三种页面分别怎么写

### 玩家页（personal）

每个人一份 `player/index.html`。用 `game.me.id` 区分「我的牌 / 我是不是卧底」。

权威页持有题目和分数，用 `broadcast` 公布阶段。其他人把答案 `send` 给权威，或 `broadcast` 一份答题事件，由权威认定。

### 手柄页（shared-screen / hybrid）

竖屏、大按钮、少字。不要把整张地图画在手机上。分数条可以有。

摇杆用 `-1～1`，自己节流后再 `sendInput`。按下和抬起分开：

```js
game.sendInput({ type: "stick", x: -1, y: 0 });
game.sendInput({ type: "button", id: "a", down: true });
game.sendInput({ type: "button", id: "a", down: false });
```

没有 `server.js` 时，点开始的那一页还要在 `displayGone` 里暂停。有 `server.js` 时，暂停写在 `onDisplay` 里，手柄页只发操作。

### 大屏页

按 16:9 来做，字要大，坐在沙发上看得清。不要依赖鼠标悬停。

这一页不算规则。在 `on("state")` 里把收到的对象画出来。空闲时的大厅不是你写的，你的页面只在开局后出现。

---

## 11. 在自己电脑上试

1. 沙发派对已经在这台电脑上跑着。
2. 把构建结果放到它的 `games/你的id/` 目录。`manifest.json` 的 `id` 和文件夹名相同。
3. 打开管理页，点游戏列表的「刷新」。不必为了试一款游戏重启，除非你改的是主机自己。
4. 手机打开加入地址，选名字。大屏类游戏再打开大屏地址。人数够了再点开始。
5. 改完代码，重新构建，再拷一次，再刷新。

调试时开着管理页的「游戏日志」。浏览器的开发者工具可以看连接，但给其他开发者看的信息请走 `game.log`。资源打进包里，对局不要依赖外网。

---

## 12. 交给别人安装

1. 确认这个目录能被主机扫到，并且能开一局。
2. 打 zip。解开后能直接看到 `manifest.json`，或者只有一层 `你的id/manifest.json`。不要把系统的压缩目录再套一层。
3. 算 sha256，小写十六进制。没有校验码的包，主机拒绝安装。
4. zip 里不能有 `../` 这种路径。整个包大约不要超过 80MB。
5. 把 zip 放到一个能直接下载的地址，写一份目录：

```json
{
  "name": "我的游戏源",
  "homepage": "https://example.com",
  "games": [
    {
      "id": "quiz-party",
      "name": "家庭抢答",
      "version": "1.0.0",
      "description": "看题抢答",
      "cover": "https://example.com/cover.png",
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

6. 把这份目录的网址发给主机用户。他们在管理页添加游戏源，再点安装。

`sdkRange` 写你是按 SDK 1.0 做的。卸载游戏默认留下存档。

框架不审核游戏内容。别人添加你的源，等于信任你。

---

## 13. 不要做的事

- 要求玩家再装 App，或在自己电脑上再开一个服务
- 用浏览器种类判断「我是不是电视」。你被打开的那个 html，就是你的身份
- 在手柄页画完整世界
- 把正式进度只存在某一台手机上
- 相信别的客户端发来的「我赢了」，而不经过权威页或 `server.js`
- 每秒发送几十次完整大对象。操作自己节流；画面数据有变化再推，大屏类游戏大约每秒 10 次就够用
- 依赖外网才能开局

技术选型没有强制。TypeScript 和 Vite（`base: "./"`）比较省事。页面可以是普通 HTML。包越大，电视和手机越慢。

---

## 14. 两个最小流程

### 每人一屏的抢答

1. 权威页抽题：`broadcast({ type: "question", text, deadline })`。
2. 每人看到题目。抢到就 `broadcast({ type: "buzz", playerId: game.me.id })`。
3. 权威页只认第一份，再 `broadcast({ type: "lock", winnerId })`，然后改分。
4. `await game.save.setShared("lastWinner", name)`。
5. 若干题之后 `game.end()`。

### 大屏加手柄，谁先按下

1. 权威在点开始的手柄页，或者在 `server.js`。大屏不计算。
2. 权威把「现在可以按了」放进 `sendState` / `pushDisplay`。
3. 手柄只发 `sendInput({ type: "button", id: "a", down: true })`。
4. 权威认定第一个有效按键，把名字、颜色和分数放进下一份画面数据。
5. 每一块大屏都在 `on("state")` 里把这份数据画出来。

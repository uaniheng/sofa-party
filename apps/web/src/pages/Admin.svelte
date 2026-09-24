<script lang="ts">
  import {
    type GameInfo,
    type GameLogEntry,
    type LogsResponse,
    type MetaResponse,
    type PlayerPublic,
    type SourceInfo,
  } from "@family/protocol";
  import { api } from "../lib/api";

  let meta = $state<MetaResponse | null>(null);
  let games = $state<GameInfo[]>([]);
  let sources = $state<SourceInfo[]>([]);
  let sourceUrl = $state("");
  let error = $state("");
  let info = $state("");
  let installing = $state("");
  let logs = $state<GameLogEntry[]>([]);
  let logAfter = $state(0);
  let logFilter = $state<"all" | "warn" | "error">("all");
  let stickBottom = $state(true);
  let currentGameId = $state<string | null>(null);
  let logBox: HTMLElement | undefined;
  type HomePlayer = PlayerPublic & { online: boolean };
  let players = $state<HomePlayer[]>([]);
  let kicking = $state<string | null>(null);
  let confirmingUninstall = $state("");
  let confirmingRemoveSource = $state("");
  let installingCert = $state(false);
  let issuingCert = $state(false);
  let metaRev = 0;

  const panels = [
    { id: "connect", label: "连接" },
    { id: "motion", label: "体感" },
    { id: "games", label: "游戏" },
    { id: "logs", label: "日志" },
  ] as const;
  type Panel = (typeof panels)[number]["id"];

  function panelFromHash(): Panel {
    const id = location.hash.replace("#", "");
    if (id === "people") return "connect";
    return panels.some((item) => item.id === id) ? (id as Panel) : "connect";
  }

  let panel = $state<Panel>(panelFromHash());

  function openPanel(id: Panel) {
    panel = id;
    history.replaceState(null, "", `#${id}`);
  }

  function qrSrc(kind: string, text: string) {
    return `/api/qr?kind=${kind}&u=${encodeURIComponent(text)}`;
  }

  const visibleLogs = $derived(
    logs.filter((e) => {
      if (logFilter === "error") return e.level === "error";
      if (logFilter === "warn") return e.level === "warn" || e.level === "error";
      return true;
    }),
  );

  function levelLabel(level: string) {
    if (level === "error") return "错误";
    if (level === "warn") return "警告";
    if (level === "debug") return "调试";
    return "信息";
  }

  function formatTime(ts: number) {
    return new Date(ts).toLocaleTimeString("zh-CN", { hour12: false });
  }

  function formatLine(e: GameLogEntry) {
    const who = e.playerName || e.role || e.source;
    const extra = e.data === undefined ? "" : " " + JSON.stringify(e.data);
    return `${formatTime(e.ts)} [${levelLabel(e.level)}] ${e.gameId ?? "-"} ${who} ${e.message}${extra}`;
  }

  async function reload() {
    meta = await api<MetaResponse>("/api/meta");
    games = await api<GameInfo[]>("/api/games");
    sources = await api<SourceInfo[]>("/api/sources");
    players = await api<HomePlayer[]>("/api/players");
  }

  async function loadPlayers() {
    players = await api<HomePlayer[]>("/api/players");
  }

  async function kick(id: string) {
    kicking = id;
    error = "";
    try {
      await api(`/api/players/${id}/kick`, { method: "POST" });
      info = "已踢下线，对方需要重新选人";
      await loadPlayers();
    } catch (e) {
      error = (e as Error).message;
    } finally {
      kicking = null;
    }
  }

  async function pullLogs() {
    const data = await api<LogsResponse>(`/api/logs?after=${logAfter}`);
    currentGameId = data.gameId;
    if (!data.entries.length) return;
    logs = [...logs, ...data.entries].slice(-500);
    logAfter = data.entries[data.entries.length - 1]!.id;
    if (stickBottom) {
      queueMicrotask(() => {
        if (logBox) logBox.scrollTop = logBox.scrollHeight;
      });
    }
  }

  async function clearLogs() {
    await api("/api/logs", { method: "DELETE" });
    logs = [];
    logAfter = 0;
  }

  async function copyLogs() {
    const text = visibleLogs.map(formatLine).join("\n");
    await navigator.clipboard.writeText(text || "(空)");
    info = "日志已复制";
  }

  async function issueCert() {
    issuingCert = true;
    error = "";
    try {
      meta = await api<MetaResponse>("/api/cert/issue", { method: "POST" });
      info = "证书已生成";
    } catch (e) {
      error = (e as Error).message;
    } finally {
      issuingCert = false;
    }
  }

  async function installCert() {
    installingCert = true;
    error = "";
    try {
      meta = await api<MetaResponse>("/api/cert/install", { method: "POST" });
    } catch (e) {
      error = (e as Error).message;
    } finally {
      installingCert = false;
    }
  }

  async function selectIp(ip: string) {
    const rev = ++metaRev;
    error = "";
    try {
      const next = await api<MetaResponse>("/api/meta", {
        method: "PATCH",
        body: JSON.stringify({ selectedAddress: ip }),
      });
      if (rev !== metaRev) return;
      meta = next;
    } catch (e) {
      error = (e as Error).message;
    } finally {
      if (rev === metaRev) metaRev++;
    }
  }

  async function refreshGames() {
    games = await api<GameInfo[]>("/api/games/refresh", { method: "POST" });
    info = "已重新扫描游戏目录";
  }

  async function addSource() {
    error = "";
    try {
      await api("/api/sources", { method: "POST", body: JSON.stringify({ url: sourceUrl }) });
      sourceUrl = "";
      await reload();
    } catch (e) {
      error = (e as Error).message;
    }
  }

  async function refreshSource(id: string) {
    await api(`/api/sources/${id}/refresh`, { method: "POST" });
    await reload();
  }

  async function removeSource(id: string) {
    error = "";
    try {
      await api(`/api/sources/${id}`, { method: "DELETE" });
      confirmingRemoveSource = "";
      info = "已删除游戏源（已安装的游戏不会自动卸载）";
      await reload();
    } catch (e) {
      error = (e as Error).message;
    }
  }

  async function install(sourceId: string, gameId: string) {
    installing = gameId;
    error = "";
    info = "";
    try {
      await api(`/api/sources/${sourceId}/install`, {
        method: "POST",
        body: JSON.stringify({ gameId }),
      });
      info = "安装完成";
      await reload();
    } catch (e) {
      error = (e as Error).message;
    } finally {
      installing = "";
    }
  }

  async function uninstall(id: string, purgeSaves = false) {
    error = "";
    try {
      await api(`/api/games/${id}/uninstall`, {
        method: "POST",
        body: JSON.stringify({ purgeSaves }),
      });
      info = "已卸载";
      confirmingUninstall = "";
      await reload();
    } catch (e) {
      error = (e as Error).message;
    }
  }

  async function clearSaves(id: string) {
    await api(`/api/games/${id}/saves/clear`, { method: "POST" });
    info = "存档已清除";
  }

  $effect(() => {
    let timer: ReturnType<typeof setInterval> | undefined;
    let cancelled = false;
    reload()
      .then(() => {
        if (cancelled) return;
        pullLogs().catch(() => {});
        loadPlayers().catch(() => {});
        timer = setInterval(() => {
          pullLogs().catch(() => {});
          loadPlayers().catch(() => {});
          const rev = metaRev;
          api<MetaResponse>("/api/meta")
            .then((next) => {
              if (rev !== metaRev) return;
              meta = next;
            })
            .catch(() => {});
        }, 800);
      })
      .catch((e) => {
        if (!cancelled) error = e.message ?? "请在这台电脑上打开管理页";
      });
    return () => {
      cancelled = true;
      if (timer) clearInterval(timer);
    };
  });
</script>

<div class="shell">
  <aside>
    <div class="brand">沙发派对</div>
    <nav>
      {#each panels as item (item.id)}
        <button type="button" class="nav" class:on={panel === item.id} onclick={() => openPanel(item.id)}>
          {item.label}
        </button>
      {/each}
    </nav>
  </aside>

  <main class="admin-main">
    {#if error}<p class="bad">{error}</p>{/if}
    {#if info}<p class="ok">{info}</p>{/if}

    {#if panel === "connect"}
      <section class="card">
        <div class="label">大屏地址（电视手输）</div>
        <div class="screen-url">{meta?.screenUrl ?? "正在读取…"}</div>
        <div class="row">
          <button onclick={() => window.open("/screen", "_blank")}>本机当大屏</button>
          <span class="muted">电脑已经用 HDMI 接到电视时点这个。默认不会自动占用大屏。</span>
        </div>
      </section>

      <section class="card">
        <h2>家里 Wi‑Fi 网卡</h2>
        <p class="muted">换一张网卡，下面的加入码会改成这个地址。</p>
        <div class="grid">
          {#each meta?.lanAddresses ?? [] as ip}
            <label class="ip">
              <input type="radio" name="ip" checked={meta?.selectedAddress === ip} onchange={() => selectIp(ip)} />
              {ip}
            </label>
          {/each}
          {#if !meta?.lanAddresses.length}
            <p class="muted">没有找到局域网地址，请检查电脑是否连着 Wi‑Fi。</p>
          {/if}
        </div>
      </section>

      <section class="card qr-box">
        <div>
          <h2>手机加入码</h2>
          <p class="muted">只给手机扫。加入地址：{meta?.joinUrl}</p>
        </div>
        {#if meta}
          <img src={qrSrc("join", meta.joinUrl)} alt="手机加入二维码" />
        {/if}
      </section>

      <section class="card">
        <h2>家里的人</h2>
        <p class="muted">踢下线会放开这个名字，对方回到选人页。档案还在，可以再选。</p>
        {#if !players.length}
          <p class="muted">还没有创建过名字。</p>
        {:else}
          {#each players as p (p.id)}
            <div class="row game-row person-row">
              <div class="person" style="--c: {p.color}">
                <span class="swatch"></span>
                <strong>{p.name}</strong>
                {#if p.online}<span class="badge">在线</span>{:else}<span class="muted">空闲</span>{/if}
              </div>
              <button class="danger" disabled={!p.online || kicking === p.id} onclick={() => kick(p.id)}>
                {kicking === p.id ? "正在踢…" : "踢下线"}
              </button>
            </div>
          {/each}
        {/if}
      </section>
    {:else if panel === "motion"}
      <section class="card">
        <h2>手机体感</h2>
        <p class="muted">手机浏览器只在 https 下提供体感。证书在这里手动生成，启动服务时不会自动做。</p>
        {#if meta}
          <p class={meta.cert.localTrust === "trusted" ? "ok" : "muted"}>{meta.cert.localTrustMessage}</p>
          {#if !meta.cert.issued}
            <button type="button" disabled={issuingCert} onclick={issueCert}>
              {issuingCert ? "正在生成…" : "生成证书"}
            </button>
          {:else}
            {#if !meta.cert.coversAddress}
              <p class="muted">当前局域网地址不在这张证书里。请先到「连接」里选定网卡。</p>
              <button class="secondary" type="button" disabled={issuingCert} onclick={issueCert}>
                {issuingCert ? "正在生成…" : "按当前地址重新签发"}
              </button>
            {/if}
            {#if meta.cert.localTrust !== "trusted"}
              <button
                class="secondary"
                type="button"
                disabled={installingCert || meta.cert.localTrust === "pending"}
                onclick={installCert}
              >
                {installingCert || meta.cert.localTrust === "pending" ? "正在安装到这台电脑…" : "安装到这台电脑"}
              </button>
            {/if}
            <div class="qr-pair">
              <div>
                <img src={qrSrc("cert", meta.cert.downloadUrl)} alt="下载证书二维码" />
                <div class="label">1. 下载证书</div>
                <p class="muted">{meta.cert.downloadUrl}</p>
              </div>
              {#if meta.cert.httpsJoinUrl}
                <div>
                  <img src={qrSrc("https", meta.cert.httpsJoinUrl)} alt="体感加入二维码" />
                  <div class="label">2. 装好后加入</div>
                  <p class="muted">{meta.cert.httpsJoinUrl}</p>
                </div>
              {:else if meta.cert.httpsError}
                <p class="bad">{meta.cert.httpsError}</p>
              {/if}
            </div>
          {/if}
        {:else}
          <p class="muted">正在读取…</p>
        {/if}
      </section>
    {:else if panel === "games"}
      <section class="card">
        <div class="row">
          <h2>已装游戏</h2>
          <button class="secondary" onclick={refreshGames}>刷新</button>
        </div>
        {#each games as game (game.id)}
          <div class="row game-row">
            <div>
              <strong>{game.name}</strong>
              <span class="muted"> {game.id} v{game.version}</span>
              {#if game.broken}<div class="bad">{game.error}</div>{/if}
            </div>
            <button class="secondary" onclick={() => clearSaves(game.id)}>清存档</button>
            {#if confirmingUninstall === game.id}
              <span class="muted">确定卸载「{game.name}」？</span>
              <button class="secondary" onclick={() => (confirmingUninstall = "")}>取消</button>
              <button class="danger" onclick={() => uninstall(game.id)}>确定卸载</button>
            {:else}
              <button class="danger" onclick={() => (confirmingUninstall = game.id)}>卸载</button>
            {/if}
          </div>
        {/each}
      </section>

      <section class="card">
        <h2>游戏源</h2>
        <form
          class="row"
          onsubmit={(e) => {
            e.preventDefault();
            addSource();
          }}
        >
          <input bind:value={sourceUrl} placeholder="https://.../catalog.json" />
          <button type="submit">添加</button>
        </form>
        {#each sources as source (source.id)}
          <article class="source">
            <div class="row">
              <strong>{source.name || "游戏源"}</strong>
              <button class="secondary" onclick={() => refreshSource(source.id)}>刷新目录</button>
              {#if confirmingRemoveSource === source.id}
                <span class="muted">只删订阅，已装游戏保留</span>
                <button class="secondary" onclick={() => (confirmingRemoveSource = "")}>取消</button>
                <button class="danger" onclick={() => removeSource(source.id)}>确定删除</button>
              {:else}
                <button class="danger" onclick={() => (confirmingRemoveSource = source.id)}>删除</button>
              {/if}
            </div>
            <p class="muted">{source.url}</p>
            {#each source.catalog?.games ?? [] as g (g.id)}
              <div class="row game-row">
                <span>{g.name} v{g.version}</span>
                <button disabled={installing === g.id} onclick={() => install(source.id, g.id)}>
                  {installing === g.id ? "安装中…" : "安装"}
                </button>
              </div>
            {/each}
          </article>
        {/each}
      </section>
    {:else}
      <section class="card">
        <div class="row">
          <h2>游戏日志</h2>
          <span class="muted">{currentGameId ? `正在玩 ${currentGameId}` : "大厅空闲"}</span>
        </div>
        <p class="muted">做游戏时开着这页。手机和电视上的 log、页面报错会汇到这里，不会显示给玩家。</p>
        <div class="row">
          <button class="secondary" class:on={logFilter === "all"} onclick={() => (logFilter = "all")}>全部</button>
          <button class="secondary" class:on={logFilter === "warn"} onclick={() => (logFilter = "warn")}>警告以上</button>
          <button class="secondary" class:on={logFilter === "error"} onclick={() => (logFilter = "error")}>只看错误</button>
          <button class="secondary" onclick={() => (stickBottom = !stickBottom)}>
            {stickBottom ? "跟随最新" : "已暂停跟随"}
          </button>
          <button class="secondary" onclick={copyLogs}>复制</button>
          <button class="danger" onclick={clearLogs}>清空</button>
        </div>
        <div class="log-box" bind:this={logBox}>
          {#if !visibleLogs.length}
            <div class="muted">还没有日志。开始一局游戏后会出现。</div>
          {:else}
            {#each visibleLogs as e (e.id)}
              <div class="log-line {e.level}">
                <span class="t">{formatTime(e.ts)}</span>
                <span class="lv">{levelLabel(e.level)}</span>
                <span class="who">{e.playerName ?? e.role ?? e.source}</span>
                <span class="msg">{e.message}</span>
                {#if e.data !== undefined}
                  <span class="extra">{JSON.stringify(e.data)}</span>
                {/if}
              </div>
            {/each}
          {/if}
        </div>
      </section>
    {/if}
  </main>
</div>

<style>
  .shell {
    display: flex;
    min-height: 100vh;
    align-items: stretch;
  }
  aside {
    position: sticky;
    top: 0;
    flex: 0 0 200px;
    height: 100vh;
    padding: 22px 12px;
    background: #181c27;
    border-right: 1px solid var(--line);
  }
  .brand {
    padding: 6px 14px 18px;
    font-size: 18px;
    font-weight: 800;
  }
  nav {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  button.nav {
    width: 100%;
    text-align: left;
    background: transparent;
    color: var(--text);
    border-radius: 12px;
    padding: 12px 14px;
  }
  button.nav.on {
    background: var(--accent);
    color: #1a1408;
    outline: none;
  }
  .admin-main {
    flex: 1;
    min-width: 0;
    max-width: 920px;
    padding: 28px 28px 64px;
    display: flex;
    flex-direction: column;
    gap: 16px;
    overflow-wrap: anywhere;
  }
  @media (max-width: 760px) {
    .shell {
      flex-direction: column;
    }
    aside {
      position: sticky;
      top: 0;
      z-index: 2;
      flex-basis: auto;
      width: auto;
      height: auto;
      padding: 12px;
      border-right: 0;
      border-bottom: 1px solid var(--line);
    }
    .brand {
      padding: 4px 8px 10px;
    }
    nav {
      flex-direction: row;
      overflow: auto;
    }
    button.nav {
      width: auto;
      white-space: nowrap;
    }
    .admin-main {
      padding: 16px;
    }
    .qr-box {
      flex-direction: column;
      align-items: flex-start;
    }
  }
  .label {
    color: var(--muted);
    font-weight: 700;
  }
  .screen-url {
    font-size: clamp(22px, 3vw, 36px);
    font-weight: 800;
    line-height: 1.2;
    letter-spacing: 0.01em;
    overflow-wrap: anywhere;
    margin: 8px 0 18px;
  }
  .qr-box {
    display: flex;
    justify-content: space-between;
    gap: 16px;
    align-items: center;
  }
  .qr-box img {
    width: 220px;
    height: 220px;
    background: white;
    border-radius: 20px;
    padding: 10px;
  }
  .qr-pair {
    display: flex;
    flex-wrap: wrap;
    gap: 28px;
    margin-top: 16px;
  }
  .qr-pair img {
    width: 200px;
    height: 200px;
    background: white;
    border-radius: 20px;
    padding: 10px;
  }
  .qr-pair p {
    max-width: 220px;
    word-break: break-all;
  }
  .ip {
    display: flex;
    gap: 10px;
    align-items: center;
    background: #11141c;
    padding: 12px;
    border-radius: 12px;
  }
  .ip input {
    width: auto;
  }
  .game-row,
  .source {
    margin-top: 12px;
  }
  .person-row {
    justify-content: space-between;
  }
  .person {
    display: flex;
    align-items: center;
    gap: 10px;
  }
  .swatch {
    width: 16px;
    height: 16px;
    border-radius: 50%;
    background: var(--c);
  }
  .bad {
    color: var(--danger);
  }
  .ok {
    color: var(--ok);
  }
  button.on {
    outline: 2px solid var(--accent);
  }
  .log-box {
    margin-top: 12px;
    max-height: 360px;
    overflow: auto;
    background: #0d1017;
    border-radius: 12px;
    padding: 12px;
    font-family: ui-monospace, Consolas, monospace;
    font-size: 13px;
    line-height: 1.45;
  }
  .log-line {
    display: grid;
    grid-template-columns: 76px 40px minmax(64px, 90px) 1fr;
    gap: 8px;
    align-items: baseline;
  }
  .log-line.error {
    color: #ff8b8b;
  }
  .log-line.warn {
    color: #f0c75e;
  }
  .log-line.debug {
    color: #7d8699;
  }
  .log-line .extra {
    grid-column: 4;
    color: #7d8699;
    word-break: break-all;
  }
  .log-line .msg {
    word-break: break-word;
  }
</style>

<script lang="ts">
  import {
    MAX_PLAYER_NAME,
    STORAGE_ME,
    STORAGE_TOKEN,
    type PlayerPublic,
    type WsServerMessage,
  } from "@family/protocol";
  import { api } from "../lib/api";
  import Lobby from "./Lobby.svelte";

  type Player = PlayerPublic & { online: boolean };

  function readMe(): PlayerPublic | null {
    try {
      const raw = localStorage.getItem(STORAGE_ME);
      if (!raw) return null;
      const value = JSON.parse(raw) as PlayerPublic;
      if (value?.id && value.name && value.color) return value;
    } catch {
      /* ignore */
    }
    return null;
  }

  let players = $state<Player[]>([]);
  let name = $state("");
  let token = $state(localStorage.getItem(STORAGE_TOKEN) ?? "");
  let me = $state<PlayerPublic | null>(readMe());
  let error = $state("");
  let connected = $derived(!!token);
  let claiming = $state<string | null>(null);

  async function load() {
    players = await api<Player[]>("/api/players");
  }

  async function create() {
    error = "";
    try {
      const created = await api<{ token: string } & PlayerPublic>("/api/players", {
        method: "POST",
        body: JSON.stringify({ name }),
      });
      remember(created, created.token);
    } catch (e) {
      error = (e as Error).message;
      await load();
    }
  }

  async function claim(playerId: string) {
    const target = players.find((p) => p.id === playerId);
    if (!target || target.online || claiming) return;
    error = "";
    claiming = playerId;
    try {
      const res = await api<{ token: string; player: PlayerPublic }>("/api/players/claim", {
        method: "POST",
        body: JSON.stringify({ playerId }),
      });
      remember(res.player, res.token);
    } catch (e) {
      error = (e as Error).message;
      await load();
    } finally {
      claiming = null;
    }
  }

  function remember(player: PlayerPublic, nextToken: string) {
    me = player;
    token = nextToken;
    localStorage.setItem(STORAGE_TOKEN, nextToken);
    localStorage.setItem(STORAGE_ME, JSON.stringify(player));
  }

  function rememberMe(player: PlayerPublic) {
    me = player;
    localStorage.setItem(STORAGE_ME, JSON.stringify(player));
  }

  function clearIdentity() {
    localStorage.removeItem(STORAGE_TOKEN);
    localStorage.removeItem(STORAGE_ME);
    token = "";
    me = null;
    load().catch(() => {});
  }

  async function leave() {
    try {
      await api("/api/players/leave", { method: "POST" });
    } catch {
      /* already gone */
    }
    clearIdentity();
  }

  $effect(() => {
    if (connected) return;
    let stopped = false;
    let ws: WebSocket | null = null;
    let retry: ReturnType<typeof setTimeout> | undefined;

    function connect() {
      load().catch((e) => {
        if (!stopped) error = (e as Error).message;
      });
      const proto = location.protocol === "https:" ? "wss:" : "ws:";
      const socket = new WebSocket(`${proto}//${location.host}/ws`);
      ws = socket;
      socket.addEventListener("open", () => {
        socket.send(JSON.stringify({ type: "hello", role: "watcher" }));
      });
      socket.addEventListener("message", (ev) => {
        let msg: WsServerMessage;
        try {
          msg = JSON.parse(String(ev.data)) as WsServerMessage;
        } catch {
          return;
        }
        if (msg.type === "roster") load().catch(() => {});
      });
      socket.addEventListener("close", () => {
        if (stopped || ws !== socket) return;
        retry = setTimeout(connect, 1000);
      });
    }

    connect();
    return () => {
      stopped = true;
      if (retry) clearTimeout(retry);
      ws?.close();
    };
  });
</script>

<main class="wrap">
  <h1>沙发派对</h1>
  {#if connected}
    <section class="you card">
      <span class="swatch you-swatch" style="--c: {me?.color ?? '#888'}"></span>
      <div class="you-text">
        <p class="muted">你是</p>
        <strong>{me?.name ?? "正在确认…"}</strong>
      </div>
      <button class="secondary" type="button" onclick={leave}>换一个人</button>
    </section>
    <Lobby canStart token={token} me={me} onIdentity={rememberMe} onKicked={clearIdentity} />
  {:else}
    <p class="muted">不用房间号。选一个还没人占用的名字，先进去的人占住。</p>
    {#if location.protocol !== "https:"}
      <p class="muted">要用体感的话，先<a href="/cert">安装主机证书</a>，再用管理页上的 https 加入码进来。</p>
    {/if}
    <section class="card">
      <h2>我是谁</h2>
      {#if error}<p class="bad">{error}</p>{/if}
      <div class="grid">
        {#each players as p (p.id)}
          <button
            class="secondary person"
            class:taken={p.online}
            style="--c: {p.color}"
            disabled={p.online || claiming === p.id}
            onclick={() => claim(p.id)}
          >
            <span class="swatch"></span>
            <span>{p.name}</span>
            {#if p.online}<small>已加入</small>{/if}
          </button>
        {/each}
      </div>
      <form
        class="row new"
        onsubmit={(e) => {
          e.preventDefault();
          create();
        }}
      >
        <input bind:value={name} maxlength={MAX_PLAYER_NAME} placeholder="新名字，比如 小明" />
        <button type="submit">创建</button>
      </form>
    </section>
  {/if}
</main>

<style>
  .you {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 14px;
    margin: 16px 0;
  }
  .you-text {
    flex: 1;
    min-width: 0;
  }
  .you-text p {
    margin: 0;
    font-size: 13px;
  }
  .you-text strong {
    font-size: 28px;
    line-height: 1.15;
  }
  .you-swatch {
    width: 36px;
    height: 36px;
    flex-shrink: 0;
  }
  .you .secondary {
    flex-shrink: 0;
  }
  .person {
    display: flex;
    justify-content: flex-start;
    gap: 10px;
    min-height: 52px;
  }
  .person.taken {
    opacity: 0.45;
    cursor: not-allowed;
  }
  .swatch {
    width: 18px;
    height: 18px;
    border-radius: 50%;
    background: var(--c);
  }
  .new {
    margin-top: 16px;
  }
  .new input {
    flex: 1;
    min-width: 160px;
  }
  .bad {
    color: var(--danger);
  }
</style>

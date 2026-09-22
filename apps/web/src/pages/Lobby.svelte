<script lang="ts">
  import { type GameInfo, type PartyStateMessage, type PlayerPublic } from "@family/protocol";
  import { untrack } from "svelte";
  import { api } from "../lib/api";
  import { connectShell } from "../lib/ws";

  type Props = {
    canStart?: boolean;
    token?: string;
    me?: PlayerPublic | null;
    onIdentity?: (player: PlayerPublic) => void;
    onKicked?: () => void;
  };

  let { canStart = false, token = "", me = null, onIdentity, onKicked }: Props = $props();

  let party = $state<PartyStateMessage | null>(null);
  let games = $state<GameInfo[]>([]);
  let error = $state("");
  let socket: ReturnType<typeof connectShell> | null = null;

  function modeLabel(mode: string) {
    if (mode === "personal") return "每人一屏";
    if (mode === "shared-screen") return "电视+手柄";
    return "电视+私密";
  }

  function playersLabel(game: GameInfo) {
    if (game.minPlayers === game.maxPlayers) return `${game.minPlayers} 人`;
    return `${game.minPlayers}～${game.maxPlayers} 人`;
  }

  function startBlock(game: GameInfo, online: number, displayConnected: boolean) {
    if (online < game.minPlayers || online > game.maxPlayers) {
      return `现在 ${online} 人，这款要 ${playersLabel(game)}`;
    }
    if ((game.playMode === "shared-screen" || game.playMode === "hybrid") && !displayConnected) {
      return "请先打开大屏";
    }
    return "";
  }

  async function loadGames() {
    games = await api<GameInfo[]>("/api/games");
  }

  $effect(() => {
    loadGames().catch((e) => (error = e.message));
    socket = connectShell({
      role: canStart ? "player" : "display",
      token,
      onState: (msg) => {
        party = msg;
        error = "";
      },
      onError: (message) => {
        error = message;
      },
      onHello: (player) => {
        if (player) untrack(() => onIdentity)?.(player);
      },
      onKicked: () => {
        if (canStart) {
          untrack(() => onKicked)?.();
        } else {
          location.reload();
        }
      },
    });
    return () => socket?.close();
  });
</script>

{#if error}
  <p class="muted">{error}</p>
{/if}

<section class="card status">
  <div class="row">
    <span class="dot" class:on={party?.displayConnected}></span>
    <strong>
      {#if !party?.displayConnected}
        还没有大屏
      {:else if party.displayCount === 1}
        大屏已连接
      {:else}
        {party.displayCount} 块大屏已连接
      {/if}
    </strong>
  </div>
  <p class="muted">
    {#if party?.phase === "playing"}
      正在玩：{games.find((g) => g.id === party?.gameId)?.name ?? party?.gameId}
    {:else}
      大厅空闲，可以开始一款游戏
    {/if}
  </p>
  {#if party?.view === "wait"}
    <p>这局已经满了，请等大家玩完。</p>
  {/if}
</section>

<section>
  <h2>谁在线</h2>
  <div class="row">
    {#if !party?.online.length}
      <p class="muted">还没有人进来</p>
    {:else}
      {#each party.online as p (p.id)}
        <div class="person" class:mine={me && p.id === me.id} style="--c: {p.color}">
          <span class="swatch"></span>
          {p.name}
          {#if me && p.id === me.id}<small>我</small>{/if}
        </div>
      {/each}
    {/if}
  </div>
</section>

<section>
  <h2>游戏</h2>
  <div class="grid games">
    {#each games as game (game.id)}
      <article class="card game" class:broken={game.broken}>
        <div class="row">
          <h3>{game.name}</h3>
          <span class="badge">{modeLabel(game.playMode)}</span>
        </div>
        <p class="muted">{game.description || " "}</p>
        <p class="muted">{playersLabel(game)}</p>
        {#if game.broken}
          <p class="bad">坏包：{game.error}</p>
        {:else if canStart && party?.phase !== "playing"}
          {@const block = startBlock(game, party?.online.length ?? 0, !!party?.displayConnected)}
          {#if block}
            <p class="muted">{block}</p>
            <button disabled>开始</button>
          {:else}
            <button onclick={() => socket?.start(game.id)}>开始</button>
          {/if}
        {/if}
      </article>
    {/each}
  </div>
</section>

{#if canStart && party?.phase === "playing"}
  <p>
    <button class="danger" onclick={() => socket?.end()}>结束这局，回大厅</button>
  </p>
{/if}

<style>
  .status {
    margin: 16px 0;
  }
  .dot {
    width: 12px;
    height: 12px;
    border-radius: 50%;
    background: #666;
  }
  .dot.on {
    background: var(--ok);
    box-shadow: 0 0 12px var(--ok);
  }
  .person {
    display: flex;
    align-items: center;
    gap: 8px;
    background: #11141c;
    border-radius: 999px;
    padding: 8px 12px;
    font-weight: 700;
  }
  .person.mine {
    outline: 2px solid var(--c);
  }
  .person small {
    color: var(--muted);
    font-weight: 700;
  }
  .swatch {
    width: 14px;
    height: 14px;
    border-radius: 50%;
    background: var(--c);
  }
  .game h3 {
    margin: 0;
  }
  .broken {
    opacity: 0.7;
  }
  .bad {
    color: var(--danger);
  }
</style>

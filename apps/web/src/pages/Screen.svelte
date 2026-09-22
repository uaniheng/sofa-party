<script lang="ts">
  import Lobby from "./Lobby.svelte";

  let qr = $state("/api/qr?kind=join");
</script>

<main class="screen">
  <header>
    <h1>沙发派对</h1>
    <p class="muted">电视不用选名字。请用手机扫下面的码加入。</p>
  </header>
  <div class="layout">
    <img class="qr" src={qr} alt="手机加入码" />
    <div class="lobby">
      <Lobby />
    </div>
  </div>
</main>

<style>
  .screen {
    min-height: 100vh;
    padding: 28px 32px 48px;
  }
  h1 {
    font-size: clamp(36px, 6vw, 72px);
  }
  .layout {
    display: grid;
    grid-template-columns: 280px 1fr;
    gap: 28px;
    align-items: start;
  }
  .qr {
    width: 280px;
    height: 280px;
    background: white;
    border-radius: 24px;
    padding: 12px;
  }
  @media (max-width: 800px) {
    .layout {
      grid-template-columns: 1fr;
    }
  }
</style>

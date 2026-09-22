<script lang="ts">
  import Admin from "./pages/Admin.svelte";
  import Join from "./pages/Join.svelte";
  import Screen from "./pages/Screen.svelte";

  const path = location.pathname.replace(/\/+$/, "") || "/";
</script>

{#if path === "/admin"}
  <Admin />
{:else if path === "/screen" || path === "/s"}
  <Screen />
{:else}
  <Join />
{/if}

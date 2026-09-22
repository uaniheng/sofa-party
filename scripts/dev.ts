const web = Bun.spawn({
  cmd: ["bun", "run", "--cwd", "apps/web", "dev"],
  stdout: "inherit",
  stderr: "inherit",
  env: { ...process.env },
});

const host = Bun.spawn({
  cmd: ["bun", "run", "--cwd", "apps/host", "dev"],
  stdout: "inherit",
  stderr: "inherit",
  env: { ...process.env, VITE_DEV_URL: "http://127.0.0.1:5173" },
});

function stop() {
  web.kill();
  host.kill();
  process.exit(0);
}

process.on("SIGINT", stop);
process.on("SIGTERM", stop);

await Promise.all([web.exited, host.exited]);

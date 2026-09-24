import { Hono } from "hono";
import { serveStatic, websocket } from "hono/bun";
import { logger } from "hono/logger";
import { registerApi, registerCertRoutes } from "./api";
import { defaultHttpsPort } from "./certs";
import { HostApp } from "./host";
import { registerWs } from "./ws";

const portArg = process.argv.find((a) => a.startsWith("--port="));
const port = Number(portArg?.split("=")[1] ?? process.env.PORT ?? 8080);
const httpsPort = defaultHttpsPort(port, process.env.HTTPS_PORT);
const viteUrl = process.env.VITE_DEV_URL;
const host = new HostApp(port, httpsPort);
const app = new Hono();

app.use(logger());
app.onError((err, c) => {
  if (err instanceof SyntaxError) {
    return c.json({ error: "bad_json", message: "请求不是 JSON" }, 400);
  }
  console.error(err);
  return c.json({ error: "internal", message: "主机出错了" }, 500);
});
registerApi(app, host);
registerCertRoutes(app, host);
registerWs(app, host);

app.get("/sdk/game.js", async (c) => {
  try {
    const js = await host.sdkJavascript();
    return c.body(js, 200, {
      "Content-Type": "application/javascript; charset=utf-8",
      "Cache-Control": "no-cache",
    });
  } catch (err) {
    return c.text(String(err), 500);
  }
});

app.use("/games/*", async (c, next) => {
  const path = c.req.path.replace(/\\/g, "/");
  if (path.endsWith("/server.js") || path.endsWith("server.js")) {
    return c.notFound();
  }
  return serveStatic({ root: host.paths.workdir })(c, next);
});

async function proxyVite(c: { req: { url: string; method: string; raw: Request } }) {
  const url = new URL(c.req.url);
  const target = `${viteUrl}${url.pathname}${url.search}`;
  try {
    const res = await fetch(target, {
      method: c.req.method,
      headers: c.req.raw.headers,
      redirect: "manual",
    });
    const headers = new Headers(res.headers);
    headers.delete("content-encoding");
    headers.delete("transfer-encoding");
    return new Response(res.body, { status: res.status, headers });
  } catch {
    return new Response("外壳开发服务未启动。请先运行 bun run dev", { status: 502 });
  }
}

function isShellPath(pathname: string) {
  return pathname === "/" || pathname === "/s" || pathname === "/screen" || pathname === "/admin";
}

app.get("/s", serveShell);

async function serveShell(c: any) {
  if (viteUrl) return proxyVite(c);
  const html = host.shellIndex();
  if (!html) return c.text("还没有构建外壳，请先 bun run build 或 bun run dev", 500);
  return c.html(html);
}

app.get("/", serveShell);
app.get("/screen", serveShell);
app.get("/admin", serveShell);

if (viteUrl) {
  app.all("/src/*", (c) => proxyVite(c));
  app.all("/@vite/*", (c) => proxyVite(c));
  app.all("/@fs/*", (c) => proxyVite(c));
  app.all("/node_modules/*", (c) => proxyVite(c));
  app.all("/@id/*", (c) => proxyVite(c));
} else {
  app.use("/assets/*", serveStatic({ root: host.paths.publicDir }));
}

app.notFound(async (c) => {
  const path = new URL(c.req.url).pathname;
  if (isShellPath(path)) return serveShell(c);
  if (viteUrl && !path.startsWith("/api") && !path.startsWith("/ws") && !path.startsWith("/games")) {
    return proxyVite(c);
  }
  return c.text("Not Found", 404);
});

let httpsServer: ReturnType<typeof Bun.serve> | null = null;

function startHttps() {
  const tls = host.certs.tls();
  if (!tls) {
    host.certs.noteHttps(null);
    return;
  }
  try {
    httpsServer = Bun.serve({
      port: host.certs.httpsPort,
      hostname: "0.0.0.0",
      fetch: app.fetch,
      websocket,
      tls,
    });
    host.certs.noteHttps(null);
  } catch (err) {
    httpsServer = null;
    const message = err instanceof Error ? err.message : String(err);
    host.certs.noteHttps(`https 端口 ${host.certs.httpsPort} 没能打开：${message}`);
    console.error(host.certs.httpsError);
  }
}

host.certs.onServerCertChange = () => {
  const prev = httpsServer;
  httpsServer = null;
  prev?.stop(true);
  startHttps();
};

startHttps();

const server = Bun.serve({
  port,
  hostname: "0.0.0.0",
  fetch: app.fetch,
  websocket,
});

const meta = host.meta();
console.log("");
console.log("沙发派对已启动");
console.log(`加入（手机）： ${meta.joinUrl}`);
console.log(`大屏（电视手输）： ${meta.screenUrl}`);
console.log(`管理（本机）： http://127.0.0.1:${port}/admin`);
if (meta.cert.issued && meta.cert.httpsJoinUrl) console.log(`体感加入： ${meta.cert.httpsJoinUrl}`);
if (meta.lanAddresses.length > 1) {
  console.log(`本机网卡： ${meta.lanAddresses.join(", ")}`);
}
console.log("");

export { app, host, server };

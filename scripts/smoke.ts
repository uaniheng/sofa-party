const base = "http://127.0.0.1:8080";

async function api(path: string, init: RequestInit = {}) {
  const res = await fetch(base + path, init);
  const text = await res.text();
  let data: any = text;
  try {
    data = JSON.parse(text);
  } catch {
    /* keep text */
  }
  return { status: res.status, data };
}

function waitWs(role: "display" | "player", token?: string) {
  return new Promise<{ ws: WebSocket; messages: any[] }>((resolve, reject) => {
    const ws = new WebSocket("ws://127.0.0.1:8080/ws");
    const messages: any[] = [];
    const timer = setTimeout(() => reject(new Error("ws timeout " + role)), 5000);
    ws.addEventListener("open", () => {
      ws.send(JSON.stringify(role === "display" ? { type: "hello", role } : { type: "hello", role, token }));
    });
    ws.addEventListener("message", (ev) => {
      const msg = JSON.parse(String(ev.data));
      messages.push(msg);
      if (msg.type === "party.state") {
        clearTimeout(timer);
        resolve({ ws, messages });
      }
      if (msg.type === "hello.err") {
        clearTimeout(timer);
        reject(new Error(msg.message));
      }
    });
  });
}

async function ensurePlayer(name: string) {
  const list = await api("/api/players");
  const existing = (list.data as any[]).find((p) => p.name === name);
  if (existing) {
    const claimed = await api("/api/players/claim", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ playerId: existing.id }),
    });
    return { ...existing, token: claimed.data.token };
  }
  const created = await api("/api/players", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name }),
  });
  if (created.status !== 200) throw new Error("create " + name + " failed " + JSON.stringify(created.data));
  return created.data;
}

const dup = await api("/api/players", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ name: "小明" }),
});
if (dup.status !== 409 && dup.status !== 200) {
  throw new Error("create 小明 unexpected " + dup.status + " " + JSON.stringify(dup.data));
}

const ming = await ensurePlayer("小明");
const hong = await ensurePlayer("小红");

const quiz = await fetch(base + "/games/quiz-party/player/index.html");
if (quiz.status !== 200) throw new Error("quiz html missing");

const display1 = await waitWs("display");
const player1 = await waitWs("player", ming.token);
const player2 = await waitWs("player", hong.token);

player1.ws.send(JSON.stringify({ type: "party.start", gameId: "quiz-party" }));
await Bun.sleep(200);
const started = player1.messages.find((m) => m.type === "party.start");
if (!started) throw new Error("did not start: " + JSON.stringify(player1.messages.slice(-3)));
if (started.view !== "game-player") throw new Error("player view " + started.view);
const dstart = display1.messages.find((m) => m.type === "party.start");
if (dstart.view !== "lobby") throw new Error("display should stay lobby in personal mode");

player1.ws.send(JSON.stringify({ type: "log", level: "error", message: "测试报错", data: { n: 1 } }));
await Bun.sleep(150);
if (player2.messages.some((m) => m.type === "log")) throw new Error("log must not be forwarded");
const logs = await api("/api/logs");
if (logs.status !== 200) throw new Error("logs api " + logs.status);
const found = (logs.data.entries as any[]).find((e) => e.message === "测试报错");
if (!found || found.level !== "error" || found.playerName !== "小明") {
  throw new Error("log not on admin api " + JSON.stringify(logs.data));
}
if (!((logs.data.entries as any[]).some((e) => String(e.message).includes("开始")))) {
  throw new Error("host start log missing");
}

const save = await api("/api/saves/quiz-party", {
  method: "PUT",
  headers: { "Content-Type": "application/json", Authorization: "Bearer " + ming.token },
  body: JSON.stringify({ scope: "shared", key: "lastWinner", value: "小明" }),
});
if (save.status !== 200) throw new Error("save failed " + JSON.stringify(save.data));

const got = await api("/api/saves/quiz-party?scope=shared&key=lastWinner", {
  headers: { Authorization: "Bearer " + ming.token },
});
if (got.data.value !== "小明") throw new Error("save roundtrip failed");

player1.ws.send(JSON.stringify({ type: "game", to: { playerId: hong.id }, payload: { hi: 1 } }));
await Bun.sleep(150);
if (!player2.messages.some((m) => m.type === "game" && m.payload?.hi === 1)) {
  throw new Error("game message not forwarded");
}

const steal = await api("/api/players/claim", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ playerId: ming.id }),
});
if (steal.status !== 409) throw new Error("occupied name should be 409, got " + steal.status);

const display2 = await waitWs("display");
await Bun.sleep(100);
if (display1.messages.some((m) => m.type === "display.replaced")) throw new Error("second display should stay alongside the first");
if (!display2.messages.some((m) => m.type === "hello.ok")) throw new Error("second display did not connect");

const p1b = await waitWs("player", ming.token);
await Bun.sleep(100);
if (!player1.messages.some((m) => m.type === "player.replaced")) throw new Error("old player not replaced");
if (player1.messages.some((m) => m.type === "player.kicked")) throw new Error("same-token reconnect should not kick");

p1b.ws.send(JSON.stringify({ type: "party.end" }));
await Bun.sleep(150);
if (!player2.messages.some((m) => m.type === "party.end")) throw new Error("party end not broadcast");

display2.ws.close();
p1b.ws.close();
player2.ws.close();

console.log("smoke ok");

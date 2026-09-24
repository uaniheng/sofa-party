import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, platform } from "node:os";
import { join } from "node:path";
import type { CertStatus, LocalTrust } from "@family/protocol";
import forge from "node-forge";

const CA_NAME = "Sofa Party";
const SERVER_DAYS = 800;
const CA_YEARS = 10;

export function defaultHttpsPort(httpPort: number, envValue?: string): number {
  const fallback = httpPort === 8443 ? 8444 : 8443;
  const safeFallback = fallback === httpPort ? httpPort + 1 : fallback;
  if (!envValue) return safeFallback;
  const parsed = Number(envValue);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535 || parsed === httpPort) return safeFallback;
  return parsed;
}

export function certNames(ips: string[]): string[] {
  const set = new Set<string>(["127.0.0.1"]);
  for (const ip of ips) {
    if (/^(?:\d{1,3}\.){3}\d{1,3}$/.test(ip)) set.add(ip);
  }
  return [...set].sort();
}

export function explainInstallError(err: unknown): string {
  const text = err instanceof Error ? err.message : String(err);
  if (/ENOENT|not found|不是内部或外部命令/i.test(text)) {
    return "这台电脑缺少安装证书的系统工具。手机仍可以扫码安装。";
  }
  return "没能装到这台电脑。手机仍可以扫码安装。";
}

export function certDownloadTarget(ua: string): { href: string; label: string } {
  if (/iPhone|iPad|iPod/i.test(ua)) return { href: "/cert/ca.mobileconfig", label: "下载描述文件" };
  return { href: "/cert/ca.crt", label: "下载证书" };
}

type PemPair = { certPem: string; keyPem: string };

export class LocalCerts {
  readonly dir: string;
  readonly httpsPort: number;
  issued = false;
  localTrust: LocalTrust = "unknown";
  localTrustMessage = "还没有证书。在管理页点「生成证书」之后，才会出现手机下载码。";
  httpsError: string | null = null;
  onServerCertChange: (() => void) | null = null;

  private readonly caCrt: string;
  private readonly caKey: string;
  private readonly serverCrt: string;
  private readonly serverKey: string;
  private readonly sansPath: string;
  private namesKey = "";
  private installTask: Promise<void> | null = null;

  constructor(dir: string, httpsPort: number) {
    this.dir = dir;
    this.httpsPort = httpsPort;
    this.caCrt = join(dir, "ca.crt");
    this.caKey = join(dir, "ca.key");
    this.serverCrt = join(dir, "server.crt");
    this.serverKey = join(dir, "server.key");
    this.sansPath = join(dir, "sans.json");
  }

  /** 启动时只查看已经生成过的文件，不新建。 */
  rememberExisting() {
    if (!existsSync(this.caCrt) || !existsSync(this.serverCrt) || !existsSync(this.serverKey) || !existsSync(this.sansPath)) {
      return;
    }
    try {
      forge.pki.certificateFromPem(readFileSync(this.caCrt, "utf8"));
      forge.pki.privateKeyFromPem(readFileSync(this.caKey, "utf8"));
      const saved = JSON.parse(readFileSync(this.sansPath, "utf8")) as { names?: string[] };
      this.namesKey = (saved.names ?? []).join(",");
      this.issued = true;
      this.localTrustMessage = "证书是之前在管理页生成的。要让这台电脑信任它，点「安装到这台电脑」。";
    } catch {
      this.issued = false;
    }
  }

  noteHttps(error: string | null) {
    this.httpsError = error;
  }

  /** 管理页点了才签发。根证书已有就沿用，只按当前地址重签服务器证书。 */
  issue(ips: string[]) {
    mkdirSync(this.dir, { recursive: true });
    const createdCa = this.ensureCa();
    const names = certNames(ips);
    const key = names.join(",");
    const sameServer = !createdCa && this.namesMatch(key);
    if (!sameServer) this.writeServer(names);
    this.namesKey = key;
    const first = !this.issued;
    this.issued = true;
    if (first && this.localTrust === "unknown") {
      this.localTrustMessage = "证书已生成。要让这台电脑打开 https 不报警，点「安装到这台电脑」。";
    }
    if (first || !sameServer) this.onServerCertChange?.();
  }

  tls(): { cert: string; key: string } | null {
    if (!existsSync(this.serverCrt) || !existsSync(this.serverKey) || !existsSync(this.caCrt)) return null;
    const cert = `${readFileSync(this.serverCrt, "utf8")}\n${readFileSync(this.caCrt, "utf8")}`;
    const key = readFileSync(this.serverKey, "utf8");
    return { cert, key };
  }

  status(address: string | null, httpPort: number, ips: string[]): CertStatus {
    const host = address ?? "127.0.0.1";
    const coversAddress = this.issued && this.namesMatch(certNames(ips).join(","));
    return {
      issued: this.issued,
      coversAddress,
      downloadUrl: `http://${host}:${httpPort}/cert`,
      httpsJoinUrl: this.issued && !this.httpsError ? `https://${host}:${this.httpsPort}/` : null,
      httpsPort: this.httpsPort,
      httpsError: this.httpsError,
      localTrust: this.localTrust,
      localTrustMessage: this.localTrustMessage,
    };
  }

  caPem(): string | null {
    if (!existsSync(this.caCrt)) return null;
    return readFileSync(this.caCrt, "utf8");
  }

  mobileconfig(): string | null {
    const pem = this.caPem();
    if (!pem) return null;
    return buildMobileconfig(pem);
  }

  page(input: { ua: string; httpsJoinUrl: string | null }): string {
    const target = certDownloadTarget(input.ua);
    const other =
      target.href.endsWith(".mobileconfig")
        ? { href: "/cert/ca.crt", label: "安卓请下载证书文件" }
        : { href: "/cert/ca.mobileconfig", label: "iPhone 请下载描述文件" };
    const next = input.httpsJoinUrl
      ? `<p>装好并信任之后，打开 <a href="${escapeHtml(input.httpsJoinUrl)}">${escapeHtml(input.httpsJoinUrl)}</a></p>`
      : "";
    return `<!doctype html>
<html lang="zh-CN">
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>信任沙发派对</title>
<style>
  body { margin: 0; font-family: "PingFang SC", "Microsoft YaHei", system-ui, sans-serif; background: #12141c; color: #f4f1ea; }
  main { max-width: 560px; margin: 0 auto; padding: 28px 20px 48px; }
  h1 { font-size: 28px; margin: 0 0 8px; }
  h2 { font-size: 18px; margin: 28px 0 8px; }
  p, li { line-height: 1.55; color: #d5dbe8; }
  a { color: #f0c75e; }
  .btn { display: block; text-align: center; text-decoration: none; background: #f0c75e; color: #1a1408; font-weight: 800; border-radius: 14px; padding: 16px; margin: 18px 0 8px; }
  .alt { font-size: 14px; }
  ol { padding-left: 1.2em; }
</style>
<main>
  <h1>信任这台电脑</h1>
  <p>手机浏览器只有在 https 下才给体感。先安装这张证书，再从管理页的 https 加入码进来。</p>
  <p>只装在自己家里的手机上。系统会提示「未签名」或「可能查看加密流量」，这是自家主机签发的，继续安装即可。</p>
  <a class="btn" href="${target.href}">${escapeHtml(target.label)}</a>
  <p class="alt"><a href="${other.href}">${escapeHtml(other.label)}</a></p>
  <h2>iPhone</h2>
  <ol>
    <li>点上面的按钮，允许下载描述文件。</li>
    <li>打开「设置」，点顶部「已下载描述文件」，安装 Sofa Party。</li>
    <li>再到「设置 → 通用 → 关于本机 → 证书信任设置」，打开 Sofa Party 的完全信任。不打开这一步，体感仍然没有。</li>
  </ol>
  <h2>安卓</h2>
  <ol>
    <li>点上面的按钮，按提示把证书装成 CA 证书。</li>
    <li>如果只是下到了文件：设置 → 安全 → 加密与凭据 → 安装证书 → CA 证书。</li>
    <li>用系统自带的 Chrome 打开游戏。微信里的网页读不到体感。</li>
  </ol>
  ${next}
</main>
</html>`;
  }

  installLocal(): Promise<void> {
    if (this.installTask) return this.installTask;
    this.installTask = this.installLocalOnce().finally(() => {
      this.installTask = null;
    });
    return this.installTask;
  }

  private ensureCa(): boolean {
    if (existsSync(this.caCrt) && existsSync(this.caKey)) {
      try {
        forge.pki.certificateFromPem(readFileSync(this.caCrt, "utf8"));
        forge.pki.privateKeyFromPem(readFileSync(this.caKey, "utf8"));
        return false;
      } catch {
        /* 文件坏了，下面重签 */
      }
    }
    const made = createCa();
    writeFileSync(this.caCrt, made.certPem);
    writeFileSync(this.caKey, made.keyPem, { mode: 0o600 });
    return true;
  }

  private namesMatch(key: string): boolean {
    if (!existsSync(this.serverCrt) || !existsSync(this.serverKey) || !existsSync(this.sansPath)) return false;
    try {
      const saved = JSON.parse(readFileSync(this.sansPath, "utf8")) as { names?: string[] };
      return (saved.names ?? []).join(",") === key;
    } catch {
      return false;
    }
  }

  private writeServer(names: string[]) {
    const caCert = forge.pki.certificateFromPem(readFileSync(this.caCrt, "utf8"));
    const caKey = forge.pki.privateKeyFromPem(readFileSync(this.caKey, "utf8"));
    const made = createServerCert(caCert, caKey, names);
    writeFileSync(this.serverCrt, made.certPem);
    writeFileSync(this.serverKey, made.keyPem, { mode: 0o600 });
    writeFileSync(this.sansPath, JSON.stringify({ names }));
  }

  private markTrusted() {
    this.localTrust = "trusted";
    this.localTrustMessage = "这台电脑已经信任证书，浏览器打开 https 不会再报警。";
  }

  private async installLocalOnce(): Promise<void> {
    const pem = this.caPem();
    if (!pem) {
      this.localTrust = "failed";
      this.localTrustMessage = "证书还没生成，手机暂时无法下载。";
      return;
    }
    const thumb = thumbprint(pem);
    this.localTrust = "pending";
    this.localTrustMessage = "正在检查这台电脑是否已经信任证书";
    try {
      if (await storeHas(thumb)) {
        this.markTrusted();
        return;
      }
      this.localTrustMessage = "如果电脑弹出安装证书的确认，请点「是」。";
      await storeAdd(this.caCrt);
      if (await storeHas(thumb)) {
        this.markTrusted();
        return;
      }
      this.localTrust = "failed";
      this.localTrustMessage = "这台电脑没有信任这张证书。如果刚才点了「否」，可以再试一次。";
    } catch (err) {
      console.error("本机证书没装上：", err);
      this.localTrust = "failed";
      this.localTrustMessage = explainInstallError(err);
    }
  }
}

export function thumbprint(certPem: string): string {
  const cert = forge.pki.certificateFromPem(certPem);
  const der = forge.asn1.toDer(forge.pki.certificateToAsn1(cert)).getBytes();
  return createHash("sha1").update(Buffer.from(der, "binary")).digest("hex").toUpperCase();
}

export function buildMobileconfig(certPem: string): string {
  const cert = forge.pki.certificateFromPem(certPem);
  const der = forge.asn1.toDer(forge.pki.certificateToAsn1(cert)).getBytes();
  const b64 = Buffer.from(der, "binary").toString("base64").replace(/(.{64})/g, "$1\n");
  const thumb = thumbprint(certPem);
  const profileId = uuidFrom(`${thumb}:profile`);
  const certId = uuidFrom(`${thumb}:cert`);
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>PayloadContent</key>
  <array>
    <dict>
      <key>PayloadCertificateFileName</key>
      <string>sofa-party.crt</string>
      <key>PayloadContent</key>
      <data>${b64}</data>
      <key>PayloadDescription</key>
      <string>信任家里的沙发派对主机</string>
      <key>PayloadDisplayName</key>
      <string>${CA_NAME}</string>
      <key>PayloadIdentifier</key>
      <string>party.sofa.ca.cert</string>
      <key>PayloadType</key>
      <string>com.apple.security.root</string>
      <key>PayloadUUID</key>
      <string>${certId}</string>
      <key>PayloadVersion</key>
      <integer>1</integer>
    </dict>
  </array>
  <key>PayloadDisplayName</key>
  <string>沙发派对</string>
  <key>PayloadDescription</key>
  <string>信任家里这台游戏主机，手机才能使用体感。</string>
  <key>PayloadIdentifier</key>
  <string>party.sofa.ca.profile</string>
  <key>PayloadType</key>
  <string>Configuration</string>
  <key>PayloadUUID</key>
  <string>${profileId}</string>
  <key>PayloadVersion</key>
  <integer>1</integer>
</dict>
</plist>
`;
}

function createCa(): PemPair {
  const keys = forge.pki.rsa.generateKeyPair(2048);
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = serialHex();
  const notBefore = new Date(Date.now() - 5 * 60 * 1000);
  const notAfter = new Date(notBefore);
  notAfter.setFullYear(notAfter.getFullYear() + CA_YEARS);
  cert.validity.notBefore = notBefore;
  cert.validity.notAfter = notAfter;
  const attrs = [
    { name: "commonName", value: CA_NAME },
    { name: "organizationName", value: CA_NAME },
  ];
  cert.setSubject(attrs);
  cert.setIssuer(attrs);
  cert.setExtensions([
    { name: "basicConstraints", cA: true, critical: true },
    { name: "keyUsage", keyCertSign: true, cRLSign: true, critical: true },
  ]);
  cert.sign(keys.privateKey, forge.md.sha256.create());
  return {
    certPem: forge.pki.certificateToPem(cert),
    keyPem: forge.pki.privateKeyToPem(keys.privateKey),
  };
}

function createServerCert(caCert: forge.pki.Certificate, caKey: forge.pki.rsa.PrivateKey, ips: string[]): PemPair {
  const keys = forge.pki.rsa.generateKeyPair(2048);
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = serialHex();
  const notBefore = new Date(Date.now() - 5 * 60 * 1000);
  const notAfter = new Date(notBefore);
  notAfter.setDate(notAfter.getDate() + SERVER_DAYS);
  cert.validity.notBefore = notBefore;
  cert.validity.notAfter = notAfter;
  cert.setSubject([{ name: "commonName", value: CA_NAME }]);
  cert.setIssuer(caCert.subject.attributes);
  const altNames: { type: number; value?: string; ip?: string }[] = [{ type: 2, value: "localhost" }];
  for (const ip of ips) altNames.push({ type: 7, ip });
  cert.setExtensions([
    { name: "basicConstraints", cA: false },
    { name: "keyUsage", digitalSignature: true, keyEncipherment: true, critical: true },
    { name: "extKeyUsage", serverAuth: true },
    { name: "subjectAltName", altNames },
  ]);
  cert.sign(caKey, forge.md.sha256.create());
  return {
    certPem: forge.pki.certificateToPem(cert),
    keyPem: forge.pki.privateKeyToPem(keys.privateKey),
  };
}

function serialHex(): string {
  const bytes = randomBytes(16);
  bytes[0] = (bytes[0]! & 0x7f) | 0x01;
  return bytes.toString("hex");
}

function uuidFrom(seed: string): string {
  const hex = createHash("sha256").update(seed).digest("hex").slice(0, 32);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (ch) => {
    if (ch === "&") return "&amp;";
    if (ch === "<") return "&lt;";
    if (ch === ">") return "&gt;";
    if (ch === '"') return "&quot;";
    return "&#39;";
  });
}

async function runCommand(cmd: string[], timeoutMs: number): Promise<{ code: number; out: string }> {
  const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" });
  const timer = setTimeout(() => {
    try {
      proc.kill();
    } catch {
      /* 已经结束 */
    }
  }, timeoutMs);
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  clearTimeout(timer);
  return { code, out: `${stdout}\n${stderr}` };
}

async function storeHas(thumb: string): Promise<boolean> {
  const os = platform();
  if (os === "win32") {
    const { code, out } = await runCommand(["certutil", "-user", "-store", "Root", thumb], 20_000);
    return code === 0 && out.toUpperCase().includes(thumb.toUpperCase());
  }
  if (os === "darwin") {
    const keychain = macKeychain();
    const { code, out } = await runCommand(
      ["security", "find-certificate", "-a", "-Z", "-c", CA_NAME, keychain],
      20_000,
    );
    return code === 0 && out.replace(/[:\s]/g, "").toLowerCase().includes(thumb.toLowerCase());
  }
  const db = nssDb();
  if (!existsSync(join(db, "cert9.db")) && !existsSync(join(db, "cert8.db"))) return false;
  const { code } = await runCommand(["certutil", "-d", `sql:${db}`, "-L", "-n", CA_NAME], 20_000);
  return code === 0;
}

async function storeAdd(caPath: string): Promise<void> {
  const os = platform();
  if (os === "win32") {
    await runCommand(["certutil", "-user", "-addstore", "Root", caPath], 180_000);
    return;
  }
  if (os === "darwin") {
    await runCommand(
      ["security", "add-trusted-cert", "-r", "trustRoot", "-k", macKeychain(), caPath],
      180_000,
    );
    return;
  }
  const db = nssDb();
  mkdirSync(db, { recursive: true });
  if (!existsSync(join(db, "cert9.db"))) {
    await runCommand(["certutil", "-d", `sql:${db}`, "-N", "--empty-password"], 20_000);
  }
  await runCommand(["certutil", "-d", `sql:${db}`, "-A", "-t", "C,,", "-n", CA_NAME, "-i", caPath], 20_000);
}

function macKeychain(): string {
  const modern = join(homedir(), "Library", "Keychains", "login.keychain-db");
  if (existsSync(modern)) return modern;
  return join(homedir(), "Library", "Keychains", "login.keychain");
}

function nssDb(): string {
  return join(homedir(), ".pki", "nssdb");
}

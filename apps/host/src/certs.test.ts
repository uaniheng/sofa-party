import { describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import forge from "node-forge";
import {
  LocalCerts,
  buildMobileconfig,
  certDownloadTarget,
  certNames,
  defaultHttpsPort,
  explainInstallError,
  thumbprint,
} from "./certs";

describe("https port", () => {
  test("uses 8443 unless it clashes with the http port", () => {
    expect(defaultHttpsPort(8080)).toBe(8443);
    expect(defaultHttpsPort(8443)).toBe(8444);
    expect(defaultHttpsPort(8080, "9443")).toBe(9443);
    expect(defaultHttpsPort(8080, "8080")).toBe(8443);
    expect(defaultHttpsPort(8080, "nope")).toBe(8443);
  });
});

describe("cert names", () => {
  test("keeps localhost and the lan addresses", () => {
    expect(certNames(["192.168.1.8", "10.0.0.2", "not-an-ip"])).toEqual(["10.0.0.2", "127.0.0.1", "192.168.1.8"]);
  });

  test("picks a download file from the phone", () => {
    expect(certDownloadTarget("Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)")).toEqual({
      href: "/cert/ca.mobileconfig",
      label: "下载描述文件",
    });
    expect(certDownloadTarget("Mozilla/5.0 (Linux; Android 14)")).toEqual({
      href: "/cert/ca.crt",
      label: "下载证书",
    });
  });

  test("explains a missing system tool", () => {
    expect(explainInstallError(new Error("spawn certutil ENOENT"))).toContain("系统工具");
    expect(explainInstallError(new Error("access denied"))).toContain("手机仍可以扫码安装");
  });
});

describe("local certificates", () => {
  const dir = join(import.meta.dir, "..", "..", "..", "data", "tmp-certs-test");

  test("signs a server cert for the lan address and keeps the same root", () => {
    rmSync(dir, { recursive: true, force: true });
    const certs = new LocalCerts(dir, 8443);
    expect(certs.tls()).toBeNull();
    expect(certs.status("192.168.1.8", 8080, ["192.168.1.8"]).issued).toBe(false);
    certs.issue(["192.168.1.8"]);
    expect(certs.status("192.168.1.8", 8080, ["192.168.1.8"]).coversAddress).toBe(true);
    const caPem = certs.caPem();
    expect(caPem).toContain("BEGIN CERTIFICATE");
    expect(caPem).not.toContain("PRIVATE KEY");

    const ca = forge.pki.certificateFromPem(caPem!);
    const caBits = ca.getExtension("basicConstraints") as { cA?: boolean };
    expect(caBits.cA).toBe(true);

    const server = forge.pki.certificateFromPem(certs.tls()!.cert);
    const san = server.getExtension("subjectAltName") as { altNames: { type: number; ip?: string; value?: string }[] };
    const ips = san.altNames.filter((item) => item.type === 7).map((item) => item.ip);
    expect(ips).toContain("192.168.1.8");
    expect(ips).toContain("127.0.0.1");
    expect(san.altNames.some((item) => item.type === 2 && item.value === "localhost")).toBe(true);
    expect(forge.pki.verifyCertificateChain(forge.pki.createCaStore([ca]), [server])).toBe(true);

    const profile = buildMobileconfig(caPem!);
    expect(profile).toContain("com.apple.security.root");
    expect(profile).not.toContain("PRIVATE KEY");
    expect(thumbprint(caPem!)).toMatch(/^[0-9A-F]{40}$/);

    const before = certs.tls()!.cert;
    certs.issue(["192.168.1.8"]);
    expect(certs.tls()!.cert).toBe(before);
    expect(certs.caPem()).toBe(caPem);

    certs.issue(["192.168.1.9"]);
    const next = forge.pki.certificateFromPem(certs.tls()!.cert);
    const nextSan = next.getExtension("subjectAltName") as { altNames: { type: number; ip?: string }[] };
    expect(nextSan.altNames.map((item) => item.ip)).toContain("192.168.1.9");
    expect(certs.caPem()).toBe(caPem);

    const page = certs.page({ ua: "iPhone", httpsJoinUrl: "https://192.168.1.8:8443/" });
    expect(page).toContain("/cert/ca.mobileconfig");
    expect(page).toContain("https://192.168.1.8:8443/");
    expect(certs.status("192.168.1.8", 8080, ["192.168.1.9"]).downloadUrl).toBe("http://192.168.1.8:8080/cert");
    const restored = new LocalCerts(dir, 8443);
    expect(restored.issued).toBe(false);
    restored.rememberExisting();
    expect(restored.issued).toBe(true);
    expect(restored.status("192.168.1.9", 8080, ["192.168.1.9"]).coversAddress).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  }, 30_000);
});

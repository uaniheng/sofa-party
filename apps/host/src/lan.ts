import { networkInterfaces } from "node:os";

export function listLanAddresses(): string[] {
  const found = new Set<string>();
  const nets = networkInterfaces();
  for (const list of Object.values(nets)) {
    if (!list) continue;
    for (const item of list) {
      if (item.internal) continue;
      if (item.family !== "IPv4" && item.family !== 4) continue;
      if (item.address.startsWith("169.254.")) continue;
      found.add(item.address);
    }
  }
  return [...found].sort((a, b) => scoreAddress(b) - scoreAddress(a));
}

export function scoreAddress(ip: string): number {
  if (ip.startsWith("192.168.")) return 3;
  if (ip.startsWith("10.")) return 2;
  if (/^172\.(1[6-9]|2\d|3[0-1])\./.test(ip)) return 1;
  return 0;
}

export function pickDefaultAddress(addresses: string[], preferred?: string | null): string | null {
  if (preferred && addresses.includes(preferred)) return preferred;
  return addresses[0] ?? null;
}

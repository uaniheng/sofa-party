import { STORAGE_TOKEN } from "@family/protocol";

export class ApiError extends Error {
  error: string;
  constructor(error: string, message: string) {
    super(message);
    this.error = error;
  }
}

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  const token = localStorage.getItem(STORAGE_TOKEN);
  if (token && !headers.has("Authorization")) headers.set("Authorization", `Bearer ${token}`);
  if (init.body && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
  const res = await fetch(path, { ...init, headers });
  if (!res.ok) {
    const data = (await res.json().catch(() => ({ error: "http", message: res.statusText }))) as {
      error?: string;
      message?: string;
    };
    throw new ApiError(data.error ?? "http", data.message ?? "请求失败");
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

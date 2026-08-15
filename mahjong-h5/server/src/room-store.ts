import { Redis } from "ioredis";
import { logInfo, logWarn } from "./logger.js";

const ROOM_STATE_KEY = "cmcc:mahjong:rooms:v1";

export class RoomStore {
  readonly enabled: boolean;
  private readonly client?: Redis;
  private lastErrorAt = 0;

  constructor(redisUrl?: string) {
    this.enabled = Boolean(redisUrl);
    if (!redisUrl) return;
    this.client = new Redis(redisUrl, {
      lazyConnect: true,
      connectTimeout: 5_000,
      maxRetriesPerRequest: 2,
      enableOfflineQueue: false,
      retryStrategy: (times) => Math.min(500 * 2 ** Math.min(times, 5), 15_000),
    });
    this.client.on("error", (error: Error) => {
      const now = Date.now();
      if (now - this.lastErrorAt < 30_000) return;
      this.lastErrorAt = now;
      logWarn("redis_error", { message: error.message.slice(0, 160) });
    });
  }

  async connect(): Promise<void> {
    if (!this.client) return;
    await this.client.connect();
    logInfo("redis_connected", { key: ROOM_STATE_KEY });
  }

  async load(): Promise<string | null> {
    if (!this.client) return null;
    return this.client.get(ROOM_STATE_KEY);
  }

  async save(payload: string): Promise<void> {
    if (!this.client) return;
    await this.client.set(ROOM_STATE_KEY, payload);
  }

  async close(): Promise<void> {
    if (!this.client) return;
    await this.client.quit().catch(() => undefined);
  }
}

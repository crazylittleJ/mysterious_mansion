/**
 * 存檔層。
 * - Render free/starter 是 ephemeral filesystem 且閒置會 spin down，
 *   所以「完全關閉隔天回來」必須靠外部儲存。
 * - 預設 MemoryStore（本機開發用，進程死掉即消失）；
 *   設定 UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN 後自動改用 UpstashStore。
 * - TTL 24 小時：快照 updatedAt 起算，沒有任何進度（沒被重新 save）就會過期刪除。
 */

export interface GameSnapshot {
  version: number;
  roomCode: string;
  updatedAt: number;
  /** state.toJSON() 的公開狀態 */
  publicState: any;
  /** server 端機密：真實做局者、標記分配、牌堆順序、playerToken→座位 */
  secrets: {
    trueTraitorSeat: number;
    tokenBySeat: Record<number, number> | null;
    decks: { events: string[]; items: string[]; omens: string[] };
    seatByToken: Record<string, number>;
    secretVariant: boolean;
  };
}

export const SNAPSHOT_TTL_MS = 24 * 60 * 60 * 1000;
export const MAX_SAVED_GAMES = 3;

export interface Store {
  save(snapshot: GameSnapshot): Promise<void>;
  load(roomCode: string): Promise<GameSnapshot | null>;
  delete(roomCode: string): Promise<void>;
  /** 目前有效（未過期）的存檔數 */
  count(): Promise<number>;
}

export class MemoryStore implements Store {
  private map = new Map<string, GameSnapshot>();
  constructor(private ttlMs: number = SNAPSHOT_TTL_MS, private now: () => number = Date.now) {}

  private sweep() {
    const t = this.now();
    for (const [k, v] of this.map) {
      if (t - v.updatedAt > this.ttlMs) this.map.delete(k);
    }
  }

  async save(s: GameSnapshot) {
    this.map.set(s.roomCode, { ...s, updatedAt: this.now() });
  }
  async load(roomCode: string) {
    this.sweep();
    return this.map.get(roomCode) ?? null;
  }
  async delete(roomCode: string) {
    this.map.delete(roomCode);
  }
  async count() {
    this.sweep();
    return this.map.size;
  }
}

/** Upstash Redis（REST API，免長連線，適合 Render free tier）。TTL 交給 Redis EXPIRE。 */
export class UpstashStore implements Store {
  constructor(
    private url: string,
    private token: string,
    private ttlSec: number = SNAPSHOT_TTL_MS / 1000
  ) {}

  private async cmd(command: (string | number)[]): Promise<any> {
    const res = await fetch(this.url, {
      method: "POST",
      headers: { Authorization: `Bearer ${this.token}`, "Content-Type": "application/json" },
      body: JSON.stringify(command),
    });
    if (!res.ok) throw new Error(`upstash ${res.status}: ${await res.text()}`);
    const data = (await res.json()) as { result: any };
    return data.result;
  }

  private key(code: string) {
    return `gudong:save:${code}`;
  }

  async save(s: GameSnapshot) {
    const snap = { ...s, updatedAt: Date.now() };
    await this.cmd(["SET", this.key(s.roomCode), JSON.stringify(snap), "EX", this.ttlSec]);
  }
  async load(roomCode: string) {
    const raw = await this.cmd(["GET", this.key(roomCode)]);
    return raw ? (JSON.parse(raw) as GameSnapshot) : null;
  }
  async delete(roomCode: string) {
    await this.cmd(["DEL", this.key(roomCode)]);
  }
  async count() {
    // 房間代碼空間小（3 房上限），KEYS 可接受；規模化再換 SCAN
    const keys: string[] = await this.cmd(["KEYS", "gudong:save:*"]);
    return keys.length;
  }
}

let _store: Store | null = null;
export function getStore(): Store {
  if (_store) return _store;
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  _store = url && token ? new UpstashStore(url, token) : new MemoryStore();
  return _store;
}

/** 測試用 */
export function setStore(s: Store) {
  _store = s;
}

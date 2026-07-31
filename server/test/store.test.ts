import { describe, it, expect } from "vitest";
import { MemoryStore, GameSnapshot, MAX_SAVED_GAMES, SNAPSHOT_TTL_MS } from "../src/persistence/store";

const snap = (code: string): GameSnapshot => ({
  version: 1,
  roomCode: code,
  updatedAt: 0,
  publicState: {},
  secrets: { trueTraitorSeat: -1, tokenBySeat: null, decks: { events: [], items: [], omens: [] }, seatByName: {}, secretVariant: false },
});

describe("MemoryStore TTL", () => {
  it("keeps snapshots inside 24h and drops them after with no progress", async () => {
    let now = 1_000_000;
    const store = new MemoryStore(SNAPSHOT_TTL_MS, () => now);
    await store.save(snap("AAA"));

    now += SNAPSHOT_TTL_MS - 1;
    expect(await store.load("AAA")).not.toBeNull();

    now += 2; // 超過 24 小時
    expect(await store.load("AAA")).toBeNull();
    expect(await store.count()).toBe(0);
  });

  it("saving again resets the TTL clock (有進度就續命)", async () => {
    let now = 0;
    const store = new MemoryStore(SNAPSHOT_TTL_MS, () => now);
    await store.save(snap("BBB"));
    now += SNAPSHOT_TTL_MS - 1000;
    await store.save(snap("BBB")); // 有進度 → updatedAt 重置
    now += SNAPSHOT_TTL_MS - 1000;
    expect(await store.load("BBB")).not.toBeNull();
  });

  it("count reflects the 3-save limit basis", async () => {
    const store = new MemoryStore();
    await store.save(snap("A"));
    await store.save(snap("B"));
    await store.save(snap("C"));
    expect(await store.count()).toBe(MAX_SAVED_GAMES);
    await store.delete("B");
    expect(await store.count()).toBe(2);
  });
});

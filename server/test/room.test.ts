import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { boot, ColyseusTestServer } from "@colyseus/testing";
import { Server } from "colyseus";
import { BetrayalRoom } from "../src/rooms/BetrayalRoom";
import { MemoryStore, setStore, MAX_SAVED_GAMES } from "../src/persistence/store";
import { ClientIntent, ServerMsg, Phase } from "../src/events";

let colyseus: ColyseusTestServer;
let store: MemoryStore;

beforeAll(async () => {
  colyseus = await boot({
    initializeGameServer: (gameServer: Server) => {
      gameServer.define("gudong-betrayal", BetrayalRoom).filterBy(["roomCode"]);
    },
  });
});

afterAll(async () => {
  await colyseus.shutdown();
});

beforeEach(async () => {
  await colyseus.cleanup();
  store = new MemoryStore();
  setStore(store);
});

describe("BetrayalRoom", () => {
  it("seats players with stable seatIndex and starts the game", async () => {
    const room = await colyseus.createRoom("gudong-betrayal", { roomCode: "GAME1" });
    const c1 = await colyseus.connectTo(room, { roomCode: "GAME1", playerToken: "tok-1", name: "阿一" });
    const c2 = await colyseus.connectTo(room, { roomCode: "GAME1", playerToken: "tok-2", name: "阿二" });
    const c3 = await colyseus.connectTo(room, { roomCode: "GAME1", playerToken: "tok-3", name: "阿三" });

    await room.waitForNextPatch();
    expect(room.state.players.size).toBe(3);
    expect(room.state.players.get("0")!.name).toBe("阿一");
    expect(room.state.players.get("2")!.seatIndex).toBe(2);

    c1.send(ClientIntent.START_GAME);
    await room.waitForNextPatch();
    expect(room.state.phase).toBe(Phase.EXPLORATION);
    expect(room.state.tiles.size).toBe(3); // 三張起始板塊
    expect(room.state.turnSeat).toBe(0);
    void c2;
    void c3;
  });

  it("secret ritual: each client only receives its own token number; traitor identity stays out of schema", async () => {
    const room = await colyseus.createRoom("gudong-betrayal", { roomCode: "GAME2", secretVariant: true });
    const clients = [];
    const received: Record<number, number[]> = { 0: [], 1: [], 2: [] };
    for (let i = 0; i < 3; i++) {
      const c = await colyseus.connectTo(room, { roomCode: "GAME2", playerToken: `t${i}`, name: `P${i}` });
      c.onMessage(ServerMsg.YOUR_TOKEN, (m: any) => received[i].push(m.number));
      c.onMessage(ServerMsg.YOUR_OBJECTIVE, () => {});
      c.onMessage(ServerMsg.LOG, () => {});
      c.onMessage(ServerMsg.DICE, () => {});
      clients.push(c);
    }
    clients[0].send(ClientIntent.START_GAME);
    await room.waitForNextPatch();

    // 直接觸發揭盅（單元層已測預兆機率，這裡測流程與隱私）
    (room as any).startHaunt(1, "om-guijia");
    await room.waitForNextPatch();
    expect(room.state.phase).toBe(Phase.HAUNT_RITUAL);
    expect(room.state.revealedTraitorSeat).toBe(-1); // 身分不在公開 state

    for (const c of clients) c.send(ClientIntent.DRAW_TOKEN);
    await room.waitForNextPatch();
    await new Promise((r) => setTimeout(r, 50));

    // 每人恰好收到一枚、彼此不同、聯集為 {1,2,3}
    const all = [received[0], received[1], received[2]];
    all.forEach((arr) => expect(arr.length).toBe(1));
    expect(all.map((a) => a[0]).sort()).toEqual([1, 2, 3]);

    // 標記 1 的座位 === server 機密中的真實做局者
    const traitorIdx = all.findIndex((a) => a[0] === 1);
    expect((room as any).secrets.trueTraitorSeat).toBe(traitorIdx);

    for (const c of clients) c.send(ClientIntent.CONFIRM_TOKEN);
    await room.waitForNextPatch();
    expect(room.state.phase).toBe(Phase.HAUNT);
    // 秘密劇本：進入 HAUNT 後身分依然保密
    expect(room.state.revealedTraitorSeat).toBe(-1);
  });

  it("snapshot round-trip: a new room hydrates a saved game and the returning player keeps their seat", async () => {
    const room = await colyseus.createRoom("gudong-betrayal", { roomCode: "GAME3" });
    const c1 = await colyseus.connectTo(room, { roomCode: "GAME3", playerToken: "alpha", name: "掌櫃" });
    await colyseus.connectTo(room, { roomCode: "GAME3", playerToken: "beta", name: "夥計" });
    c1.send(ClientIntent.START_GAME);
    await room.waitForNextPatch();
    await new Promise((r) => setTimeout(r, 700)); // 等 debounced persist
    await (room as any).persist();

    const saved = await store.load("GAME3");
    expect(saved).not.toBeNull();
    expect(Object.keys(saved!.secrets.seatByName)).toContain("掌櫃");

    // 模擬 server 重啟：舊房解散、新房從快照重建
    await room.disconnect();
    const room2 = await colyseus.createRoom("gudong-betrayal", { roomCode: "GAME3" });
    await room2.waitForNextPatch().catch(() => {});
    expect(room2.state.phase).toBe(Phase.EXPLORATION);
    expect(room2.state.tiles.size).toBe(3);

    // 以「同名號」回房即回原座（不再靠 token）
    const back = await colyseus.connectTo(room2, { roomCode: "GAME3", name: "掌櫃" });
    await room2.waitForNextPatch();
    expect(room2.state.players.get("0")!.name).toBe("掌櫃");
    expect(room2.state.players.get("0")!.connected).toBe(true);
    void back;
  });

  it("rejects a duplicate name while the original is still connected", async () => {
    const room = await colyseus.createRoom("gudong-betrayal", { roomCode: "DUP1" });
    await colyseus.connectTo(room, { roomCode: "DUP1", name: "阿一" });
    await room.waitForNextPatch();
    // 同名、同房、原玩家仍在線 → 應被拒
    await expect(colyseus.connectTo(room, { roomCode: "DUP1", name: "阿一" })).rejects.toThrow();
  });

  it("purges the save when an abandoned LOBBY room is disposed", async () => {
    const room = await colyseus.createRoom("gudong-betrayal", { roomCode: "IDLE1" });
    await colyseus.connectTo(room, { roomCode: "IDLE1", name: "獨行客" });
    await room.waitForNextPatch();
    await (room as any).persist();
    expect(await store.load("IDLE1")).not.toBeNull();

    // 從沒開局的房間解散 → onDispose 應清檔（不佔用存檔名額）
    await room.disconnect();
    await new Promise((r) => setTimeout(r, 50));
    expect(await store.load("IDLE1")).toBeNull();
  });

  it("enforces the 3-save room limit", async () => {
    for (const code of ["L1", "L2", "L3"]) {
      const r = await colyseus.createRoom("gudong-betrayal", { roomCode: code });
      await r.waitForNextPatch().catch(() => {});
    }
    expect(await store.count()).toBe(MAX_SAVED_GAMES);
    await expect(colyseus.createRoom("gudong-betrayal", { roomCode: "L4" })).rejects.toThrow();
  });
});

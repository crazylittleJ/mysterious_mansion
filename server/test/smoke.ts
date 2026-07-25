/**
 * 實測腳本：對本機 server 打真實 WebSocket 完整跑一局（暗局模式）到 GAME_END。
 * 用法：
 *   GUDONG_DEBUG=1 npm run dev   （另一個終端）
 *   npx tsx test/smoke.ts
 */
import { Client, Room } from "colyseus.js";

const ENDPOINT = process.env.ENDPOINT || "ws://localhost:2567";
const CODE = "SMOKE" + Math.floor(Math.random() * 1000);

interface P {
  room: Room;
  seat: number;
  token: number;
  ended: boolean;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const snap = (r: Room) => (r.state as any).toJSON();

async function joinAs(name: string, playerToken: string): Promise<P> {
  const client = new Client(ENDPOINT);
  const room = await client.joinOrCreate("gudong-betrayal", {
    roomCode: CODE,
    playerToken,
    name,
    secretVariant: true,
  });
  const p: P = { room, seat: -1, token: -1, ended: false };
  room.onMessage("LOG", (m: any) => {
    console.log(`   [${name}]`, m.text);
    const match = new RegExp(`${name} 入座（座位 (\\d+)）`).exec(m.text || "");
    if (match) p.seat = Number(match[1]) - 1;
  });
  room.onMessage("DICE", (m: any) => console.log(`   🎲 ${m.kind}: [${m.dice}] = ${m.total}`));
  room.onMessage("YOUR_TOKEN", (m: any) => (p.token = m.number));
  room.onMessage("YOUR_OBJECTIVE", (m: any) => console.log(`   [${name}] 收到 ${m.camp} 勝利條件（${m.objective.length} 字）`));
  room.onMessage("GAME_END", (m: any) => {
    p.ended = true;
    console.log(`   [${name}] GAME_END:`, JSON.stringify(m));
  });
  room.onMessage("ERROR", (m: any) => console.log(`   [${name}] ⚠`, m.message));
  return p;
}

async function main() {
  console.log(`== 實測開始，房號 ${CODE} ==`);
  const a = await joinAs("掌櫃", "smoke-a");
  const b = await joinAs("夥計", "smoke-b");
  await sleep(300);
  if (a.seat !== 0 || b.seat !== 1) throw new Error(`座位異常 a=${a.seat} b=${b.seat}`);

  console.log("-- 開局");
  a.room.send("START_GAME");
  await sleep(300);
  if (snap(a.room).phase !== "EXPLORATION") throw new Error("開局失敗");

  console.log("-- 強制揭盅（暗局・水滴儀式）");
  a.room.send("DEBUG_FORCE_HAUNT");
  await sleep(300);
  if (snap(a.room).phase !== "HAUNT_RITUAL") throw new Error("未進入儀式");
  if (snap(a.room).revealedTraitorSeat !== -1) throw new Error("身分外洩！");

  console.log("-- 全員抽取水滴標記");
  a.room.send("DRAW_TOKEN");
  b.room.send("DRAW_TOKEN");
  await sleep(300);
  console.log(`   標記：掌櫃=${a.token} 夥計=${b.token}`);
  if (![a.token, b.token].includes(1) || a.token === b.token) throw new Error("標記分配異常");
  a.room.send("CONFIRM_TOKEN");
  b.room.send("CONFIRM_TOKEN");
  await sleep(300);
  if (snap(a.room).phase !== "HAUNT") throw new Error("儀式未收尾");
  if (snap(a.room).revealedTraitorSeat !== -1) throw new Error("儀式後身分外洩！");

  const survivor = a.token === 1 ? b : a; // 標記 1 是做局者
  console.log(`-- 生還者是座位 ${survivor.seat}，開始收集證據`);

  // 生還者在自己的回合：撿當層證據 → 走樓梯換層 → 再撿，直到集滿 3 件或遊戲結束
  const players = [a, b];
  for (let round = 0; round < 12 && !a.ended; round++) {
    const s = snap(a.room);
    if (s.phase === "GAME_END") break;
    const turnP = players.find((p) => p.seat === s.turnSeat)!;
    if (turnP !== survivor) {
      turnP.room.send("END_TURN");
      await sleep(250);
      continue;
    }
    // 撿腳下所有證據
    let st = snap(survivor.room);
    const meCoord = st.players[String(survivor.seat)].coord;
    for (const [id, it] of Object.entries<any>(st.items || {})) {
      if (it.kind === "EVIDENCE" && it.holderSeat === -1 && it.coord === meCoord) {
        survivor.room.send("PICK_ITEM", { itemId: id });
        await sleep(200);
      }
    }
    st = snap(survivor.room);
    if (st.phase === "GAME_END") break;
    // 走樓梯到另一層的起始板塊
    const here = st.players[String(survivor.seat)].coord as string;
    const stairsTargets = Object.entries<any>(st.tiles)
      .filter(([k, t]) => t.stairs && k !== here && k.split(":")[0] !== here.split(":")[0])
      .map(([k]) => k);
    if (stairsTargets.length > 0 && st.stepsLeft > 0) {
      survivor.room.send("USE_STAIRS", { to: stairsTargets[0] });
      await sleep(200);
    }
    survivor.room.send("END_TURN");
    await sleep(250);
  }

  await sleep(400);
  const final = snap(a.room);
  console.log(`== 終局：phase=${final.phase} winner=${final.winner} reason=${final.endReason} ==`);
  console.log(`   終局公開做局者座位=${final.revealedTraitorSeat}（標記1 = ${a.token === 1 ? "掌櫃" : "夥計"}）`);
  if (final.phase !== "GAME_END" || final.winner !== "HERO") throw new Error("實測未達 HERO 勝終局");
  a.room.leave();
  b.room.leave();
  console.log("✅ 實測通過");
  process.exit(0);
}

main().catch((e) => {
  console.error("❌ 實測失敗:", e);
  process.exit(1);
});

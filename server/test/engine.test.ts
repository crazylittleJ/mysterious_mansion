import { describe, it, expect } from "vitest";
import { rollDice, statCheck, shuffle, FACES } from "../src/game/dice";
import { rotateDoors, rotationToFit, doorsToMask, maskHasDoor } from "../src/game/tiles";
import { hauntRoll, selectTraitor, checkEnd } from "../src/game/engine";
import { NINE_STARS, NINE_STARS_SECRET } from "../src/game/scenario";
import { Dir } from "../src/events";

const seq = (...vals: number[]) => {
  let i = 0;
  return () => vals[i++ % vals.length];
};

describe("dice", () => {
  it("faces are 0/1/2 only and total bounded", () => {
    const r = rollDice(100);
    expect(r.dice.every((d) => [0, 1, 2].includes(d))).toBe(true);
    expect(r.total).toBeGreaterThanOrEqual(0);
    expect(r.total).toBeLessThanOrEqual(200);
  });

  it("statCheck respects target with injected rng", () => {
    // rng=0.99 → face index 5 → 2；4 顆骰全 2 = 8
    const r = statCheck(4, 8, () => 0.99);
    expect(r.total).toBe(8);
    expect(r.success).toBe(true);
    const r2 = statCheck(4, 9, () => 0.99);
    expect(r2.success).toBe(false);
  });

  it("statCheck rolls at least 1 die even at stat 0", () => {
    const r = statCheck(0, 1, () => 0.99);
    expect(r.dice.length).toBe(1);
  });

  it("shuffle keeps all elements", () => {
    const a = [1, 2, 3, 4, 5];
    const s = shuffle(a, seq(0.1, 0.5, 0.9, 0.3, 0.7));
    expect([...s].sort()).toEqual(a);
    expect(FACES.length).toBe(6);
  });
});

describe("tile rotation", () => {
  // 門 [N,E,S,W]
  it("rotateDoors moves N door to E after one CW step", () => {
    expect(rotateDoors([true, false, false, false], 1)).toEqual([false, true, false, false]);
  });

  it("rotationToFit finds rotation so entry side has a door", () => {
    const doors = [true, false, false, false]; // 只有北門
    // 玩家往東走 → 新板塊入口在西側 → 需轉 3 次（N→W）
    const k = rotationToFit(doors, Dir.W);
    expect(k).toBe(3);
    expect(rotateDoors(doors, k)[Dir.W]).toBe(true);
  });

  it("rotationToFit returns 0 when door already fits", () => {
    expect(rotationToFit([true, true, true, true], Dir.S)).toBe(0);
  });

  it("door mask round trip", () => {
    const mask = doorsToMask([true, false, true, false]);
    expect(maskHasDoor(mask, Dir.N)).toBe(true);
    expect(maskHasDoor(mask, Dir.E)).toBe(false);
    expect(maskHasDoor(mask, Dir.S)).toBe(true);
    expect(maskHasDoor(mask, Dir.W)).toBe(false);
  });
});

describe("haunt roll", () => {
  it("haunt begins when total < omen count", () => {
    // 全骰 0 → total 0 < omenCount 1 → 揭盅
    const r = hauntRoll(1, () => 0);
    expect(r.hauntBegins).toBe(true);
  });
  it("haunt does not begin when total >= omen count", () => {
    // 全骰 2 → total 12 >= 12
    const r = hauntRoll(12, () => 0.99);
    expect(r.hauntBegins).toBe(false);
  });
});

describe("traitor selection", () => {
  const seats = [0, 1, 2, 3];

  it("revealer mode picks revealer", () => {
    const p = selectTraitor("revealer", 2, seats);
    expect(p.trueSeat).toBe(2);
    expect(p.revealedSeat).toBe(2);
  });

  it("closest-after-revealer wraps around seat order", () => {
    expect(selectTraitor("closest-after-revealer", 3, seats).trueSeat).toBe(0);
    expect(selectTraitor("closest-after-revealer", 1, seats).trueSeat).toBe(2);
  });

  it("closest-after-revealer skips dead seats (only alive passed in)", () => {
    // 座位 2 已死：alive = [0,1,3]，揭露者 1 → 下一位是 3
    expect(selectTraitor("closest-after-revealer", 1, [0, 1, 3]).trueSeat).toBe(3);
  });

  it("secret-token assigns unique tokens 1..N and token 1 is traitor, identity hidden", () => {
    const p = selectTraitor("secret-token", 0, seats, seq(0.1, 0.7, 0.3, 0.9));
    expect(p.revealedSeat).toBe(-1);
    const tokens = Object.values(p.tokenBySeat!);
    expect([...tokens].sort()).toEqual([1, 2, 3, 4]);
    const traitorSeat = Number(Object.keys(p.tokenBySeat!).find((s) => p.tokenBySeat![Number(s)] === 1));
    expect(p.trueSeat).toBe(traitorSeat);
  });
});

describe("end conditions", () => {
  const base = { scenario: NINE_STARS, progress: 0, traitorAlive: true, survivorsAlive: 3, evidenceHeldBySurvivors: 0 };

  it("no end at start", () => {
    expect(checkEnd(base)).toBeNull();
  });
  it("traitor wins at progress 9", () => {
    expect(checkEnd({ ...base, progress: 9 })).toEqual({ winner: "TRAITOR", reason: "PROGRESS_FULL" });
  });
  it("traitor wins when survivors all dead", () => {
    expect(checkEnd({ ...base, survivorsAlive: 0 })).toEqual({ winner: "TRAITOR", reason: "ALL_SURVIVORS_DEAD" });
  });
  it("heroes win with 3 evidence", () => {
    expect(checkEnd({ ...base, evidenceHeldBySurvivors: 3 })).toEqual({ winner: "HERO", reason: "EVIDENCE_COLLECTED" });
  });
  it("heroes win when traitor dead", () => {
    expect(checkEnd({ ...base, traitorAlive: false })).toEqual({ winner: "HERO", reason: "TRAITOR_DEAD" });
  });
  it("secret variant shares same end conditions", () => {
    expect(checkEnd({ ...base, scenario: NINE_STARS_SECRET, progress: 9 })?.winner).toBe("TRAITOR");
  });
});

import { rollDice, shuffle, Rng } from "./dice";
import { HauntScenario, TraitorSelection } from "./scenario";

/** 預兆檢定：擲 6 骰，總和 < 場上預兆數 → 揭盅 */
export function hauntRoll(omenCount: number, rng: Rng = Math.random) {
  const r = rollDice(6, rng);
  return { ...r, hauntBegins: r.total < omenCount };
}

export interface TraitorPick {
  /** 公開做局者座位；secret-token 模式為 -1 */
  revealedSeat: number;
  /** 真實做局者座位（server 機密） */
  trueSeat: number;
  /** secret-token 模式下每個座位分到的標記號碼（server 機密） */
  tokenBySeat?: Record<number, number>;
}

/**
 * 做局者選定。
 * - revealer：揭露者本人
 * - closest-after-revealer：揭露者往後（座位順序）最近的其他存活玩家
 * - secret-token：洗 1..N 標記，抽到 1 的是做局者，身分保密
 */
export function selectTraitor(
  mode: TraitorSelection,
  revealerSeat: number,
  aliveSeats: number[],
  rng: Rng = Math.random
): TraitorPick {
  const sorted = [...aliveSeats].sort((a, b) => a - b);
  switch (mode) {
    case "revealer":
      return { revealedSeat: revealerSeat, trueSeat: revealerSeat };
    case "closest-after-revealer": {
      const n = sorted.length;
      const idx = sorted.indexOf(revealerSeat);
      // 從揭露者的下一位開始環狀找第一個「不是揭露者」的玩家
      for (let k = 1; k <= n; k++) {
        const seat = sorted[(idx + k) % n];
        if (seat !== revealerSeat) return { revealedSeat: seat, trueSeat: seat };
      }
      // 只剩一人時退化為揭露者
      return { revealedSeat: revealerSeat, trueSeat: revealerSeat };
    }
    case "secret-token": {
      const tokens = shuffle(
        Array.from({ length: sorted.length }, (_, i) => i + 1),
        rng
      );
      const tokenBySeat: Record<number, number> = {};
      let trueSeat = sorted[0];
      sorted.forEach((seat, i) => {
        tokenBySeat[seat] = tokens[i];
        if (tokens[i] === 1) trueSeat = seat;
      });
      return { revealedSeat: -1, trueSeat, tokenBySeat };
    }
  }
}

export interface EndCheckInput {
  scenario: HauntScenario;
  progress: number;
  traitorAlive: boolean;
  survivorsAlive: number;
  evidenceHeldBySurvivors: number;
}

export function checkEnd(input: EndCheckInput): { winner: "HERO" | "TRAITOR"; reason: string } | null {
  const { scenario } = input;
  if (scenario.endConditions.includes("PROGRESS_FULL") && input.progress >= scenario.starItems) {
    return { winner: "TRAITOR", reason: "PROGRESS_FULL" };
  }
  if (scenario.endConditions.includes("ALL_SURVIVORS_DEAD") && input.survivorsAlive === 0) {
    return { winner: "TRAITOR", reason: "ALL_SURVIVORS_DEAD" };
  }
  if (
    scenario.endConditions.includes("EVIDENCE_COLLECTED") &&
    input.evidenceHeldBySurvivors >= scenario.evidenceToWin
  ) {
    return { winner: "HERO", reason: "EVIDENCE_COLLECTED" };
  }
  if (scenario.endConditions.includes("TRAITOR_DEAD") && !input.traitorAlive) {
    return { winner: "HERO", reason: "TRAITOR_DEAD" };
  }
  return null;
}

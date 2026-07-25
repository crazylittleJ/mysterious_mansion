/** 特色骰：六面為 0,0,1,1,2,2。rng 可注入以便測試。 */
export type Rng = () => number;

export const FACES = [0, 0, 1, 1, 2, 2] as const;

export function rollDice(count: number, rng: Rng = Math.random): { dice: number[]; total: number } {
  const dice: number[] = [];
  for (let i = 0; i < count; i++) {
    dice.push(FACES[Math.floor(rng() * 6)]);
  }
  return { dice, total: dice.reduce((a, b) => a + b, 0) };
}

/** 屬性檢定：擲「屬性值」顆骰，總和 >= target 即成功 */
export function statCheck(statValue: number, target: number, rng: Rng = Math.random) {
  const r = rollDice(Math.max(statValue, 1), rng);
  return { ...r, success: r.total >= target };
}

/** 洗牌（Fisher–Yates），回傳新陣列 */
export function shuffle<T>(arr: readonly T[], rng: Rng = Math.random): T[] {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/**
 * 劇本模板。所有文字為古董局中局世界觀原創。
 * 高機密欄位（objective 全文）不進 schema，由 room 用私訊交付。
 */

export type TraitorSelection = "revealer" | "closest-after-revealer" | "secret-token";

export type EndCondition =
  | "PROGRESS_FULL" // 大局進度滿 → 做局者勝
  | "ALL_SURVIVORS_DEAD" // 生還者全滅 → 做局者勝
  | "EVIDENCE_COLLECTED" // 生還者集齊證據 → 生還者勝
  | "TRAITOR_DEAD"; // 做局者死亡 → 生還者勝

export interface MonsterSpawn {
  typeId: string;
  name: string;
  count: (players: number) => number;
  might: number;
  speed: number;
}

export interface HauntScenario {
  id: string;
  title: string;
  /** 觸發：任一預兆抽出後的預兆檢定失敗即進入此劇本（骨架版用 default 對映） */
  trigger: { omenId: string | "*" };
  traitorSelection: TraitorSelection;
  /** 若指定角色在場則優先為做局者（規則書第 2 條），骨架先留欄位 */
  preferredTraitorName?: string;
  monsters: MonsterSpawn[];
  /** 星宿古董數量（散佈於已探索板塊） */
  starItems: number;
  /** 生還者要湊齊的證據數 */
  evidenceToWin: number;
  progressLabel: string;
  traitorObjective: string;
  survivorObjective: string;
  endConditions: EndCondition[];
}

export const NINE_STARS: HauntScenario = {
  id: "nine-stars",
  title: "九星連珠",
  trigger: { omenId: "*" },
  traitorSelection: "revealer",
  monsters: [
    {
      typeId: "mentu",
      name: "門徒",
      count: (players) => Math.floor(players / 2) + 1,
      might: 2,
      speed: 3,
    },
  ],
  starItems: 9,
  evidenceToWin: 3,
  progressLabel: "大局進度",
  traitorObjective:
    "【做局者之書】你佈了半輩子的局終於到了收官。宅子各處散落著九件「星宿古董」，" +
    "把它們一件件送進地窖的密室。九星連珠之時，大局告成，天下古玩行都得看你的臉色。" +
    "你的門徒聽你號令（生還者回合結束後由你操作怪物回合）。" +
    "勝利條件：大局進度達到 9，或所有生還者出局。",
  survivorObjective:
    "【生存秘笈】揭盅了——這宅子從頭到尾就是一個局。做局者正在收集九件「星宿古董」送往密室。" +
    "阻止他：搶在他之前找到三件「證據」揭穿整個騙局，或直接讓做局者出局。" +
    "小心他的門徒，他們不受這宅子的邪性影響。" +
    "勝利條件：集齊 3 件證據，或做局者出局。",
  endConditions: ["PROGRESS_FULL", "ALL_SURVIVORS_DEAD", "EVIDENCE_COLLECTED", "TRAITOR_DEAD"],
};

/** 秘密做局者變體：驗證水滴儀式流程用 */
export const NINE_STARS_SECRET: HauntScenario = {
  ...NINE_STARS,
  id: "nine-stars-secret",
  title: "九星連珠・暗局",
  traitorSelection: "secret-token",
  monsters: [], // 秘密做局者自曝前沒有門徒
  traitorObjective:
    "【做局者之書・暗局】沒人知道你是誰——維持下去。混在他們之中，暗中把九件「星宿古董」" +
    "送進密室。你可以繼續假裝鑑寶。一旦你想動用做局者的優勢（免疫房間邪性、自由使用電梯滑道），" +
    "就必須先向所有人亮明身分。勝利條件：大局進度達到 9，或所有生還者出局。",
  survivorObjective:
    "【生存秘笈・暗局】揭盅了，但做局者藏在你們中間，沒人知道是誰。" +
    "有人在暗中把「星宿古董」運往密室。集齊 3 件證據揭穿他，或找出並讓做局者出局。" +
    "勝利條件：集齊 3 件證據，或做局者出局。",
};

const SCENARIOS: Record<string, HauntScenario> = {
  [NINE_STARS.id]: NINE_STARS,
  [NINE_STARS_SECRET.id]: NINE_STARS_SECRET,
};

export function scenarioById(id: string): HauntScenario {
  const s = SCENARIOS[id];
  if (!s) throw new Error(`unknown scenario: ${id}`);
  return s;
}

/** 骨架版：預兆 → 劇本對映（之後每張預兆×房間可對映不同劇本） */
export function scenarioForOmen(_omenId: string, secretVariant: boolean): HauntScenario {
  return secretVariant ? NINE_STARS_SECRET : NINE_STARS;
}

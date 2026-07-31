/**
 * 事件 enum 全集（封閉集合）。
 * 未來 Gemini 層只允許輸出 ClientIntent 中的動作，規則裁決永遠在 server。
 */

/** 客戶端 → 伺服器：玩家意圖 */
export enum ClientIntent {
  /** 房主（seat 0）開始遊戲 { secretVariant?: boolean } */
  START_GAME = "START_GAME",
  /** 移動到相鄰且有門相連的板塊 { to: coordKey } */
  MOVE = "MOVE",
  /** 對未探索方向開門探索 { dir: Dir } */
  EXPLORE = "EXPLORE",
  /** 使用樓梯/神秘電梯 { to: coordKey } */
  USE_STAIRS = "USE_STAIRS",
  /** 撿起腳下物品 { itemId } */
  PICK_ITEM = "PICK_ITEM",
  /** 放下物品 { itemId } */
  DROP_ITEM = "DROP_ITEM",
  /** 攻擊同板塊目標 { targetKind: "PLAYER"|"MONSTER", targetId } */
  ATTACK = "ATTACK",
  /** 結束回合 */
  END_TURN = "END_TURN",
  /** 水滴儀式：抽取自己的標記 */
  DRAW_TOKEN = "DRAW_TOKEN",
  /** 水滴儀式：確認已收好標記 */
  CONFIRM_TOKEN = "CONFIRM_TOKEN",
  /** 秘密做局者主動亮明身分（開始使用優勢前必須宣告） */
  SELF_REVEAL = "SELF_REVEAL",
  /** 做局者：於密室交付星宿古董，推進大局 { itemId } */
  ADVANCE_RITUAL = "ADVANCE_RITUAL",
  /** 怪物回合：移動指定怪物 { monsterId, to: coordKey } */
  MONSTER_MOVE = "MONSTER_MOVE",
  /** 怪物回合：怪物攻擊 { monsterId, targetSeat } */
  MONSTER_ATTACK = "MONSTER_ATTACK",
  /** 怪物回合結束 */
  MONSTER_END = "MONSTER_END",
}

/** 伺服器 → 客戶端：私訊/廣播訊息型別 */
export enum ServerMsg {
  /** 私訊：入座/重連後告知你自己的座位 { seat, name } —— client 不必再靠 log 猜座位 */
  YOUR_SEAT = "YOUR_SEAT",
  /** 私訊：你的水滴標記號碼 { number } */
  YOUR_TOKEN = "YOUR_TOKEN",
  /** 私訊：你的陣營與勝利條件全文 { camp, objective } */
  YOUR_OBJECTIVE = "YOUR_OBJECTIVE",
  /** 廣播：敘事/日誌 { text } */
  LOG = "LOG",
  /** 廣播：擲骰結果 { seat, kind, dice, total } */
  DICE = "DICE",
  /** 廣播：遊戲結束 { winner, reason } */
  GAME_END = "GAME_END",
  /** 私訊：錯誤 { code, message } */
  ERROR = "ERROR",
}

export enum Phase {
  LOBBY = "LOBBY",
  EXPLORATION = "EXPLORATION",
  /** 水滴儀式：秘密做局者劇本專用 */
  HAUNT_RITUAL = "HAUNT_RITUAL",
  /** 揭盅後 */
  HAUNT = "HAUNT",
  /** 怪物回合（由做局者操作） */
  MONSTER_TURN = "MONSTER_TURN",
  GAME_END = "GAME_END",
}

export enum Dir {
  N = 0,
  E = 1,
  S = 2,
  W = 3,
}

export const DIR_DELTA: Record<Dir, [number, number]> = {
  [Dir.N]: [0, -1],
  [Dir.E]: [1, 0],
  [Dir.S]: [0, 1],
  [Dir.W]: [-1, 0],
};

export function oppositeDir(d: Dir): Dir {
  return ((d + 2) % 4) as Dir;
}

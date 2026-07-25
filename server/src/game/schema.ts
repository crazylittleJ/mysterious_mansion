import { Schema, type, MapSchema, ArraySchema } from "@colyseus/schema";

/**
 * 資訊隔離原則：
 * - Schema 內只放「全員可見」的公開資訊。
 * - 高機密（秘密做局者真實身分、水滴標記分配、牌堆順序、劇本隱藏條件）
 *   一律存 server 端普通變數（BetrayalRoom.secrets），透過 client.send() 私訊交付。
 * - Colyseus 0.15 的 @filter 在 0.16 已被 StateView 取代；骨架刻意不依賴兩者，
 *   杜絕日後改 filter 邏輯時誤洩漏的風險。陣營級文本用 campBroadcast() 私訊。
 */

export class PlayerState extends Schema {
  @type("number") seatIndex = -1;
  @type("string") name = "";
  @type("boolean") connected = true;
  @type("boolean") alive = true;

  // 四屬性：眼力/手法/心性/氣力
  @type("number") yanli = 4;
  @type("number") shoufa = 4;
  @type("number") xinxing = 4;
  @type("number") qili = 4;

  @type("string") coord = ""; // coordKey
  /** 表面陣營：秘密做局者在自曝前保持 HERO */
  @type("string") revealedCamp = "HERO"; // HERO | TRAITOR
  /** 水滴儀式進度（公開的只有「已抽/已確認」，數字走私訊） */
  @type("boolean") tokenDrawn = false;
  @type("boolean") tokenConfirmed = false;
}

export class TileState extends Schema {
  @type("string") defId = "";
  @type("string") name = "";
  @type("string") floor = "GROUND";
  @type("number") x = 0;
  @type("number") y = 0;
  /** 旋轉後門的 bitmask：N=1 E=2 S=4 W=8 */
  @type("number") doorMask = 0;
  @type("string") icon = "NONE";
  @type("boolean") stairs = false;
  @type("boolean") elevator = false;
  @type("boolean") ritualRoom = false;
  @type("string") imageUrl = "";
}

export class MonsterState extends Schema {
  @type("string") id = "";
  @type("string") typeId = "";
  @type("string") name = "";
  @type("string") coord = "";
  @type("number") might = 2;
  @type("number") speed = 3;
  @type("boolean") alive = true;
}

export class ItemState extends Schema {
  @type("string") id = "";
  @type("string") name = "";
  /** NORMAL | OMEN | STAR(星宿古董) | EVIDENCE(證據) */
  @type("string") kind = "NORMAL";
  /** -1 = 在地上（用 coord），否則為持有者 seatIndex */
  @type("number") holderSeat = -1;
  @type("string") coord = "";
}

export class GameState extends Schema {
  @type("string") roomCode = "";
  @type("string") phase = "LOBBY";
  @type("string") scenarioId = "";
  @type("number") omenCount = 0;
  @type("boolean") hauntRevealed = false;
  /** 公開做局者座位；秘密劇本自曝前為 -1 */
  @type("number") revealedTraitorSeat = -1;

  @type("number") turnSeat = -1;
  @type("number") stepsLeft = 0;
  @type("number") round = 0;

  /** 大局進度（九星連珠：0→9） */
  @type("number") progress = 0;
  @type("number") progressMax = 0;
  @type("string") progressLabel = "";

  @type({ map: PlayerState }) players = new MapSchema<PlayerState>();
  @type({ map: TileState }) tiles = new MapSchema<TileState>();
  @type({ map: ItemState }) items = new MapSchema<ItemState>();
  @type([MonsterState]) monsters = new ArraySchema<MonsterState>();

  @type("string") winner = ""; // "" | HERO | TRAITOR
  @type("string") endReason = "";
}

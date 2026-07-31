import { Room, Client } from "colyseus";
import { ClientIntent, ServerMsg, Phase, Dir, DIR_DELTA, oppositeDir } from "../events";
import { GameState, PlayerState, TileState, MonsterState, ItemState } from "../game/schema";
import {
  START_TILE_DEFS,
  TILE_DEFS,
  TileDef,
  Floor,
  coordKey,
  parseCoord,
  rotationToFit,
  rotateDoors,
  doorsToMask,
  maskHasDoor,
  entrySideFor,
  tileDefById,
} from "../game/tiles";
import { rollDice, statCheck, shuffle } from "../game/dice";
import { hauntRoll, selectTraitor, checkEnd } from "../game/engine";
import { scenarioForOmen, scenarioById, HauntScenario } from "../game/scenario";
import { getStore, GameSnapshot, MAX_SAVED_GAMES } from "../persistence/store";
import cardsJson from "../data/cards.json";

const RECONNECT_SECONDS = 120;

/**
 * 無人在線後多久解散房間並清檔。可用環境變數覆寫（毫秒）。
 * 預設 30 分鐘：足夠短暫離線回來，又能及時釋放存檔名額。
 */
const ROOM_IDLE_TIMEOUT_MS = Number(process.env.ROOM_IDLE_TIMEOUT_MS || 30 * 60 * 1000);
/**
 * PURGE_INPROGRESS_ON_IDLE=1 時，連「進行中」的局在 idle 逾時後也一併刪檔。
 * 預設關閉，以保留「隔天回來續玩」功能（進行中的局仍靠 24h TTL 收尾）。
 */
const PURGE_INPROGRESS_ON_IDLE = process.env.PURGE_INPROGRESS_ON_IDLE === "1";

/** 名稱正規化：去頭尾空白、壓縮連續空白、截斷 12 字，作為顯示名；比對鍵再轉小寫。 */
export function normName(raw: string): string {
  return (raw || "").trim().replace(/\s+/g, " ").slice(0, 12);
}
function nameKey(raw: string): string {
  return normName(raw).toLowerCase();
}

interface Secrets {
  trueTraitorSeat: number;
  tokenBySeat: Record<number, number> | null;
  decks: { events: string[]; items: string[]; omens: string[] };
  /** 正規化名稱鍵（nameKey）→ 座位 */
  seatByName: Record<string, number>;
  secretVariant: boolean;
}

export class BetrayalRoom extends Room<GameState> {
  maxClients = 5;

  private secrets: Secrets = {
    trueTraitorSeat: -1,
    tokenBySeat: null,
    decks: { events: [], items: [], omens: [] },
    seatByName: {},
    secretVariant: false,
  };
  private seatBySession = new Map<string, number>();
  private scenario: HauntScenario | null = null;
  private saveTimer: NodeJS.Timeout | null = null;
  private idleTimer: NodeJS.Timeout | null = null;

  // ---------------------------------------------------------------- lifecycle

  async onCreate(options: { roomCode?: string; secretVariant?: boolean }) {
    const roomCode = (options.roomCode || "").toUpperCase().trim();
    if (!roomCode) throw new Error("roomCode required");

    const store = getStore();
    const snapshot = await store.load(roomCode);

    if (snapshot) {
      this.hydrate(snapshot);
    } else {
      if ((await store.count()) >= MAX_SAVED_GAMES) {
        throw new Error("ROOM_LIMIT: 目前存檔已達 3 局上限，請稍後再試或等舊局過期");
      }
      const state = new GameState();
      state.roomCode = roomCode;
      state.phase = Phase.LOBBY;
      this.setState(state);
      this.secrets.secretVariant = !!options.secretVariant;
      this.secrets.decks = {
        events: shuffle((cardsJson as any).events.map((c: any) => c.id)),
        items: shuffle((cardsJson as any).items.map((c: any) => c.id)),
        omens: shuffle((cardsJson as any).omens.map((c: any) => c.id)),
      };
      await this.persist();
    }

    this.registerHandlers();
    // 建立後若沒人 join（例如從快照重建卻無人回來），閒置逾時自動收攤
    this.armIdleIfEmpty();
  }

  async onJoin(client: Client, options: { name?: string }) {
    // 以「玩家名稱」作為唯一識別（非 IP、非 token）。同名即視為同一人。
    const display = normName(options.name || "");
    if (!display) throw new Error("NO_NAME: 請先輸入名號再入宅");
    const key = nameKey(display);

    let seat = this.secrets.seatByName[key];

    if (seat === undefined) {
      // 新玩家：遊戲已開始就不收新人
      if (this.state.phase !== Phase.LOBBY) throw new Error("GAME_STARTED: 這局已開打，無法中途加入");
      seat = this.nextFreeSeat();
      if (seat < 0) throw new Error("ROOM_FULL: 這局人數已滿");
      this.secrets.seatByName[key] = seat;
      const p = new PlayerState();
      p.seatIndex = seat;
      p.name = display;
      p.connected = true;
      this.state.players.set(String(seat), p);
      this.log(`${p.name} 入座（座位 ${seat + 1}）`);
    } else {
      // 同名回鍋：斷線重連或存檔續玩。若該名號目前仍有人在線，拒絕重複佔用。
      const p = this.state.players.get(String(seat));
      if (p?.connected) throw new Error("NAME_TAKEN: 此名號正在使用中，請換一個");
      if (p) {
        p.connected = true;
        this.log(`${p.name} 重新連線`);
        this.resendPrivateInfo(client, seat);
      }
    }

    this.seatBySession.set(client.sessionId, seat);
    // 直接告知 client 自己的座位，取代舊版靠 log 正則猜座位的脆弱做法
    client.send(ServerMsg.YOUR_SEAT, { seat, name: this.state.players.get(String(seat))?.name });
    this.disarmIdle();
    await this.persist();
  }

  async onLeave(client: Client, consented: boolean) {
    const seat = this.seatBySession.get(client.sessionId);
    const p = seat !== undefined ? this.state.players.get(String(seat)) : undefined;
    if (p) p.connected = false;
    this.seatBySession.delete(client.sessionId);
    await this.persist();
    this.armIdleIfEmpty();

    if (!consented) {
      try {
        // 短斷線：兩分鐘內回來直接續（長離線走存檔快照重建）
        const rejoined = await this.allowReconnection(client, RECONNECT_SECONDS);
        this.seatBySession.set(rejoined.sessionId, seat!);
        if (p) p.connected = true;
        this.disarmIdle();
        rejoined.send(ServerMsg.YOUR_SEAT, { seat: seat!, name: p?.name });
        this.resendPrivateInfo(rejoined, seat!);
      } catch {
        /* 逾時：等玩家之後用同名號走快照回房 */
      }
    }
  }

  async onDispose() {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    if (this.idleTimer) clearTimeout(this.idleTimer);
    // 解散前決定清檔或留檔：
    // - 已結束(GAME_END) → 刪
    // - 從沒開局(LOBBY)   → 刪（別讓空候客房佔用 3 局名額）
    // - 進行中           → 留最後快照，供 24h 內同名續玩（除非強制清除）
    const phase = this.state.phase;
    const shouldPurge =
      phase === Phase.GAME_END || phase === Phase.LOBBY || PURGE_INPROGRESS_ON_IDLE;
    if (shouldPurge) {
      await getStore().delete(this.state.roomCode);
    } else {
      await this.persist(true);
    }
  }

  // ------------------------------------------------------------- idle timeout

  private connectedCount(): number {
    let n = 0;
    this.state.players.forEach((p) => {
      if (p.connected) n++;
    });
    return n;
  }

  /** 全員離線時啟動閒置計時器；逾時就解散房間（onDispose 依 phase 決定是否清檔）。 */
  private armIdleIfEmpty() {
    if (this.connectedCount() > 0) return;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      this.log("房間閒置逾時，收攤。");
      this.disconnect().catch(() => {});
    }, ROOM_IDLE_TIMEOUT_MS);
  }

  private disarmIdle() {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
  }

  // ---------------------------------------------------------------- handlers

  private registerHandlers() {
    this.onMessage(ClientIntent.START_GAME, (c) => this.guard(c, () => this.startGame(c)));
    this.onMessage(ClientIntent.MOVE, (c, m) => this.guard(c, () => this.move(c, m?.to)));
    this.onMessage(ClientIntent.EXPLORE, (c, m) => this.guard(c, () => this.explore(c, m?.dir)));
    this.onMessage(ClientIntent.USE_STAIRS, (c, m) => this.guard(c, () => this.useStairs(c, m?.to)));
    this.onMessage(ClientIntent.PICK_ITEM, (c, m) => this.guard(c, () => this.pickItem(c, m?.itemId)));
    this.onMessage(ClientIntent.DROP_ITEM, (c, m) => this.guard(c, () => this.dropItem(c, m?.itemId)));
    this.onMessage(ClientIntent.ATTACK, (c, m) => this.guard(c, () => this.attack(c, m)));
    this.onMessage(ClientIntent.END_TURN, (c) => this.guard(c, () => this.endTurn(c)));
    this.onMessage(ClientIntent.DRAW_TOKEN, (c) => this.guard(c, () => this.drawToken(c)));
    this.onMessage(ClientIntent.CONFIRM_TOKEN, (c) => this.guard(c, () => this.confirmToken(c)));
    this.onMessage(ClientIntent.SELF_REVEAL, (c) => this.guard(c, () => this.selfReveal(c)));
    this.onMessage(ClientIntent.ADVANCE_RITUAL, (c, m) => this.guard(c, () => this.advanceRitual(c, m?.itemId)));
    this.onMessage(ClientIntent.MONSTER_MOVE, (c, m) => this.guard(c, () => this.monsterMove(c, m)));
    this.onMessage(ClientIntent.MONSTER_ATTACK, (c, m) => this.guard(c, () => this.monsterAttack(c, m)));
    this.onMessage(ClientIntent.MONSTER_END, (c) => this.guard(c, () => this.monsterEnd(c)));

    // 僅開發/實測：GUDONG_DEBUG=1 時可強制揭盅，方便確定性驗證流程
    if (process.env.GUDONG_DEBUG === "1") {
      this.onMessage("DEBUG_FORCE_HAUNT", (c) =>
        this.guard(c, () => {
          if (this.state.hauntRevealed) throw new Error("已揭盅");
          this.startHaunt(this.seatOf(c), "om-guijia");
        })
      );
    }
  }

  private guard(client: Client, fn: () => void | Promise<void>) {
    Promise.resolve()
      .then(fn)
      .then(() => this.persistDebounced())
      .catch((e: any) => {
        client.send(ServerMsg.ERROR, { code: "RULE", message: String(e?.message || e) });
      });
  }

  // ---------------------------------------------------------------- game flow

  private startGame(client: Client) {
    this.assertSeat(client, 0);
    if (this.state.phase !== Phase.LOBBY) throw new Error("已經開始了");
    if (this.state.players.size < 2) throw new Error("至少需要 2 名玩家");

    // 鋪三張起始板塊
    for (const def of START_TILE_DEFS) {
      this.placeTile(def, def.startFloor as Floor, 0, 0, 0);
    }
    // 全員站前廳
    const startKey = coordKey("GROUND", 0, 0);
    this.state.players.forEach((p) => (p.coord = startKey));

    this.state.phase = Phase.EXPLORATION;
    this.state.round = 1;
    this.state.turnSeat = this.firstAliveSeat();
    this.beginPlayerTurn();
    this.log(`開局。${this.currentPlayer().name} 先行。`);
  }

  private beginPlayerTurn() {
    const p = this.currentPlayer();
    this.state.stepsLeft = Math.max(p.shoufa, 1);
  }

  private move(client: Client, to: string) {
    const p = this.assertMyTurn(client);
    if (this.state.stepsLeft <= 0) throw new Error("本回合步數已用完");
    const from = parseCoord(p.coord);
    const target = this.state.tiles.get(to);
    if (!target) throw new Error("目標板塊不存在（未探索方向請用 EXPLORE）");
    const dir = this.adjacentDir(from, parseCoord(to));
    if (dir === null) throw new Error("不相鄰");
    const fromTile = this.state.tiles.get(p.coord)!;
    if (!maskHasDoor(fromTile.doorMask, dir) || !maskHasDoor(target.doorMask, oppositeDir(dir))) {
      throw new Error("這個方向沒有門");
    }
    p.coord = to;
    this.state.stepsLeft--;
  }

  private explore(client: Client, dir: Dir) {
    const p = this.assertMyTurn(client);
    if (this.state.stepsLeft <= 0) throw new Error("本回合步數已用完");
    if (dir === undefined || dir < 0 || dir > 3) throw new Error("方向不合法");
    const from = parseCoord(p.coord);
    const fromTile = this.state.tiles.get(p.coord)!;
    if (!maskHasDoor(fromTile.doorMask, dir)) throw new Error("這面牆沒有門");
    const [dx, dy] = DIR_DELTA[dir];
    const nx = from.x + dx;
    const ny = from.y + dy;
    const key = coordKey(from.floor, nx, ny);
    if (this.state.tiles.get(key)) throw new Error("那裡已經有板塊了，請用 MOVE");

    // 只從符合樓層的池子抽（數位版簡化：不做「翻到不符棄掉重翻」）
    const usedDefs = new Set<string>();
    this.state.tiles.forEach((t) => usedDefs.add(t.defId));
    const pool = TILE_DEFS.filter((d) => d.floors.includes(from.floor) && !usedDefs.has(d.defId));
    if (pool.length === 0) throw new Error("這個樓層的板塊抽完了");
    const def = shuffle(pool)[0];

    const entrySide = entrySideFor(dir);
    const rot = rotationToFit(def.doors, entrySide);
    const tile = this.placeTile(def, from.floor, nx, ny, rot);
    p.coord = key;
    this.state.stepsLeft--;
    this.log(`${p.name} 探索出「${tile.name}」`);

    // 圖示觸發抽卡；抽到卡本回合移動結束
    if (def.icon !== "NONE") {
      this.drawCard(client, p, def.icon);
      this.state.stepsLeft = 0;
    }
  }

  private useStairs(client: Client, to: string) {
    const p = this.assertMyTurn(client);
    if (this.state.stepsLeft <= 0) throw new Error("本回合步數已用完");
    const fromTile = this.state.tiles.get(p.coord)!;
    const target = this.state.tiles.get(to);
    if (!target) throw new Error("目標板塊不存在");
    const bothStairs = fromTile.stairs && target.stairs;
    const bothElevator = fromTile.elevator || target.elevator;
    if (!bothStairs && !bothElevator) throw new Error("這裡沒有樓梯或電梯");
    if (parseCoord(p.coord).floor === parseCoord(to).floor) throw new Error("要往不同樓層");
    // 骨架版：做局者用電梯免檢定；一般人用電梯需手法檢定 3+
    const isTraitor = this.state.hauntRevealed && p.seatIndex === this.secrets.trueTraitorSeat;
    if (bothElevator && !isTraitor) {
      const r = statCheck(p.shoufa, 3);
      this.broadcast(ServerMsg.DICE, { seat: p.seatIndex, kind: "電梯手法檢定", dice: r.dice, total: r.total });
      if (!r.success) {
        this.state.stepsLeft--;
        throw new Error("檢定失敗，電梯沒動");
      }
    }
    p.coord = to;
    this.state.stepsLeft--;
  }

  private drawCard(client: Client, p: PlayerState, icon: string) {
    const deckName = icon === "EVENT" ? "events" : icon === "ITEM" ? "items" : "omens";
    const deck = this.secrets.decks[deckName as keyof Secrets["decks"]];
    if (deck.length === 0) {
      this.log("牌堆抽完了，本次不觸發");
      return;
    }
    const cardId = deck.shift()!;
    const card = [...(cardsJson as any).events, ...(cardsJson as any).items, ...(cardsJson as any).omens].find(
      (c: any) => c.id === cardId
    );
    this.log(`${p.name} 抽到【${card.name}】：${card.text}`);

    if (card.effect === "STAT_DELTA") {
      this.applyDelta(p, card.stat, card.delta);
    } else if (card.effect === "CHECK") {
      const r = statCheck((p as any)[card.stat], card.target);
      this.broadcast(ServerMsg.DICE, { seat: p.seatIndex, kind: `${card.name} 檢定`, dice: r.dice, total: r.total });
      const outcome = r.success ? card.success : card.fail;
      if (outcome) this.applyDelta(p, outcome.stat, outcome.delta);
    } else if (card.effect === "HOLD_BONUS") {
      const item = new ItemState();
      item.id = `${card.id}#${Date.now() % 100000}`;
      item.name = card.name;
      item.kind = icon === "OMEN" ? "OMEN" : "NORMAL";
      item.holderSeat = p.seatIndex;
      this.state.items.set(item.id, item);
      this.applyDelta(p, card.stat, card.delta);
    }

    if (icon === "OMEN") {
      this.state.omenCount++;
      const r = hauntRoll(this.state.omenCount);
      this.broadcast(ServerMsg.DICE, {
        seat: p.seatIndex,
        kind: `預兆檢定（需 ≥ ${this.state.omenCount}）`,
        dice: r.dice,
        total: r.total,
      });
      if (r.hauntBegins && !this.state.hauntRevealed) {
        this.startHaunt(p.seatIndex, cardId);
      }
    }
    this.maybeEnd();
  }

  private applyDelta(p: PlayerState, stat: string, delta: number) {
    (p as any)[stat] = Math.max(0, ((p as any)[stat] as number) + delta);
    if (p.qili <= 0 || p.xinxing <= 0) {
      p.alive = false;
      this.log(`${p.name} 出局了`);
      this.maybeEnd();
    }
  }

  // ---------------------------------------------------------------- haunt

  private startHaunt(revealerSeat: number, omenId: string) {
    const scenario = scenarioForOmen(omenId, this.secrets.secretVariant);
    this.scenario = scenario;
    this.state.scenarioId = scenario.id;
    this.state.hauntRevealed = true;
    this.state.progressMax = scenario.starItems;
    this.state.progressLabel = scenario.progressLabel;
    this.log(`揭盅！劇本【${scenario.title}】開始。`);

    const aliveSeats = this.aliveSeats();
    const pick = selectTraitor(scenario.traitorSelection, revealerSeat, aliveSeats);
    this.secrets.trueTraitorSeat = pick.trueSeat;
    this.secrets.tokenBySeat = pick.tokenBySeat ?? null;

    // 散佈星宿古董與證據到已探索板塊
    const tileKeys: string[] = [];
    this.state.tiles.forEach((_t, k) => tileKeys.push(k));
    const spots = shuffle(tileKeys);
    for (let i = 0; i < scenario.starItems; i++) {
      const it = new ItemState();
      it.id = `star-${i + 1}`;
      it.name = `星宿古董・${"角亢氐房心尾箕斗牛".charAt(i)}`;
      it.kind = "STAR";
      it.coord = spots[i % spots.length];
      this.state.items.set(it.id, it);
    }
    for (let i = 0; i < scenario.evidenceToWin + 1; i++) {
      const it = new ItemState();
      it.id = `evidence-${i + 1}`;
      it.name = `證據・${i + 1}`;
      it.kind = "EVIDENCE";
      it.coord = spots[(i + scenario.starItems) % spots.length];
      this.state.items.set(it.id, it);
    }

    if (scenario.traitorSelection === "secret-token") {
      // 水滴儀式：身分保密，全員抽標記
      this.state.phase = Phase.HAUNT_RITUAL;
      this.log("水滴儀式開始：每人抽取一枚標記，只有自己能看到號碼。抽到「1」的人是做局者。");
    } else {
      this.state.revealedTraitorSeat = pick.trueSeat;
      const tp = this.state.players.get(String(pick.trueSeat))!;
      tp.revealedCamp = "TRAITOR";
      this.spawnMonsters(scenario);
      this.enterHauntPhase();
      this.log(`做局者現身：${tp.name}！`);
    }
  }

  private drawToken(client: Client) {
    if (this.state.phase !== Phase.HAUNT_RITUAL) throw new Error("現在不是儀式階段");
    const seat = this.seatOf(client);
    const p = this.state.players.get(String(seat))!;
    if (p.tokenDrawn) throw new Error("你已經抽過了");
    p.tokenDrawn = true;
    const num = this.secrets.tokenBySeat?.[seat];
    client.send(ServerMsg.YOUR_TOKEN, { number: num });
    this.log(`${p.name} 已抽取標記`);
  }

  private confirmToken(client: Client) {
    if (this.state.phase !== Phase.HAUNT_RITUAL) throw new Error("現在不是儀式階段");
    const seat = this.seatOf(client);
    const p = this.state.players.get(String(seat))!;
    if (!p.tokenDrawn) throw new Error("先抽取標記");
    p.tokenConfirmed = true;

    let all = true;
    this.state.players.forEach((pl) => {
      if (pl.alive && !pl.tokenConfirmed) all = false;
    });
    if (all) {
      this.log("全員已收好標記。暗局開始——做局者藏在你們之中。");
      this.enterHauntPhase();
    }
  }

  private selfReveal(client: Client) {
    const seat = this.seatOf(client);
    if (seat !== this.secrets.trueTraitorSeat) throw new Error("你不是做局者");
    if (this.state.revealedTraitorSeat >= 0) throw new Error("已經亮明身分了");
    this.state.revealedTraitorSeat = seat;
    const p = this.state.players.get(String(seat))!;
    p.revealedCamp = "TRAITOR";
    this.log(`${p.name} 亮明身分：我就是做局者！`);
  }

  private enterHauntPhase() {
    this.state.phase = Phase.HAUNT;
    this.sendObjectives();
    this.beginPlayerTurn();
  }

  private sendObjectives() {
    const scenario = this.scenario!;
    const secret = scenario.traitorSelection === "secret-token";
    this.clients.forEach((c) => {
      const seat = this.seatBySession.get(c.sessionId);
      if (seat === undefined) return;
      const isTraitor = seat === this.secrets.trueTraitorSeat;
      if (isTraitor) {
        c.send(ServerMsg.YOUR_OBJECTIVE, { camp: "TRAITOR", objective: scenario.traitorObjective });
        if (secret) {
          // 秘密做局者表面上仍是生還者，也看得到生存秘笈
          c.send(ServerMsg.YOUR_OBJECTIVE, { camp: "HERO", objective: scenario.survivorObjective });
        }
      } else {
        c.send(ServerMsg.YOUR_OBJECTIVE, { camp: "HERO", objective: scenario.survivorObjective });
      }
    });
  }

  private resendPrivateInfo(client: Client, seat: number) {
    // 重連補發私訊（標記號碼、勝利條件）
    if (this.secrets.tokenBySeat && this.state.players.get(String(seat))?.tokenDrawn) {
      client.send(ServerMsg.YOUR_TOKEN, { number: this.secrets.tokenBySeat[seat] });
    }
    if (this.state.hauntRevealed && this.scenario) {
      const scenario = this.scenario;
      const secret = scenario.traitorSelection === "secret-token";
      const isTraitor = seat === this.secrets.trueTraitorSeat;
      if (isTraitor) {
        client.send(ServerMsg.YOUR_OBJECTIVE, { camp: "TRAITOR", objective: scenario.traitorObjective });
        if (secret) client.send(ServerMsg.YOUR_OBJECTIVE, { camp: "HERO", objective: scenario.survivorObjective });
      } else {
        client.send(ServerMsg.YOUR_OBJECTIVE, { camp: "HERO", objective: scenario.survivorObjective });
      }
    }
  }

  private spawnMonsters(scenario: HauntScenario) {
    const players = this.aliveSeats().length;
    scenario.monsters.forEach((spawn) => {
      const n = spawn.count(players);
      const speedRoll = Math.max(rollDice(spawn.speed).total, 1); // 同種怪物共用速度骰（回合開始重擲，此為初始）
      for (let i = 0; i < n; i++) {
        const m = new MonsterState();
        m.id = `${spawn.typeId}-${i + 1}`;
        m.typeId = spawn.typeId;
        m.name = `${spawn.name}${i + 1}`;
        m.might = spawn.might;
        m.speed = speedRoll;
        m.coord = coordKey("BASEMENT", 0, 0);
        this.state.monsters.push(m);
      }
      this.log(`${n} 名${spawn.name}出現在地窖`);
    });
  }

  // ---------------------------------------------------------------- items & combat

  private pickItem(client: Client, itemId: string) {
    const p = this.assertMyTurn(client);
    const it = this.state.items.get(itemId);
    if (!it) throw new Error("沒有這件物品");
    if (it.holderSeat >= 0 || it.coord !== p.coord) throw new Error("物品不在你腳下");
    it.holderSeat = p.seatIndex;
    it.coord = "";
    this.log(`${p.name} 拾起「${it.name}」`);
    this.maybeEnd();
  }

  private dropItem(client: Client, itemId: string) {
    const p = this.assertMyTurn(client);
    const it = this.state.items.get(itemId);
    if (!it || it.holderSeat !== p.seatIndex) throw new Error("你沒有這件物品");
    it.holderSeat = -1;
    it.coord = p.coord;
    this.maybeEnd();
  }

  private attack(client: Client, m: { targetKind: string; targetId: string }) {
    if (!this.state.hauntRevealed) throw new Error("揭盅前不能動手");
    const p = this.assertMyTurn(client);
    if (m?.targetKind === "MONSTER") {
      const target = this.state.monsters.find((x) => x.id === m.targetId && x.alive);
      if (!target || target.coord !== p.coord) throw new Error("目標不在同一板塊");
      const atk = rollDice(Math.max(p.qili, 1));
      const def = rollDice(Math.max(target.might, 1));
      this.broadcast(ServerMsg.DICE, { seat: p.seatIndex, kind: "攻擊", dice: atk.dice, total: atk.total });
      if (atk.total > def.total) {
        target.alive = false; // 骨架版：怪物被打贏即擊退
        this.log(`${p.name} 擊退了 ${target.name}`);
      } else if (def.total > atk.total) {
        this.applyDelta(p, "qili", -(def.total - atk.total));
        this.log(`${p.name} 反被 ${target.name} 打傷`);
      }
    } else {
      const target = this.state.players.get(String(Number(m?.targetId)));
      if (!target || !target.alive || target.coord !== p.coord) throw new Error("目標不在同一板塊");
      const atk = rollDice(Math.max(p.qili, 1));
      const def = rollDice(Math.max(target.qili, 1));
      this.broadcast(ServerMsg.DICE, { seat: p.seatIndex, kind: "攻擊", dice: atk.dice, total: atk.total });
      const diff = atk.total - def.total;
      if (diff > 0) this.applyDelta(target, "qili", -diff);
      else if (diff < 0) this.applyDelta(p, "qili", diff);
    }
    this.state.stepsLeft = 0; // 攻擊結束移動
    this.maybeEnd();
  }

  private advanceRitual(client: Client, itemId: string) {
    if (!this.state.hauntRevealed) throw new Error("還沒揭盅");
    const p = this.assertMyTurn(client);
    if (p.seatIndex !== this.secrets.trueTraitorSeat) throw new Error("只有做局者能推進大局");
    const tile = this.state.tiles.get(p.coord);
    if (!tile?.ritualRoom) throw new Error("要在密室才行");
    const it = this.state.items.get(itemId);
    if (!it || it.holderSeat !== p.seatIndex || it.kind !== "STAR") throw new Error("手上要有星宿古董");
    this.state.items.delete(itemId);
    this.state.progress++;
    this.log(`一件星宿古董歸位（${this.state.progress}/${this.state.progressMax}）`);
    this.maybeEnd();
  }

  // ---------------------------------------------------------------- turns

  private endTurn(client: Client) {
    const p = this.assertMyTurn(client);
    const isOpenTraitor = this.state.revealedTraitorSeat === p.seatIndex;
    const monstersAlive = this.state.monsters.filter((m) => m.alive).length > 0;

    if (this.state.hauntRevealed && isOpenTraitor && monstersAlive) {
      // 做局者回合後接怪物回合（仍由做局者操作）
      this.state.phase = Phase.MONSTER_TURN;
      // 同種怪物共用一次速度骰，最小 1
      const byType = new Map<string, number>();
      this.state.monsters.forEach((m) => {
        if (!m.alive) return;
        if (!byType.has(m.typeId)) byType.set(m.typeId, Math.max(rollDice(3).total, 1));
        m.speed = byType.get(m.typeId)!;
      });
      this.log("怪物回合開始（由做局者操作）");
      return;
    }
    this.advanceSeat();
  }

  private monsterMove(client: Client, m: { monsterId: string; to: string }) {
    this.assertMonsterTurn(client);
    const mon = this.state.monsters.find((x) => x.id === m?.monsterId && x.alive);
    if (!mon) throw new Error("沒有這隻怪物");
    if (mon.speed <= 0) throw new Error("這隻怪物走完了");
    const target = this.state.tiles.get(m.to);
    if (!target) throw new Error("目標板塊不存在");
    const dir = this.adjacentDir(parseCoord(mon.coord), parseCoord(m.to));
    if (dir === null) throw new Error("不相鄰");
    // 怪物可走一般人走不了的方向：不檢查門，只檢查相鄰
    mon.coord = m.to;
    mon.speed--;
  }

  private monsterAttack(client: Client, m: { monsterId: string; targetSeat: number }) {
    this.assertMonsterTurn(client);
    const mon = this.state.monsters.find((x) => x.id === m?.monsterId && x.alive);
    const target = this.state.players.get(String(m?.targetSeat));
    if (!mon || !target || !target.alive || mon.coord !== target.coord) throw new Error("目標不在同一板塊");
    const atk = rollDice(Math.max(mon.might, 1));
    const def = rollDice(Math.max(target.qili, 1));
    const diff = atk.total - def.total;
    this.broadcast(ServerMsg.DICE, { seat: -1, kind: `${mon.name} 攻擊`, dice: atk.dice, total: atk.total });
    if (diff > 0) this.applyDelta(target, "qili", -diff);
    else if (diff < 0) mon.alive = false;
    mon.speed = 0;
    this.maybeEnd();
  }

  private monsterEnd(client: Client) {
    this.assertMonsterTurn(client);
    this.state.phase = Phase.HAUNT;
    this.advanceSeat();
  }

  private advanceSeat() {
    const seats = this.aliveSeats();
    if (seats.length === 0) return;
    const idx = seats.indexOf(this.state.turnSeat);
    const next = seats[(idx + 1) % seats.length];
    if (next <= this.state.turnSeat) this.state.round++;
    this.state.turnSeat = next;
    this.beginPlayerTurn();
    this.log(`輪到 ${this.currentPlayer().name}`);
  }

  private maybeEnd() {
    if (!this.state.hauntRevealed || !this.scenario || this.state.phase === Phase.GAME_END) return;
    const traitorSeat = this.secrets.trueTraitorSeat;
    const traitor = this.state.players.get(String(traitorSeat));
    let survivorsAlive = 0;
    let evidence = 0;
    this.state.players.forEach((p) => {
      if (p.seatIndex === traitorSeat) return;
      if (p.alive) survivorsAlive++;
    });
    this.state.items.forEach((it) => {
      if (it.kind === "EVIDENCE" && it.holderSeat >= 0 && it.holderSeat !== traitorSeat) {
        const holder = this.state.players.get(String(it.holderSeat));
        if (holder?.alive) evidence++;
      }
    });
    const end = checkEnd({
      scenario: this.scenario,
      progress: this.state.progress,
      traitorAlive: !!traitor?.alive,
      survivorsAlive,
      evidenceHeldBySurvivors: evidence,
    });
    if (end) {
      this.state.phase = Phase.GAME_END;
      this.state.winner = end.winner;
      this.state.endReason = end.reason;
      // 結局時公開真實做局者
      this.state.revealedTraitorSeat = traitorSeat;
      const tp = this.state.players.get(String(traitorSeat));
      if (tp) tp.revealedCamp = "TRAITOR";
      this.broadcast(ServerMsg.GAME_END, { winner: end.winner, reason: end.reason });
      this.log(end.winner === "TRAITOR" ? "大局告成，做局者勝。" : "局被揭穿，生還者勝！");
      getStore().delete(this.state.roomCode).catch(() => {});
    }
  }

  // ---------------------------------------------------------------- snapshot

  private persistDebounced() {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => this.persist().catch(() => {}), 500);
  }

  private async persist(final = false) {
    if (this.state.phase === Phase.GAME_END && !final) return;
    const snapshot: GameSnapshot = {
      version: 1,
      roomCode: this.state.roomCode,
      updatedAt: Date.now(),
      publicState: this.state.toJSON(),
      secrets: {
        trueTraitorSeat: this.secrets.trueTraitorSeat,
        tokenBySeat: this.secrets.tokenBySeat,
        decks: this.secrets.decks,
        seatByName: this.secrets.seatByName,
        secretVariant: this.secrets.secretVariant,
      },
    };
    await getStore().save(snapshot);
  }

  private hydrate(snapshot: GameSnapshot) {
    const s = snapshot.publicState;
    const state = new GameState();
    state.roomCode = s.roomCode;
    state.phase = s.phase;
    state.scenarioId = s.scenarioId;
    state.omenCount = s.omenCount;
    state.hauntRevealed = s.hauntRevealed;
    state.revealedTraitorSeat = s.revealedTraitorSeat;
    state.turnSeat = s.turnSeat;
    state.stepsLeft = s.stepsLeft;
    state.round = s.round;
    state.progress = s.progress;
    state.progressMax = s.progressMax;
    state.progressLabel = s.progressLabel;
    state.winner = s.winner;
    state.endReason = s.endReason;

    for (const [k, pv] of Object.entries<any>(s.players ?? {})) {
      const p = new PlayerState();
      Object.assign(p, pv, { connected: false });
      state.players.set(k, p);
    }
    for (const [k, tv] of Object.entries<any>(s.tiles ?? {})) {
      const t = new TileState();
      Object.assign(t, tv);
      state.tiles.set(k, t);
    }
    for (const [k, iv] of Object.entries<any>(s.items ?? {})) {
      const it = new ItemState();
      Object.assign(it, iv);
      state.items.set(k, it);
    }
    for (const mv of s.monsters ?? []) {
      const m = new MonsterState();
      Object.assign(m, mv);
      state.monsters.push(m);
    }
    this.setState(state);
    this.secrets = {
      ...snapshot.secrets,
      // 舊快照相容：若無 seatByName 則給空物件（舊 token 快照放棄續座，改以名稱重新綁定）
      seatByName: (snapshot.secrets as any).seatByName ?? {},
    };
    if (state.scenarioId) this.scenario = scenarioById(state.scenarioId);
  }

  // ---------------------------------------------------------------- helpers

  private placeTile(def: TileDef, floor: Floor, x: number, y: number, rot: number): TileState {
    const t = new TileState();
    t.defId = def.defId;
    t.name = def.name;
    t.floor = floor;
    t.x = x;
    t.y = y;
    t.doorMask = doorsToMask(rotateDoors(def.doors, Math.max(rot, 0)));
    t.icon = def.icon;
    t.stairs = !!def.stairs;
    t.elevator = !!def.elevator;
    t.ritualRoom = !!def.ritualRoom;
    t.imageUrl = def.imageUrl || "";
    this.state.tiles.set(coordKey(floor, x, y), t);
    return t;
  }

  private adjacentDir(a: { floor: string; x: number; y: number }, b: { floor: string; x: number; y: number }): Dir | null {
    if (a.floor !== b.floor) return null;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    if (dx === 0 && dy === -1) return Dir.N;
    if (dx === 1 && dy === 0) return Dir.E;
    if (dx === 0 && dy === 1) return Dir.S;
    if (dx === -1 && dy === 0) return Dir.W;
    return null;
  }

  private seatOf(client: Client): number {
    const seat = this.seatBySession.get(client.sessionId);
    if (seat === undefined) throw new Error("尚未入座");
    return seat;
  }

  private assertSeat(client: Client, seat: number) {
    if (this.seatOf(client) !== seat) throw new Error("只有房主能執行這個動作");
  }

  private assertMyTurn(client: Client): PlayerState {
    if (this.state.phase !== Phase.EXPLORATION && this.state.phase !== Phase.HAUNT) {
      throw new Error("現在不是行動階段");
    }
    const seat = this.seatOf(client);
    if (seat !== this.state.turnSeat) throw new Error("還沒輪到你");
    const p = this.state.players.get(String(seat));
    if (!p?.alive) throw new Error("你已出局");
    return p;
  }

  private assertMonsterTurn(client: Client) {
    if (this.state.phase !== Phase.MONSTER_TURN) throw new Error("現在不是怪物回合");
    if (this.seatOf(client) !== this.state.revealedTraitorSeat) throw new Error("怪物由做局者操作");
  }

  private aliveSeats(): number[] {
    const seats: number[] = [];
    this.state.players.forEach((p) => {
      if (p.alive) seats.push(p.seatIndex);
    });
    return seats.sort((a, b) => a - b);
  }

  private firstAliveSeat(): number {
    return this.aliveSeats()[0] ?? -1;
  }

  private currentPlayer(): PlayerState {
    return this.state.players.get(String(this.state.turnSeat))!;
  }

  private nextFreeSeat(): number {
    for (let i = 0; i < this.maxClients; i++) {
      if (!this.state.players.get(String(i))) return i;
    }
    return -1;
  }

  private log(text: string) {
    this.broadcast(ServerMsg.LOG, { text });
  }
}

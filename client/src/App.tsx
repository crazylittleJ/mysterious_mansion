import { useEffect, useMemo, useRef, useState, lazy, Suspense } from "react";
import { Client, Room } from "colyseus.js";

// Pixi 較重（約 190KB gzip），只在切到「動畫」模式時才載入
const PixiBoard = lazy(() => import("./PixiBoard"));

/** 與 server events.ts 對齊的封閉集合 */
const Intent = {
  START_GAME: "START_GAME", MOVE: "MOVE", EXPLORE: "EXPLORE", USE_STAIRS: "USE_STAIRS",
  PICK_ITEM: "PICK_ITEM", DROP_ITEM: "DROP_ITEM", ATTACK: "ATTACK", END_TURN: "END_TURN",
  DRAW_TOKEN: "DRAW_TOKEN", CONFIRM_TOKEN: "CONFIRM_TOKEN", SELF_REVEAL: "SELF_REVEAL",
  ADVANCE_RITUAL: "ADVANCE_RITUAL", MONSTER_MOVE: "MONSTER_MOVE",
  MONSTER_ATTACK: "MONSTER_ATTACK", MONSTER_END: "MONSTER_END",
} as const;

const FLOORS = ["UPPER", "GROUND", "BASEMENT"] as const;
const FLOOR_NAME: Record<string, string> = { UPPER: "暗間（樓上）", GROUND: "明面（一樓）", BASEMENT: "地窖" };
const STAT_NAME: Record<string, string> = { yanli: "眼力", shoufa: "手法", xinxing: "心性", qili: "氣力" };
const DIR_NAME = ["北", "東", "南", "西"];
const TILE = 96;

function wsEndpoint(): string {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  const host = location.port === "5173" ? "localhost:2567" : location.host; // vite dev → 本機 server
  return `${proto}://${host}`;
}

interface LogEntry { text: string; dice?: boolean }

export default function App() {
  const [room, setRoom] = useState<Room | null>(null);
  const [snap, setSnap] = useState<any>(null);
  const [mySeat, setMySeat] = useState(-1);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [err, setErr] = useState("");
  const [tokenNumber, setTokenNumber] = useState<number | null>(null);
  const [objectives, setObjectives] = useState<{ camp: string; objective: string }[]>([]);
  const logRef = useRef<HTMLDivElement>(null);

  const [name, setName] = useState(localStorage.getItem("gudong-name") || "");
  const [code, setCode] = useState("");
  const [secretVariant, setSecretVariant] = useState(true);
  const [boardMode, setBoardMode] = useState<"svg" | "pixi">(
    (localStorage.getItem("gudong-board") as "svg" | "pixi") || "svg"
  );
  const setBoard = (m: "svg" | "pixi") => {
    setBoardMode(m);
    localStorage.setItem("gudong-board", m);
  };

  const pushLog = (e: LogEntry) => setLogs((l) => [...l.slice(-200), e]);

  async function join() {
    setErr("");
    const cleanName = name.trim();
    if (!cleanName) {
      setErr("請先輸入名號");
      return;
    }
    try {
      const client = new Client(wsEndpoint());
      localStorage.setItem("gudong-name", cleanName);
      const r = await client.joinOrCreate("gudong-betrayal", {
        roomCode: code.trim().toUpperCase(),
        name: cleanName, // 以名稱作為玩家識別
        secretVariant,
      });
      wire(r);
      setRoom(r);
    } catch (e: any) {
      setErr(String(e?.message || e));
    }
  }

  function wire(r: Room) {
    r.onStateChange(() => setSnap((r.state as any).toJSON()));
    // server 入座/重連後直接告知座位，不再靠 log 猜
    r.onMessage("YOUR_SEAT", (m: any) => setMySeat(m.seat));
    r.onMessage("LOG", (m: any) => pushLog({ text: m.text }));
    r.onMessage("DICE", (m: any) =>
      pushLog({ text: `🎲 ${m.kind}：[${m.dice.join(" ")}] 合計 ${m.total}`, dice: true })
    );
    r.onMessage("YOUR_TOKEN", (m: any) => setTokenNumber(m.number));
    r.onMessage("YOUR_OBJECTIVE", (m: any) =>
      setObjectives((o) => (o.some((x) => x.camp === m.camp) ? o : [...o, m]))
    );
    r.onMessage("GAME_END", () => {});
    r.onMessage("ERROR", (m: any) => pushLog({ text: `⚠ ${m.message}` }));
    r.onLeave(() => pushLog({ text: "連線中斷，可用同一名號與房間代碼續玩" }));
  }

  useEffect(() => {
    logRef.current?.scrollTo(0, 999999);
  }, [logs]);

  const me = snap?.players?.[String(mySeat)];
  const myTurn = snap && snap.turnSeat === mySeat && (snap.phase === "EXPLORATION" || snap.phase === "HAUNT");
  const amITraitor = objectives.some((o) => o.camp === "TRAITOR");
  const isRevealedTraitor = snap?.revealedTraitorSeat === mySeat;

  const send = (type: string, msg?: any) => room?.send(type, msg);

  const tilesByFloor = useMemo(() => {
    const byFloor: Record<string, { key: string; t: any }[]> = { UPPER: [], GROUND: [], BASEMENT: [] };
    if (snap?.tiles) {
      for (const [key, t] of Object.entries<any>(snap.tiles)) byFloor[t.floor]?.push({ key, t });
    }
    return byFloor;
  }, [snap]);

  if (!room || !snap) {
    return (
      <div className="app">
        <div className="lobby-scroll">
          <div className="cover">
            <img src="/cover.jpg" alt="神秘古宅" />
          </div>

          <div className="lobby">
            <h1>神秘古宅</h1>
            <div className="sub">九星連珠・古董局中局暗局 v0.1</div>

            <label>
              名號（作為你的身分識別，同名即同一人）
              <input value={name} onChange={(e) => setName(e.target.value)} placeholder="鑑寶人名號" maxLength={12} />
            </label>
            <label>
              房間代碼（同代碼即同一局；輸入舊代碼＋原名號可續玩存檔）
              <input value={code} onChange={(e) => setCode(e.target.value)} placeholder="例如 JIU-XING" />
            </label>
            <label style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
              <input type="checkbox" checked={secretVariant} onChange={(e) => setSecretVariant(e.target.checked)} style={{ width: "auto" }} />
              暗局模式（秘密做局者・水滴儀式）
            </label>
            <button className="primary" onClick={join} disabled={!code.trim() || !name.trim()}>入宅</button>
            <div className="err">{err}</div>
          </div>

          <GameGuide />
        </div>
      </div>
    );
  }

  return (
    <div className="app">
      <div className="topbar">
        <h1>神秘古宅</h1>
        <span className="code">房號 {snap.roomCode}｜第 {snap.round} 輪</span>
        <div className="board-toggle">
          <button className={boardMode === "svg" ? "on" : ""} onClick={() => setBoard("svg")}>圖示</button>
          <button className={boardMode === "pixi" ? "on" : ""} onClick={() => setBoard("pixi")}>動畫</button>
        </div>
        <span className="phase">{phaseName(snap.phase)}</span>
      </div>

      {snap.phase === "GAME_END" && (
        <div className="endbanner">
          {snap.winner === "TRAITOR" ? "大局告成・做局者勝" : "局破・生還者勝"}（{snap.endReason}）
        </div>
      )}

      <div className="main">
        <div className="board">
          {boardMode === "pixi" ? (
            <Suspense fallback={<div className="floor-label">載入畫布…</div>}>
              <PixiBoard
                snap={snap}
                mySeat={mySeat}
                myTurn={!!myTurn}
                onMoveTo={(key, sameFloor) => send(sameFloor ? Intent.MOVE : Intent.USE_STAIRS, { to: key })}
              />
            </Suspense>
          ) : (
            FLOORS.map((f) => (
              <div key={f}>
                <div className="floor-label">{FLOOR_NAME[f]}</div>
                <FloorMap
                  floor={f}
                  tiles={tilesByFloor[f]}
                  snap={snap}
                  mySeat={mySeat}
                  myTurn={!!myTurn}
                  onMoveTo={(key, sameFloor) => send(sameFloor ? Intent.MOVE : Intent.USE_STAIRS, { to: key })}
                />
              </div>
            ))
          )}
        </div>

        <div className="side">
          {snap.hauntRevealed && snap.progressMax > 0 && (
            <div className="panel">
              <h2>{snap.progressLabel}</h2>
              <div className="progress">
                {Array.from({ length: snap.progressMax }, (_, i) => (
                  <div key={i} className={`star ${i < snap.progress ? "on" : ""}`} />
                ))}
                <span style={{ marginLeft: 8 }}>{snap.progress}/{snap.progressMax}</span>
              </div>
            </div>
          )}

          <div className="panel">
            <h2>眾人</h2>
            <div className="players">
              {Object.values<any>(snap.players || {})
                .sort((a, b) => a.seatIndex - b.seatIndex)
                .map((p) => (
                  <div key={p.seatIndex} className={`p ${p.seatIndex === mySeat ? "me" : ""}`}>
                    <span className="nm">{p.seatIndex + 1}. {p.name}</span>
                    {p.revealedCamp === "TRAITOR" && <span className="camp">做局者</span>}
                    {snap.turnSeat === p.seatIndex && snap.phase !== "LOBBY" && <span className="turn">◈ 行動中</span>}
                    {!p.connected && <span className="off">（離線）</span>}
                    {!p.alive && <span className="off">（出局）</span>}
                  </div>
                ))}
            </div>
          </div>

          {me && (
            <div className="panel">
              <h2>我的屬性{myTurn ? `・剩 ${snap.stepsLeft} 步` : ""}</h2>
              <div className="stats">
                {(["yanli", "shoufa", "xinxing", "qili"] as const).map((k) => (
                  <div key={k} className="stat">
                    <div className="v">{me[k]}</div>
                    <div className="k">{STAT_NAME[k]}</div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {objectives.map((o) => (
            <div className="panel" key={o.camp}>
              <h2>{o.camp === "TRAITOR" ? "做局者之書" : "生存秘笈"}</h2>
              <div className={`objective ${o.camp === "TRAITOR" ? "" : "hero"}`}>{o.objective}</div>
            </div>
          ))}

          <div className="panel">
            <h2>行動</h2>
            <ActionBar
              snap={snap} me={me} mySeat={mySeat} myTurn={!!myTurn}
              amITraitor={amITraitor} isRevealedTraitor={isRevealedTraitor} send={send}
            />
          </div>

          <div className="log" ref={logRef}>
            {logs.map((l, i) => (
              <div key={i} className={`entry ${l.dice ? "dice" : ""}`}>{l.text}</div>
            ))}
          </div>
        </div>
      </div>

      {snap.phase === "HAUNT_RITUAL" && me && (
        <div className="ritual-overlay">
          <div className="ritual">
            <h2>水滴儀式</h2>
            <div className="hint">揭盅了。每人抽取一枚標記，只有自己看得到號碼。<br />抽到「1」的人，就是做局者。收好，別讓任何人看見。</div>
            {!me.tokenDrawn ? (
              <button className="primary" onClick={() => send(Intent.DRAW_TOKEN)}>抽取標記</button>
            ) : (
              <>
                <div className="token">{tokenNumber ?? "…"}</div>
                {!me.tokenConfirmed ? (
                  <button className="primary" onClick={() => send(Intent.CONFIRM_TOKEN)}>我已收好</button>
                ) : (
                  <div className="hint">等待其他人收好標記……</div>
                )}
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function GameGuide() {
  return (
    <div className="guide">
      <h2>遊戲說明</h2>

      <h3>這是什麼</h3>
      <p>
        2～5 人的合作／背叛桌遊。眾人受邀踏入「神秘古宅」尋寶，一邊探索房間、一邊抽牌，
        直到「預兆」累積觸發<b>揭盅</b>：其中一人其實是<b>做局者</b>，古宅就此分裂成
        生還者 對 做局者 的對抗。
      </p>

      <h3>怎麼開始</h3>
      <ol>
        <li>填<b>名號</b>（就是你的身分，同名視為同一人；斷線後用同名號＋同房號回到原座）。</li>
        <li>填<b>房間代碼</b>：同代碼的人會進到同一局。第一個進來的人是房主。</li>
        <li>房主按「開局」（需 2 人以上）。輸入舊房號可續玩 24 小時內的存檔。</li>
      </ol>

      <h3>你的四項屬性</h3>
      <p>眼力・手法・心性・氣力。降到 0 就出局；抽牌與檢定會讓數值增減。</p>

      <h3>回合裡能做的事</h3>
      <ul>
        <li><b>探索</b>（探北/東/南/西）：從有門的方向翻開新房間；翻到帶圖示的房間會抽牌並結束移動。</li>
        <li><b>移動</b>：點地圖上相鄰、有門相連的房間。樓梯／電梯可換樓層。</li>
        <li><b>拾取／放下</b>腳下的物品。</li>
        <li>揭盅後才能<b>攻擊</b>同房間的人或怪物。</li>
        <li><b>結束回合</b>交給下一位。</li>
      </ul>

      <h3>揭盅與勝負</h3>
      <ul>
        <li><b>暗局模式</b>（預設開）：揭盅走「水滴儀式」，每人暗抽一枚標記，抽到「1」的就是做局者，
          身分保密，開始使用優勢前必須先亮明身分。</li>
        <li><b>做局者</b>：湊齊 9 件星宿古董送進密室完成大局，或讓生還者全滅。</li>
        <li><b>生還者</b>：集齊證據揭穿騙局，或讓做局者出局。</li>
      </ul>

      <h3>畫面切換</h3>
      <p>右上角「圖示／動畫」可切換 SVG 地圖與 PixiJS 畫布（美術強化版）。</p>
    </div>
  );
}

function phaseName(p: string) {
  return ({
    LOBBY: "候客", EXPLORATION: "尋寶", HAUNT_RITUAL: "水滴儀式",
    HAUNT: "揭盅", MONSTER_TURN: "門徒回合", GAME_END: "終局",
  } as Record<string, string>)[p] || p;
}

function FloorMap(props: {
  floor: string;
  tiles: { key: string; t: any }[];
  snap: any;
  mySeat: number;
  myTurn: boolean;
  onMoveTo: (key: string, sameFloor: boolean) => void;
}) {
  const { tiles, snap, mySeat, myTurn, onMoveTo } = props;
  if (tiles.length === 0) return <svg width={TILE} height={TILE / 2} />;
  const xs = tiles.map(({ t }) => t.x);
  const ys = tiles.map(({ t }) => t.y);
  const minX = Math.min(...xs), minY = Math.min(...ys);
  const w = (Math.max(...xs) - minX + 1) * TILE + 8;
  const h = (Math.max(...ys) - minY + 1) * TILE + 8;
  const me = snap.players?.[String(mySeat)];

  return (
    <svg width={w} height={h} style={{ display: "block" }}>
      {tiles.map(({ key, t }) => {
        const px = (t.x - minX) * TILE + 4;
        const py = (t.y - minY) * TILE + 4;
        const pawns = Object.values<any>(snap.players || {}).filter((p) => p.coord === key && p.alive);
        const monsters = (snap.monsters || []).filter((m: any) => m.coord === key && m.alive);
        const groundItems = Object.values<any>(snap.items || {}).filter((it) => it.holderSeat === -1 && it.coord === key);
        const clickable = myTurn && me && me.coord !== key;
        return (
          <g key={key} onClick={() => clickable && onMoveTo(key, t.floor === (me?.coord || "").split(":")[0])}
             style={{ cursor: clickable ? "pointer" : "default" }}>
            <rect x={px} y={py} width={TILE - 8} height={TILE - 8}
              fill={t.ritualRoom ? "#3a1f1a" : "#2a2018"} stroke={me?.coord === key ? "#c9a253" : "#4a3b2c"} strokeWidth={me?.coord === key ? 2 : 1} />
            {/* 門：四邊小缺口 */}
            {[0, 1, 2, 3].map((d) =>
              (t.doorMask & (1 << d)) ? <DoorMark key={d} d={d} px={px} py={py} /> : null
            )}
            <text x={px + (TILE - 8) / 2} y={py + 16} textAnchor="middle" fill="#e8dcc3" fontSize={11}>{t.name}</text>
            {t.icon !== "NONE" && (
              <text x={px + TILE - 20} y={py + TILE - 16} fontSize={10} fill="#b3a684">
                {t.icon === "OMEN" ? "兆" : t.icon === "ITEM" ? "物" : "事"}
              </text>
            )}
            {(t.stairs || t.elevator) && (
              <text x={px + 10} y={py + TILE - 16} fontSize={10} fill="#4f7a6a">{t.elevator ? "梯機" : "階"}</text>
            )}
            {groundItems.slice(0, 3).map((it, i) => (
              <text key={it.id} x={px + 10 + i * 14} y={py + 34} fontSize={11}
                fill={it.kind === "STAR" ? "#c9a253" : it.kind === "EVIDENCE" ? "#4f7a6a" : "#b3a684"}>
                {it.kind === "STAR" ? "★" : it.kind === "EVIDENCE" ? "證" : "◇"}
              </text>
            ))}
            {pawns.map((p, i) => (
              <g key={p.seatIndex}>
                <circle cx={px + 16 + i * 18} cy={py + TILE - 32} r={8}
                  fill={p.revealedCamp === "TRAITOR" ? "#b03a2e" : "#4f7a6a"} stroke="#e8dcc3" strokeWidth={0.5} />
                <text x={px + 16 + i * 18} y={py + TILE - 28} textAnchor="middle" fontSize={9} fill="#e8dcc3">{p.seatIndex + 1}</text>
              </g>
            ))}
            {monsters.map((m: any, i: number) => (
              <text key={m.id} x={px + TILE - 24 - i * 12} y={py + TILE - 30} fontSize={12} fill="#b03a2e">卒</text>
            ))}
          </g>
        );
      })}
    </svg>
  );
}

function DoorMark({ d, px, py }: { d: number; px: number; py: number }) {
  const s = TILE - 8;
  const c = s / 2;
  const props = { fill: "#c9a253" } as const;
  if (d === 0) return <rect x={px + c - 6} y={py - 1} width={12} height={3} {...props} />;
  if (d === 1) return <rect x={px + s - 2} y={py + c - 6} width={3} height={12} {...props} />;
  if (d === 2) return <rect x={px + c - 6} y={py + s - 2} width={12} height={3} {...props} />;
  return <rect x={px - 1} y={py + c - 6} width={3} height={12} {...props} />;
}

function ActionBar(props: {
  snap: any; me: any; mySeat: number; myTurn: boolean;
  amITraitor: boolean; isRevealedTraitor: boolean;
  send: (t: string, m?: any) => void;
}) {
  const { snap, me, mySeat, myTurn, amITraitor, isRevealedTraitor, send } = props;

  if (snap.phase === "LOBBY") {
    return (
      <div className="actions">
        {mySeat === 0
          ? <button className="primary" onClick={() => send(Intent.START_GAME)}>開局（{Object.keys(snap.players || {}).length} 人）</button>
          : <span style={{ color: "var(--paper-dim)", fontSize: 13 }}>等房主開局……</span>}
      </div>
    );
  }

  if (snap.phase === "MONSTER_TURN" && isRevealedTraitor) {
    const monsters = (snap.monsters || []).filter((m: any) => m.alive);
    return (
      <div className="actions" style={{ flexDirection: "column", alignItems: "stretch", gap: 8 }}>
        {monsters.map((m: any) => (
          <MonsterControls key={m.id} m={m} snap={snap} send={send} />
        ))}
        <button className="primary" onClick={() => send(Intent.MONSTER_END)}>結束怪物回合</button>
      </div>
    );
  }

  if (!me || !myTurn) return <div style={{ color: "var(--paper-dim)", fontSize: 13 }}>等待他人行動……</div>;

  const myItems = Object.values<any>(snap.items || {}).filter((it) => it.holderSeat === mySeat);
  const groundItems = Object.values<any>(snap.items || {}).filter((it) => it.holderSeat === -1 && it.coord === me.coord);
  const targetsHere = Object.values<any>(snap.players || {}).filter((p) => p.alive && p.seatIndex !== mySeat && p.coord === me.coord);
  const monstersHere = (snap.monsters || []).filter((m: any) => m.alive && m.coord === me.coord);
  const onRitualRoom = snap.tiles?.[me.coord]?.ritualRoom;
  const myStars = myItems.filter((it) => it.kind === "STAR");

  return (
    <div className="actions" style={{ flexDirection: "column", alignItems: "stretch", gap: 8 }}>
      <div className="actions">
        {DIR_NAME.map((n, d) => (
          <button key={d} disabled={snap.stepsLeft <= 0} onClick={() => send(Intent.EXPLORE, { dir: d })}>探{n}</button>
        ))}
      </div>
      <div className="actions">
        {groundItems.map((it) => (
          <button key={it.id} onClick={() => send(Intent.PICK_ITEM, { itemId: it.id })}>拾「{it.name}」</button>
        ))}
        {snap.hauntRevealed && targetsHere.map((p) => (
          <button key={p.seatIndex} onClick={() => send(Intent.ATTACK, { targetKind: "PLAYER", targetId: String(p.seatIndex) })}>攻擊 {p.name}</button>
        ))}
        {snap.hauntRevealed && monstersHere.map((m: any) => (
          <button key={m.id} onClick={() => send(Intent.ATTACK, { targetKind: "MONSTER", targetId: m.id })}>攻擊 {m.name}</button>
        ))}
        {amITraitor && onRitualRoom && myStars.map((it) => (
          <button key={it.id} className="primary" onClick={() => send(Intent.ADVANCE_RITUAL, { itemId: it.id })}>交付「{it.name}」</button>
        ))}
        {amITraitor && snap.revealedTraitorSeat === -1 && snap.hauntRevealed && (
          <button onClick={() => send(Intent.SELF_REVEAL)}>亮明身分</button>
        )}
      </div>
      {myItems.length > 0 && (
        <div style={{ fontSize: 12, color: "var(--paper-dim)" }}>
          持有：{myItems.map((it) => it.name).join("、")}
        </div>
      )}
      <button className="primary" onClick={() => send(Intent.END_TURN)}>結束回合</button>
    </div>
  );
}

function MonsterControls({ m, snap, send }: { m: any; snap: any; send: (t: string, x?: any) => void }) {
  const [floor, xy] = m.coord.split(":");
  const [x, y] = xy.split(",").map(Number);
  const adj = [
    { n: "北", k: `${floor}:${x},${y - 1}` }, { n: "東", k: `${floor}:${x + 1},${y}` },
    { n: "南", k: `${floor}:${x},${y + 1}` }, { n: "西", k: `${floor}:${x - 1},${y}` },
  ].filter((a) => snap.tiles?.[a.k]);
  const targets = Object.values<any>(snap.players || {}).filter((p) => p.alive && p.coord === m.coord);
  return (
    <div style={{ border: "1px solid var(--line)", padding: 6 }}>
      <div style={{ fontSize: 12, marginBottom: 4 }}>{m.name}（剩 {m.speed} 步・於 {snap.tiles?.[m.coord]?.name}）</div>
      <div className="actions">
        {adj.map((a) => (
          <button key={a.k} disabled={m.speed <= 0} onClick={() => send(Intent.MONSTER_MOVE, { monsterId: m.id, to: a.k })}>{a.n}</button>
        ))}
        {targets.map((p) => (
          <button key={p.seatIndex} onClick={() => send(Intent.MONSTER_ATTACK, { monsterId: m.id, targetSeat: p.seatIndex })}>咬 {p.name}</button>
        ))}
      </div>
    </div>
  );
}

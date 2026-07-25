import { useEffect, useMemo, useRef, useState } from "react";
import { Client, Room } from "colyseus.js";

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

function tokenForBrowser(): string {
  const k = "gudong-player-token";
  let t = localStorage.getItem(k);
  if (!t) {
    t = Math.random().toString(36).slice(2) + Date.now().toString(36);
    localStorage.setItem(k, t);
  }
  return t;
}

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

  const pushLog = (e: LogEntry) => setLogs((l) => [...l.slice(-200), e]);

  async function join() {
    setErr("");
    try {
      const client = new Client(wsEndpoint());
      const playerToken = tokenForBrowser();
      localStorage.setItem("gudong-name", name);
      const r = await client.joinOrCreate("gudong-betrayal", {
        roomCode: code.trim().toUpperCase(),
        playerToken,
        name: name || undefined,
        secretVariant,
      });
      wire(r, playerToken);
      setRoom(r);
    } catch (e: any) {
      setErr(String(e?.message || e));
    }
  }

  function wire(r: Room, playerToken: string) {
    r.onStateChange(() => {
      const s = (r.state as any).toJSON();
      setSnap(s);
      // 用 playerToken 對不到座位（token 只在 server），改用姓名不可靠 → server 以 session 綁定，
      // 這裡從 players 裡找 connected 且 sessionId 無從得知，故由入座訊息推斷：seatIndex 記在 localStorage
      const savedSeat = localStorage.getItem(`gudong-seat-${s.roomCode}`);
      if (savedSeat !== null) setMySeat(Number(savedSeat));
    });
    r.onMessage("LOG", (m: any) => {
      pushLog({ text: m.text });
      // 入座訊息帶座位資訊：`XX 入座（座位 N）`——僅在自己剛入座且尚無座位時記錄
      const match = /入座（座位 (\d+)）/.exec(m.text || "");
      if (match && localStorage.getItem(`gudong-seat-${(r.state as any).roomCode}`) === null) {
        // 最後入座的是自己（server 依 join 順序廣播）
        localStorage.setItem(`gudong-seat-${(r.state as any).roomCode}`, String(Number(match[1]) - 1));
        setMySeat(Number(match[1]) - 1);
      }
    });
    r.onMessage("DICE", (m: any) =>
      pushLog({ text: `🎲 ${m.kind}：[${m.dice.join(" ")}] 合計 ${m.total}`, dice: true })
    );
    r.onMessage("YOUR_TOKEN", (m: any) => setTokenNumber(m.number));
    r.onMessage("YOUR_OBJECTIVE", (m: any) =>
      setObjectives((o) => (o.some((x) => x.camp === m.camp) ? o : [...o, m]))
    );
    r.onMessage("GAME_END", () => {});
    r.onMessage("ERROR", (m: any) => pushLog({ text: `⚠ ${m.message}` }));
    r.onLeave(() => pushLog({ text: "連線中斷，可重新加入同一房間代碼續玩" }));
    void playerToken;
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
        <div className="lobby">
          <h1>九星連珠</h1>
          <div className="sub">古董局中局・暗局骨架 v0.1</div>
          <label>
            名號
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="鑑寶人名號" maxLength={12} />
          </label>
          <label>
            房間代碼（同代碼即同一局；輸入舊代碼可續玩存檔）
            <input value={code} onChange={(e) => setCode(e.target.value)} placeholder="例如 JIU-XING" />
          </label>
          <label style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
            <input type="checkbox" checked={secretVariant} onChange={(e) => setSecretVariant(e.target.checked)} style={{ width: "auto" }} />
            暗局模式（秘密做局者・水滴儀式）
          </label>
          <button className="primary" onClick={join} disabled={!code.trim()}>入宅</button>
          <div className="err">{err}</div>
        </div>
      </div>
    );
  }

  return (
    <div className="app">
      <div className="topbar">
        <h1>九星連珠</h1>
        <span className="code">房號 {snap.roomCode}｜第 {snap.round} 輪</span>
        <span className="phase">{phaseName(snap.phase)}</span>
      </div>

      {snap.phase === "GAME_END" && (
        <div className="endbanner">
          {snap.winner === "TRAITOR" ? "大局告成・做局者勝" : "局破・生還者勝"}（{snap.endReason}）
        </div>
      )}

      <div className="main">
        <div className="board">
          {FLOORS.map((f) => (
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
          ))}
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

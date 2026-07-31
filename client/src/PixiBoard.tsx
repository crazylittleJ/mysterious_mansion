import { useEffect, useRef } from "react";
import { Application, Container, Graphics, Text, Sprite, Texture, Assets } from "pixi.js";

/**
 * PixiJS board — 美術可擴充的畫布骨架。
 *
 * 目前用 Graphics 畫佔位方塊；要換成美術資源時，只需在標了 [ART] 的地方
 * 把佔位圖形換成 Sprite/Texture 即可（板塊、棋子、怪物、物品都已預留掛點）。
 *
 * 座標系：沿用 server 的 coordKey「FLOOR:x,y」。三個樓層垂直堆疊在同一張畫布，
 * 每層自算 bounding box。點擊板塊 → onMoveTo(key, sameFloor)，與 SVG 版一致
 * （sameFloor=true 走 MOVE、false 走 USE_STAIRS）。
 */

const TILE = 108; // 板塊像素邊長
const GAP = 6; // 板塊間距
const PAD = 12;
const LABEL_H = 26;
const FLOORS = ["UPPER", "GROUND", "BASEMENT"] as const;
const FLOOR_NAME: Record<string, string> = {
  UPPER: "暗間（樓上）",
  GROUND: "明面（一樓）",
  BASEMENT: "地窖",
};

// 主題色（與 style.css 對齊）
const COLOR = {
  bg: 0x1b1410,
  tile: 0x2a2018,
  ritual: 0x3a1f1a,
  line: 0x4a3b2c,
  gilt: 0xc9a253,
  paper: 0xe8dcc3,
  paperDim: 0xb3a684,
  cinnabar: 0xb03a2e,
  jade: 0x4f7a6a,
};

interface Props {
  snap: any;
  mySeat: number;
  myTurn: boolean;
  onMoveTo: (key: string, sameFloor: boolean) => void;
}

/** [ART] 板塊貼圖快取。tile.imageUrl 有值時載入為 Texture，之後畫成 Sprite。 */
const textureCache = new Map<string, Texture>();
async function loadTexture(url: string): Promise<Texture | null> {
  if (!url) return null;
  if (textureCache.has(url)) return textureCache.get(url)!;
  try {
    const tex = await Assets.load(url);
    textureCache.set(url, tex);
    return tex;
  } catch {
    return null;
  }
}

export default function PixiBoard({ snap, mySeat, myTurn, onMoveTo }: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const appRef = useRef<Application | null>(null);
  const layerRef = useRef<Container | null>(null);
  const readyRef = useRef(false);
  // 用 ref 保存最新 props，redraw 時取用（避免 Pixi app 反覆重建）
  const stateRef = useRef({ snap, mySeat, myTurn, onMoveTo });
  stateRef.current = { snap, mySeat, myTurn, onMoveTo };

  // 掛載一次 Pixi Application
  useEffect(() => {
    let disposed = false;
    const app = new Application();
    appRef.current = app;

    app
      .init({ background: COLOR.bg, antialias: true, resolution: window.devicePixelRatio || 1, autoDensity: true })
      .then(() => {
        if (disposed) {
          app.destroy(true);
          return;
        }
        hostRef.current?.appendChild(app.canvas);
        const root = new Container();
        app.stage.addChild(root);
        layerRef.current = root;
        readyRef.current = true;
        redraw();
      });

    return () => {
      disposed = true;
      readyRef.current = false;
      try {
        app.destroy(true, { children: true });
      } catch {
        /* noop */
      }
      appRef.current = null;
      layerRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // snap 變動就重畫
  useEffect(() => {
    if (readyRef.current) redraw();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [snap, mySeat, myTurn]);

  function redraw() {
    const app = appRef.current;
    const root = layerRef.current;
    if (!app || !root) return;
    root.removeChildren();

    const { snap, mySeat, myTurn, onMoveTo } = stateRef.current;
    const me = snap?.players?.[String(mySeat)];
    const myFloor = (me?.coord || "").split(":")[0];

    // 依樓層分組
    const byFloor: Record<string, { key: string; t: any }[]> = { UPPER: [], GROUND: [], BASEMENT: [] };
    if (snap?.tiles) {
      for (const [key, t] of Object.entries<any>(snap.tiles)) byFloor[(t as any).floor]?.push({ key, t });
    }

    let yCursor = PAD;
    let maxW = 320;

    for (const floor of FLOORS) {
      const tiles = byFloor[floor];

      // 樓層標題
      const label = new Text({
        text: FLOOR_NAME[floor],
        style: { fill: COLOR.paperDim, fontSize: 13, letterSpacing: 4, fontFamily: "Noto Serif TC, serif" },
      });
      label.x = PAD;
      label.y = yCursor;
      root.addChild(label);
      yCursor += LABEL_H;

      if (tiles.length === 0) {
        const empty = new Text({
          text: "（尚未探索）",
          style: { fill: COLOR.line, fontSize: 12, fontFamily: "serif" },
        });
        empty.x = PAD;
        empty.y = yCursor;
        root.addChild(empty);
        yCursor += TILE / 2;
        continue;
      }

      const xs = tiles.map(({ t }) => t.x);
      const ys = tiles.map(({ t }) => t.y);
      const minX = Math.min(...xs);
      const minY = Math.min(...ys);
      const cols = Math.max(...xs) - minX + 1;
      const rows = Math.max(...ys) - minY + 1;

      const floorLayer = new Container();
      floorLayer.x = PAD;
      floorLayer.y = yCursor;
      root.addChild(floorLayer);

      for (const { key, t } of tiles) {
        const px = (t.x - minX) * (TILE + GAP);
        const py = (t.y - minY) * (TILE + GAP);
        const isMine = me?.coord === key;
        const sameFloor = t.floor === myFloor;
        const clickable = myTurn && me && !isMine;

        const cell = new Container();
        cell.x = px;
        cell.y = py;
        floorLayer.addChild(cell);

        // [ART] 板塊底：有 imageUrl → Sprite；否則佔位方塊
        if (t.imageUrl) {
          const sprite = new Sprite(Texture.EMPTY);
          sprite.width = TILE;
          sprite.height = TILE;
          cell.addChildAt(sprite, 0);
          loadTexture(t.imageUrl).then((tex) => {
            if (tex && !cell.destroyed) sprite.texture = tex;
          });
        }
        const base = new Graphics()
          .roundRect(0, 0, TILE, TILE, 6)
          .fill({ color: t.ritualRoom ? COLOR.ritual : COLOR.tile, alpha: t.imageUrl ? 0.15 : 1 })
          .stroke({ width: isMine ? 3 : 1, color: isMine ? COLOR.gilt : COLOR.line });
        cell.addChild(base);

        // 門：四邊描金小段
        drawDoors(cell, t.doorMask);

        // 板塊名
        const name = new Text({
          text: t.name,
          style: { fill: COLOR.paper, fontSize: 12, fontFamily: "Noto Serif TC, serif", align: "center" },
        });
        name.anchor.set(0.5, 0);
        name.x = TILE / 2;
        name.y = 8;
        cell.addChild(name);

        // 圖示（兆/物/事）
        if (t.icon && t.icon !== "NONE") {
          const icon = new Text({
            text: t.icon === "OMEN" ? "兆" : t.icon === "ITEM" ? "物" : "事",
            style: { fill: COLOR.paperDim, fontSize: 12, fontFamily: "serif" },
          });
          icon.x = TILE - 20;
          icon.y = TILE - 22;
          cell.addChild(icon);
        }
        // 樓梯/電梯
        if (t.stairs || t.elevator) {
          const s = new Text({
            text: t.elevator ? "梯機" : "階",
            style: { fill: COLOR.jade, fontSize: 11, fontFamily: "serif" },
          });
          s.x = 8;
          s.y = TILE - 22;
          cell.addChild(s);
        }

        // [ART] 地上物品（星宿古董/證據/一般）
        const groundItems = Object.values<any>(snap.items || {}).filter(
          (it) => it.holderSeat === -1 && it.coord === key
        );
        groundItems.slice(0, 4).forEach((it, i) => {
          const mark = new Text({
            text: it.kind === "STAR" ? "★" : it.kind === "EVIDENCE" ? "證" : "◇",
            style: {
              fill: it.kind === "STAR" ? COLOR.gilt : it.kind === "EVIDENCE" ? COLOR.jade : COLOR.paperDim,
              fontSize: 13,
              fontFamily: "serif",
            },
          });
          mark.x = 10 + i * 16;
          mark.y = 26;
          cell.addChild(mark);
        });

        // [ART] 玩家棋子
        const pawns = Object.values<any>(snap.players || {}).filter((p) => p.coord === key && p.alive);
        pawns.forEach((p, i) => {
          const g = new Graphics()
            .circle(0, 0, 9)
            .fill({ color: p.revealedCamp === "TRAITOR" ? COLOR.cinnabar : COLOR.jade })
            .stroke({ width: 1, color: COLOR.paper });
          g.x = 18 + i * 20;
          g.y = TILE - 30;
          cell.addChild(g);
          const num = new Text({
            text: String(p.seatIndex + 1),
            style: { fill: COLOR.paper, fontSize: 10, fontFamily: "serif" },
          });
          num.anchor.set(0.5);
          num.x = g.x;
          num.y = g.y;
          cell.addChild(num);
        });

        // [ART] 怪物（門徒）
        const monsters = (snap.monsters || []).filter((m: any) => m.coord === key && m.alive);
        monsters.forEach((m: any, i: number) => {
          const mm = new Text({
            text: "卒",
            style: { fill: COLOR.cinnabar, fontSize: 14, fontFamily: "serif" },
          });
          mm.x = TILE - 26 - i * 14;
          mm.y = TILE - 32;
          cell.addChild(mm);
        });

        // 可移動的板塊：hover 描金 + 點擊移動
        if (clickable) {
          cell.eventMode = "static";
          cell.cursor = "pointer";
          cell.on("pointertap", () => onMoveTo(key, sameFloor));
          cell.on("pointerover", () => base.tint === 0xffffff && (base.tint = 0xd9c9a0));
          cell.on("pointerout", () => (base.tint = 0xffffff));
        }
      }

      yCursor += rows * (TILE + GAP) + 10;
      maxW = Math.max(maxW, PAD * 2 + cols * (TILE + GAP));
    }

    // 依內容調整畫布大小
    app.renderer.resize(maxW, yCursor + PAD);
  }

  return <div ref={hostRef} className="pixi-host" />;
}

/** 門：N=1 E=2 S=4 W=8 */
function drawDoors(cell: Container, mask: number) {
  const g = new Graphics();
  const seg = 14;
  const c = TILE / 2;
  const col = COLOR.gilt;
  if (mask & 1) g.rect(c - seg / 2, -2, seg, 4).fill(col); // N
  if (mask & 2) g.rect(TILE - 2, c - seg / 2, 4, seg).fill(col); // E
  if (mask & 4) g.rect(c - seg / 2, TILE - 2, seg, 4).fill(col); // S
  if (mask & 8) g.rect(-2, c - seg / 2, 4, seg).fill(col); // W
  cell.addChild(g);
}

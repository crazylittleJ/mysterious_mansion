import rawTiles from "../data/tiles.json";
import { Dir, oppositeDir } from "../events";

export type Floor = "GROUND" | "UPPER" | "BASEMENT";

export interface TileDef {
  defId: string;
  name: string;
  floors: Floor[];
  /** [N, E, S, W] */
  doors: boolean[];
  icon: "NONE" | "EVENT" | "ITEM" | "OMEN";
  isStart?: boolean;
  startFloor?: Floor;
  stairs?: boolean;
  elevator?: boolean;
  ritualRoom?: boolean;
  imageUrl?: string;
}

export const START_TILE_DEFS: TileDef[] = (rawTiles as any).startTiles;
export const TILE_DEFS: TileDef[] = (rawTiles as any).tiles;

export function tileDefById(defId: string): TileDef {
  const d = [...START_TILE_DEFS, ...TILE_DEFS].find((t) => t.defId === defId);
  if (!d) throw new Error(`unknown tile def: ${defId}`);
  return d;
}

export function coordKey(floor: Floor, x: number, y: number): string {
  return `${floor}:${x},${y}`;
}

export function parseCoord(key: string): { floor: Floor; x: number; y: number } {
  const [floor, xy] = key.split(":");
  const [x, y] = xy.split(",").map(Number);
  return { floor: floor as Floor, x, y };
}

/** 順時針旋轉 k 次後的門陣列：rotated[j] = doors[(j + 4 - k) % 4] */
export function rotateDoors(doors: boolean[], k: number): boolean[] {
  const out = [false, false, false, false];
  for (let j = 0; j < 4; j++) out[j] = doors[(j + 4 - k) % 4];
  return out;
}

/**
 * 自動旋轉使新板塊在 entrySide 方向有門。
 * entrySide 是「新板塊需要開門的那一側」（玩家從那側進來）。
 * 回傳旋轉次數 k（0-3），無解回傳 -1（理論上不會發生：所有板塊至少一扇門）。
 */
export function rotationToFit(doors: boolean[], entrySide: Dir): number {
  for (let k = 0; k < 4; k++) {
    if (rotateDoors(doors, k)[entrySide]) return k;
  }
  return -1;
}

/** 玩家從 fromDir 方向走出去，新板塊的入口側是相反方向 */
export function entrySideFor(moveDir: Dir): Dir {
  return oppositeDir(moveDir);
}

export function doorsToMask(doors: boolean[]): number {
  return (doors[0] ? 1 : 0) | (doors[1] ? 2 : 0) | (doors[2] ? 4 : 0) | (doors[3] ? 8 : 0);
}

export function maskHasDoor(mask: number, dir: Dir): boolean {
  return (mask & (1 << dir)) !== 0;
}

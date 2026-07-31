# 神秘古宅｜古董局中局・暗局（骨架 v0.1）

以 Betrayal at House on the Hill 的「探索 → 預兆 → 揭盅分裂」機制為骨，
場景由「山中小屋」改為「神秘古宅」，世界觀與所有文字內容為古董局中局風格
原創改寫。美術後期以 AI 補（板塊定義已預留 `imageUrl` 欄位，PixiJS 畫布已
備好掛點）。

## 架構

- **Server**：Colyseus 0.16（Node 20 / TypeScript / CommonJS），權威伺服器
- **Client**：Vite + React + TypeScript
  - **地圖**：可切換 SVG（`圖示`）與 PixiJS 畫布（`動畫`，美術強化版）
- **存檔**：`Store` 介面。預設記憶體；設 `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN`
  自動切換 Upstash Redis（REST），快照 TTL 24 小時，無進度過期即刪
- **房間上限**：有效存檔 ≤ 3 局（`MAX_SAVED_GAMES`）
- **玩家識別**：以**名號**為唯一鍵（`secrets.seatByName`），不用 IP／token。
  同名即同一人，斷線後憑「同名號 + 房間代碼」回原座位
- **斷線重連**：短斷線 `allowReconnection(120s)`；完全關閉後憑房間代碼 +
  原名號回原座（快照 hydrate 重建房間）。server 以 `YOUR_SEAT` 私訊直接
  告知座位，client 不必再猜

## 清檔時機

| 情況 | 行為 |
| --- | --- |
| 遊戲結束（`GAME_END`） | 立即刪檔 |
| 從沒開局的空候客房（`LOBBY`）解散 | 刪檔（不佔用 3 局名額） |
| 進行中的局全員離線閒置 | 逾時解散；預設**保留**快照供 24h 內續玩 |
| 24 小時無任何進度 | Redis TTL 自動過期 |

可用環境變數調整：

- `ROOM_IDLE_TIMEOUT_MS`：全員離線後多久解散房間（預設 `1800000` = 30 分）
- `PURGE_INPROGRESS_ON_IDLE=1`：連「進行中」的局在閒置逾時後也一併刪檔
  （預設關閉，以保留隔天續玩）

## 資訊隔離原則

- Schema 只放公開資訊。
- 高機密（真實做局者座位、水滴標記分配、牌堆順序、名號→座位對照）存 server 端
  `secrets` 變數，用 `client.send()` 私訊交付。
- 0.15 的 `@filter` 在 0.16 已被 StateView 取代；骨架刻意兩者都不依賴。

## 劇本

- `nine-stars`：九星連珠（公開做局者 + 門徒怪物 + 大局進度條 0→9）
- `nine-stars-secret`：暗局變體（秘密做局者，水滴儀式抽標記，抽到 1 是做局者）

勝負：做局者湊齊 9 件星宿古董送進密室（或生還者全滅）；
生還者集齊 3 件證據（或做局者出局）。

## 美術擴充（PixiJS）

`client/src/PixiBoard.tsx` 是美術可擴充的畫布骨架。所有掛點都標了 `// [ART]`：

- **板塊底**：`tile.imageUrl` 有值時自動載入為 `Sprite`（貼圖快取已備），
  否則畫佔位方塊。把板塊定義的 `imageUrl` 填上即可
- **棋子／怪物／物品**：目前用 `Graphics`／`Text` 佔位，替換成 `Sprite` 即可
- 座標沿用 server 的 `FLOOR:x,y`，點板塊 → `MOVE` / `USE_STAIRS`

Pixi 以 `React.lazy` 分包，只有切到「動畫」模式才載入，不影響 SVG 首屏。

## 本機開發

```bash
npm install
npm run dev:server   # :2567（GUDONG_DEBUG=1 可啟用 DEBUG_FORCE_HAUNT）
npm run dev:client   # :5173，自動連本機 server
```

## 驗證

```bash
npm run build   # client + server + 靜態檔收集
npm test        # 29 tests（引擎、存檔、房間整合）
# 實測一局到 GAME_END：
GUDONG_DEBUG=1 node server/dist/index.js &
npx tsx server/test/smoke.ts
```

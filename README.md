# 九星連珠｜古董局中局・山中小屋式暗局（骨架 v0.1）

以 Betrayal at House on the Hill 的「探索 → 預兆 → 揭盅分裂」機制為骨，
世界觀與所有文字內容為古董局中局風格原創改寫。美術後期以 AI 補
（板塊定義已預留 `imageUrl` 欄位）。

## 架構

- **Server**：Colyseus 0.16（Node 20 / TypeScript / CommonJS），權威伺服器
- **Client**：Vite + React + TypeScript，SVG 板塊地圖
- **存檔**：`Store` 介面。預設記憶體；設 `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN`
  自動切換 Upstash Redis（REST），快照 TTL 24 小時，無進度過期即刪
- **房間上限**：有效存檔 ≤ 3 局（`MAX_SAVED_GAMES`）
- **斷線重連**：短斷線 `allowReconnection(120s)`；完全關閉後憑
  房間代碼 + localStorage 的 `playerToken` 回原座位（快照 hydrate 重建房間）

## 資訊隔離原則

- Schema 只放公開資訊。
- 高機密（真實做局者座位、水滴標記分配、牌堆順序）存 server 端
  `secrets` 變數，用 `client.send()` 私訊交付。
- 0.15 的 `@filter` 在 0.16 已被 StateView 取代；骨架刻意兩者都不依賴。

## 劇本

- `nine-stars`：九星連珠（公開做局者 + 門徒怪物 + 大局進度條 0→9）
- `nine-stars-secret`：暗局變體（秘密做局者，水滴儀式抽標記，抽到 1 是做局者）

勝負：做局者湊齊 9 件星宿古董送進密室（或生還者全滅）；
生還者集齊 3 件證據（或做局者出局）。

## 本機開發

```bash
npm install
npm run dev:server   # :2567（GUDONG_DEBUG=1 可啟用 DEBUG_FORCE_HAUNT）
npm run dev:client   # :5173，自動連本機 server
```

## 驗證

```bash
npm run build   # client + server + 靜態檔收集
npm test        # 27 tests（引擎、存檔、房間整合）
# 實測一局到 GAME_END：
GUDONG_DEBUG=1 node server/dist/index.js &
npx tsx server/test/smoke.ts
```

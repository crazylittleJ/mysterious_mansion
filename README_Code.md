# 交付說明（骨架 v0.1）

## 這一包做了什麼

1. **事件 enum 全集**（`server/src/events.ts`）：客戶端意圖與伺服器訊息的封閉集合。
   未來 Gemini 層只允許輸出這個集合內的動作，規則裁決永遠在 server。

2. **板塊 JSON 格式定案**（`server/src/data/tiles.json`）：`doors=[N,E,S,W]`、
   `floors` 樓層限制、`icon` 觸發抽卡、`imageUrl` 留空給後期 AI 美術。
   三張起始板塊 + 18 張原創板塊（含密室、神秘電梯、樓梯間）。
   探索時自動旋轉板塊使入口側有門（`rotationToFit`）。

3. **座位制**：`PlayerState.seatIndex` 入座固定，跟 `playerToken` 綁定不跟連線走，
   斷線重連、關瀏覽器隔天回來都是同一個座位。

4. **做局者選定三模式**（`engine.ts`）：`revealer`／`closest-after-revealer`
   （座位環狀 tiebreak）／`secret-token`（水滴標記，抽到 1 的是做局者）。

5. **水滴儀式數位化**：server 揭盅瞬間就定好標記分配（存 server 機密，不進 schema），
   UI 上每人「抽取 → 私訊收到號碼 → 確認收好」，全員確認才開始暗局。
   實測驗證：儀式全程 `revealedTraitorSeat` 保持 -1，終局才公開。

6. **九星連珠劇本 ×2**（`scenario.ts`）：公開做局者版（門徒怪物 + 大局進度條）
   與暗局版（秘密做局者）。劇本文字全部原創，`progressTrack` 做成通用欄位。

7. **存檔層**（`persistence/store.ts`）：`Store` 介面 + 記憶體實作 + Upstash REST 實作。
   24 小時 TTL（有進度就續命）、3 局存檔上限（開新房前檢查）。
   快照含公開 state + server 機密（做局者、標記、牌堆順序、座位綁定）。

8. **斷線重連兩層**：短斷線 `allowReconnection(120s)` 原地續；
   長離線／server 重啟後憑房間代碼 + `playerToken` 從快照 hydrate 重建房間回原座位。

9. **揭盅後回合結構**：生還者 → 做局者 → 怪物回合（由做局者操作），
   同種怪物共用一次速度骰（最小 1）、怪物移動不檢查門、
   做局者用電梯免檢定（一般人手法檢定 3+）。

10. **最小可玩 client**：入宅大廳、三層 SVG 地圖（門缺口、棋子、地上物品）、
    水滴儀式 overlay、勝利條件面板（做局者之書／生存秘笈分開私訊）、
    行動列（探索四方、拾物、攻擊、密室交付、亮明身分、怪物操作）、日誌。

## 驗證紀錄

- `npm run build`：client + server TypeScript 全過
- `npm test`：27/27 綠（引擎單元、存檔 TTL/上限、房間整合：
  座位穩定、儀式隱私、快照往返、3 房上限）
- 實測：`test/smoke.ts` 真實 WebSocket 兩人暗局完整跑到
  `GAME_END / HERO / EVIDENCE_COLLECTED`，標記私訊各自只收到自己的號碼

## 已知簡化（骨架取捨，之後迭代）

- 探索抽板塊直接從「符合本樓層」的池子抽（省略「翻到不符棄掉重翻」）
- 怪物被打贏即擊退（原版的擊暈/翻面之後補）
- 房間本身的特殊效果（做局者免疫房間邪性等）只留了欄位還沒實作
- 電梯「兩回合共用一次」的冷卻還沒上，目前只有檢定差異
- 卡片效果只有 STAT_DELTA / CHECK / HOLD_BONUS 三種封閉 enum

## Git commit message

```
feat: 山中小屋式暗局骨架 v0.1（九星連珠）

- 事件 enum 封閉集合 + 板塊 JSON 格式（imageUrl 預留 AI 美術）
- seatIndex 座位制，playerToken 綁定跨斷線/重啟
- 做局者選定三模式；水滴儀式數位化（身分僅存 server 機密）
- 九星連珠劇本（公開做局者+門徒）與暗局變體（秘密做局者）
- Store 介面：記憶體/Upstash REST，24h TTL，3 局存檔上限
- 快照 hydrate 重建房間；allowReconnection 短斷線續玩
- 最小可玩 React client（SVG 地圖、儀式 overlay、行動列）
- 27 tests 綠 + 實測一局到 GAME_END
```

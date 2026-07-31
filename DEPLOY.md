# 部署（Render.com）

## 1. 建立 Upstash Redis（存檔外部化，必要）

Render free/starter 是 ephemeral filesystem 且閒置會 spin down，
「完全關閉隔天回來續玩」必須靠外部儲存。

1. 到 upstash.com 建立免費 Redis database（區域選離 Render 服務近的）
2. 進 database 頁面複製 **REST URL** 與 **REST TOKEN**（不是 Redis 連線字串）

## 2. 建立 Render Web Service

1. New → Web Service → 連結 **GitHub** repo（`crazylittleJ/mysterious_mansion`）
2. Render 會讀取 `render.yaml`（Node 20、`npm install && npm run build`、`npm start`）
3. 環境變數用 **Environment Group**（`mysterious_mansion_env`）集中管理，
   `render.yaml` 已用 `fromGroup: mysterious_mansion_env` 引入。group 內需有：

   | Key | 用途 |
   | --- | --- |
   | `UPSTASH_REDIS_REST_URL` | 存檔（必要） |
   | `UPSTASH_REDIS_REST_TOKEN` | 存檔（必要） |
   | `GEMINI_API_KEY` | 預留給未來 AI-GM 敘事層（目前尚未接線） |
   | `GEMINI_MODEL` | 同上 |

未設定 Upstash 兩個變數時，server 會退回記憶體存檔（僅適合本機測試，
服務重啟或 spin down 即遺失）。

### 可選環境變數

- `ROOM_IDLE_TIMEOUT_MS`：全員離線多久後解散房間（預設 30 分）
- `PURGE_INPROGRESS_ON_IDLE=1`：連進行中的局也在閒置逾時後清檔（預設關閉）

## 3. 驗證

- `https://<service>.onrender.com/healthz` 回 `{"ok":true}`
- 開兩個瀏覽器分頁，各填**不同名號**、同一房間代碼入宅開局
- 關掉其中一個分頁，重新開啟並填**原名號 + 同房號** → 應回到原座位

## 注意

- 玩家識別用**名號**，不是 IP／token；同房內名號需唯一，續玩要用回原名號
- 存檔上限 3 局；結束局、空候客房、24 小時無進度都會自動清除
- `GUDONG_DEBUG` 不要在正式環境設為 1（會開放強制揭盅指令）

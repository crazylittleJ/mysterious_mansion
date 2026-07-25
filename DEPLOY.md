# 部署（Render.com）

## 1. 建立 Upstash Redis（存檔外部化，必要）

Render free/starter 是 ephemeral filesystem 且閒置會 spin down，
「完全關閉隔天回來續玩」必須靠外部儲存。

1. 到 upstash.com 建立免費 Redis database（區域選離 Render 服務近的）
2. 進 database 頁面複製 **REST URL** 與 **REST TOKEN**（不是 Redis 連線字串）

## 2. 建立 Render Web Service

1. New → Web Service → 連結 GitLab repo
2. Render 會讀取 `render.yaml`（Node 20、`npm install && npm run build`、`npm start`）
3. 在 Environment 填入：
   - `UPSTASH_REDIS_REST_URL`
   - `UPSTASH_REDIS_REST_TOKEN`

未設定這兩個變數時 server 會退回記憶體存檔（僅適合本機測試，
服務重啟或 spin down 即遺失）。

## 3. 驗證

- `https://<service>.onrender.com/healthz` 回 `{"ok":true}`
- 開兩個瀏覽器（其中一個無痕），同一房間代碼入宅開局
- 關掉其中一個分頁，重新開啟同代碼 → 應回到原座位

## 注意

- 存檔上限 3 局；24 小時無任何進度自動過期
- `GUDONG_DEBUG` 不要在正式環境設為 1（會開放強制揭盅指令）

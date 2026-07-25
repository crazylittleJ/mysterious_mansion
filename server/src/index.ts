import http from "http";
import path from "path";
import express from "express";
import { Server } from "colyseus";
import { WebSocketTransport } from "@colyseus/ws-transport";
import { BetrayalRoom } from "./rooms/BetrayalRoom";

const port = Number(process.env.PORT || 2567);
const app = express();

app.get("/healthz", (_req, res) => res.json({ ok: true }));

// 上線時 client build 會被複製到 server/public
const staticDir = path.resolve(__dirname, "../public");
app.use(express.static(staticDir));

const httpServer = http.createServer(app);
const gameServer = new Server({
  transport: new WebSocketTransport({ server: httpServer }),
});

// filterBy(roomCode)：同代碼的 joinOrCreate 會進同一房
gameServer.define("gudong-betrayal", BetrayalRoom).filterBy(["roomCode"]);

httpServer.listen(port, () => {
  console.log(`[gudong-betrayal] listening on :${port}`);
});

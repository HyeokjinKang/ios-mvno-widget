import "dotenv/config";
import express from "express";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loginRouter } from "./routes/login.js";
import { remoteLoginRouter, registerRemoteLoginWs } from "./routes/remoteLogin.js";
import { usageRouter } from "./routes/usage.js";
import { refreshAll } from "./engine/refreshEngine.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "..", "web")));

app.use(loginRouter);
app.use(remoteLoginRouter);
app.use(usageRouter);

app.get("/health", (_req, res) => res.json({ ok: true }));

const server = createServer(app);
registerRemoteLoginWs(server);

const PORT = Number(process.env.PORT ?? 8787);
server.listen(PORT, () => {
  console.log(`[mvno-usage] listening on http://localhost:${PORT}`);
});

// 문서 §자동 갱신 설정: 30분 주기 (JobScheduler 대응 - 여기서는 setInterval).
const REFRESH_INTERVAL_MS = 30 * 60 * 1000;
refreshAll().catch((err) => console.error("[startup] 최초 갱신 실패:", err));
setInterval(() => {
  refreshAll().catch((err) => console.error("[scheduler] 갱신 실패:", err));
}, REFRESH_INTERVAL_MS);

import { Router } from "express";
import { getCarrier } from "../carriers/index.js";
import { HttpEngine } from "../core/httpEngine.js";
import { sessionStore } from "../core/sessionStore.js";
import { refreshCarrier } from "../engine/refreshEngine.js";

export const loginRouter = Router();

// 아이디/비밀번호 로그인 (eyes, freet, tplus). 문서: "앱에서 직접 재로그인 가능".
loginRouter.post("/api/login/:carrierId", async (req, res) => {
  const carrier = getCarrier(req.params.carrierId);
  if (carrier.authKind !== "credential") {
    res.status(400).json({ error: `${carrier.displayName}은(는) 아이디/비밀번호 로그인을 지원하지 않습니다. 원격 브라우저 로그인을 사용하세요.` });
    return;
  }
  const { userId, password, remember } = req.body ?? {};
  if (!userId || !password) {
    res.status(400).json({ error: "userId, password가 필요합니다" });
    return;
  }
  try {
    const http = new HttpEngine(sessionStore.jarFor(carrier.id));
    const ok = await carrier.login!(http, userId, password);
    sessionStore.save(carrier.id);
    if (!ok) {
      res.status(401).json({ error: "로그인 실패 (아이디/비밀번호를 확인하세요)" });
      return;
    }
    if (remember) sessionStore.setCredential(carrier.id, userId, password);
    refreshCarrier(carrier.id).catch((err) => console.error(`[login] ${carrier.id} 로그인 직후 갱신 실패:`, err));
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

loginRouter.post("/api/logout/:carrierId", (req, res) => {
  const carrier = getCarrier(req.params.carrierId);
  sessionStore.clear(carrier.id);
  res.json({ ok: true });
});

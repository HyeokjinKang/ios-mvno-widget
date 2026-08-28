import { Router } from "express";
import { requireWidgetToken } from "../core/widgetAuth.js";
import { stateStore } from "../engine/stateStore.js";
import { dedupeLines } from "../engine/dedupe.js";
import { refreshAll } from "../engine/refreshEngine.js";
import { CARRIERS } from "../carriers/index.js";
import { labelStore } from "../core/labelStore.js";
import { LineUsage } from "../types/model.js";

export const usageRouter = Router();

function withNicknames(lines: LineUsage[]): LineUsage[] {
  return lines.map((l) => ({ ...l, nickname: labelStore.get(l.lineKey, l.sourceId, l.ordinal) }));
}

function visibleLines(): LineUsage[] {
  const lines = withNicknames(dedupeLines(stateStore.getLines()));
  return lines.sort((a, b) => (a.nickname ?? a.label).localeCompare(b.nickname ?? b.label, "ko"));
}

// Scriptable이 호출하는 단일 엔드포인트. 정제되고 중복 제거된 사용량 목록만 돌려준다.
usageRouter.get("/api/usage", requireWidgetToken, (_req, res) => {
  res.json({
    lines: visibleLines(),
    lastRefreshAt: stateStore.getLastRefreshAt(),
    statuses: stateStore.getStatuses(),
  });
});

usageRouter.post("/api/refresh", requireWidgetToken, async (_req, res) => {
  await refreshAll();
  res.json({ ok: true });
});

// 대시보드(웹 UI)용 - nginx Basic Auth 뒤에 있다고 가정.
usageRouter.get("/api/status", (_req, res) => {
  res.json({
    carriers: CARRIERS.map((c) => ({ id: c.id, displayName: c.displayName, authKind: c.authKind })),
    statuses: stateStore.getStatuses(),
    lastRefreshAt: stateStore.getLastRefreshAt(),
    lines: visibleLines(),
  });
});

// 회선 별칭 지정. 빈 문자열을 보내면 별칭을 지운다.
usageRouter.post("/api/labels", (req, res) => {
  const { lineKey, sourceId, ordinal, nickname } = req.body ?? {};
  if (typeof lineKey !== "string" || !lineKey || typeof sourceId !== "string" || !sourceId) {
    res.status(400).json({ error: "lineKey, sourceId가 필요합니다" });
    return;
  }
  if (typeof nickname !== "string") {
    res.status(400).json({ error: "nickname은 문자열이어야 합니다" });
    return;
  }
  if (nickname.length > 40) {
    res.status(400).json({ error: "별칭은 40자 이하여야 합니다" });
    return;
  }
  labelStore.set(lineKey, sourceId, typeof ordinal === "number" ? ordinal : undefined, nickname);
  res.json({ ok: true });
});

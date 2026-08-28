import { timingSafeEqual } from "node:crypto";
import type { Request, Response, NextFunction } from "express";

// Scriptable이 /api/usage 를 부를 때 쓰는 개인 토큰. `openssl rand -hex 32` 로 생성해
// MVNO_WIDGET_TOKEN 에 넣고 Scriptable 스크립트 상단 설정에도 동일하게 넣는다.
function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

export function requireWidgetToken(req: Request, res: Response, next: NextFunction): void {
  const expected = process.env.MVNO_WIDGET_TOKEN;
  if (!expected) {
    res.status(500).json({ error: "서버에 MVNO_WIDGET_TOKEN이 설정되지 않았습니다" });
    return;
  }
  const header = req.header("authorization");
  const bearer = header?.startsWith("Bearer ") ? header.slice(7) : undefined;
  const provided = bearer ?? (req.query.token as string | undefined);
  if (!provided || !safeEqual(provided, expected)) {
    res.status(401).json({ error: "토큰이 유효하지 않습니다" });
    return;
  }
  next();
}

import { CARRIERS, getCarrier } from "../carriers/index.js";
import { CarrierAdapter } from "../carriers/types.js";
import { HttpEngine } from "../core/httpEngine.js";
import { sessionStore } from "../core/sessionStore.js";
import { LineRef, LineUsage, SessionExpiredError } from "../types/model.js";
import { stateStore } from "./stateStore.js";

export class NeedsLoginError extends Error {
  constructor(public carrierId: string) {
    super(`${carrierId}: 로그인이 필요합니다`);
    this.name = "NeedsLoginError";
  }
}

// 문서 §갱신 흐름의 "프로세스 전역 Mutex" 재현. 동시에 두 번 갱신이 겹치지 않게 한다.
let refreshChain: Promise<void> = Promise.resolve();
function withMutex<T>(fn: () => Promise<T>): Promise<T> {
  const run = refreshChain.then(fn, fn);
  refreshChain = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

// 세션 규칙 1,2 (문서): 조회만으로 세션 연장 안 됨 → 전용 갱신 엔드포인트 호출.
// 만료 시각을 모르면 항상 갱신 시도.
async function ensureSession(carrier: CarrierAdapter, http: HttpEngine): Promise<void> {
  if (carrier.authKind === "webonly") {
    if (!carrier.hasSession(http)) throw new NeedsLoginError(carrier.id);
    const expiresAt = sessionStore.getSessionExpiresAt(carrier.id);
    const windowMs = carrier.refreshWindowMs ?? 0;
    const needsRefresh = expiresAt == null || Date.now() >= expiresAt - windowMs;
    if (needsRefresh && carrier.refreshSession) {
      const ok = await carrier.refreshSession(http);
      sessionStore.save(carrier.id);
      if (!ok) throw new NeedsLoginError(carrier.id);
      // 정확한 신규 만료 시각을 서버가 알려주지 않으므로 refreshWindowMs*2를 다음 만료로 가정한다
      // (예: aldot 45분 여유 → 90분 뒤 재점검, pindirect 7일 여유 → 14일 뒤 재점검).
      sessionStore.setSessionExpiresAt(carrier.id, Date.now() + windowMs * 2);
    }
    return;
  }

  // credential
  if (!carrier.hasSession(http)) {
    const cred = sessionStore.getCredential(carrier.id);
    if (!cred || !carrier.login) throw new NeedsLoginError(carrier.id);
    const ok = await carrier.login(http, cred.userId, cred.password);
    sessionStore.save(carrier.id);
    if (!ok) throw new NeedsLoginError(carrier.id);
  }
}

async function forceReauth(carrier: CarrierAdapter, http: HttpEngine): Promise<void> {
  if (carrier.authKind === "webonly") {
    if (!carrier.refreshSession) throw new NeedsLoginError(carrier.id);
    const ok = await carrier.refreshSession(http);
    sessionStore.save(carrier.id);
    if (!ok) throw new NeedsLoginError(carrier.id);
    return;
  }
  const cred = sessionStore.getCredential(carrier.id);
  if (!cred || !carrier.login) throw new NeedsLoginError(carrier.id);
  const ok = await carrier.login(http, cred.userId, cred.password);
  sessionStore.save(carrier.id);
  if (!ok) throw new NeedsLoginError(carrier.id);
}

async function fetchAllUsage(carrier: CarrierAdapter, http: HttpEngine, lines: LineRef[]): Promise<LineUsage[]> {
  // 순번은 fetchLines가 돌려준 순서를 그대로 쓴다. 별칭 폴백 키의 근거이므로 조회 실패로
  // 목록이 밀리지 않도록 인덱스를 미리 박아둔다.
  if (carrier.supportsParallelLines === false) {
    const out: LineUsage[] = [];
    for (const [ordinal, line] of lines.entries()) {
      try {
        out.push({ ...(await carrier.fetchUsage(http, line)), ordinal });
      } catch (err) {
        console.error(`[refreshEngine] ${carrier.id} 회선 ${line.id} 사용량 조회 실패:`, (err as Error).message);
      }
    }
    return out;
  }
  const settled = await Promise.allSettled(lines.map((line) => carrier.fetchUsage(http, line)));
  return settled.flatMap((r, ordinal) => (r.status === "fulfilled" ? [{ ...r.value, ordinal }] : []));
}

async function refreshOne(carrier: CarrierAdapter): Promise<void> {
  const http = new HttpEngine(sessionStore.jarFor(carrier.id));
  try {
    await ensureSession(carrier, http);

    let lines: LineRef[];
    try {
      lines = await carrier.fetchLines(http);
    } catch (err) {
      if (err instanceof SessionExpiredError) {
        await forceReauth(carrier, http);
        lines = await carrier.fetchLines(http);
      } else {
        throw err;
      }
    }

    const usages = await fetchAllUsage(carrier, http, lines);
    stateStore.setCarrierLines(carrier.id, usages);
    stateStore.setStatus({ carrierId: carrier.id, ok: true, needsLogin: false, updatedAt: Date.now() });
  } catch (err) {
    if (err instanceof NeedsLoginError) {
      stateStore.setStatus({
        carrierId: carrier.id,
        ok: false,
        needsLogin: true,
        error: "로그인이 필요합니다",
        updatedAt: Date.now(),
      });
    } else {
      console.error(`[refreshEngine] ${carrier.id} 갱신 실패:`, (err as Error).message);
      stateStore.setStatus({
        carrierId: carrier.id,
        ok: false,
        needsLogin: false,
        error: (err as Error).message,
        updatedAt: Date.now(),
      });
    }
  }
}

export function refreshAll(): Promise<void> {
  return withMutex(async () => {
    await Promise.all(CARRIERS.map((c) => refreshOne(c)));
    stateStore.markRefreshed();
  });
}

export function refreshCarrier(carrierId: string): Promise<void> {
  const carrier = getCarrier(carrierId);
  return withMutex(() => refreshOne(carrier));
}

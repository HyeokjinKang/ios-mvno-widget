import { HttpEngine } from "../core/httpEngine.js";
import { LineRef, LineUsage, Metric, MetricUnit, SessionExpiredError, formatUnit } from "../types/model.js";
import { CarrierAdapter } from "./types.js";

// 문서의 AldotAdapter.kt 원문을 그대로 이식.
const API = "https://api.uplusmvno.com";
const WEB = "https://www.uplusmvno.com";
const LINE_INFO = "/umah/fo/care/main/v1/lineInfo";
const PREPAID = "/umah/fo/care/main/v1/ppay";
const REAL_TIME = "/umah/fo/care/use/v1/real-time";
const OK = "0000";
const LOGIN_REQUIRED = new Set(["N0009", "N0010"]);

function cleanPlanName(raw: string | undefined): string | undefined {
  if (!raw || !raw.trim()) return undefined;
  const cleaned = raw.replace(/^(\s*\[[^\]]*\])+/, "").trim();
  return cleaned || undefined;
}

function shouldExclude(itemName: string): boolean {
  const n = itemName.replace(/\s/g, "").toLowerCase();
  return n === "qos" || n.includes("테더링") || n.includes("핫스팟");
}

function sum(items: any[] | undefined, unit: MetricUnit, prepaid: boolean): Metric {
  if (!items || items.length === 0) return Metric.UNKNOWN;
  const scale = unit === "BYTES" && !prepaid ? 1024 : 1;
  let used = 0;
  let total = 0;
  let sawTotal = false;
  let unlimited = false;
  for (const o of items) {
    const itemName = String(o.itemName ?? "");
    if (shouldExclude(itemName)) continue;
    if (o.qos === true) continue;
    used += (Number(o.useValue) || 0) * scale;
    const allo = o.alloValue != null && String(o.alloValue).trim() !== "" ? String(o.alloValue) : null;
    if (allo === "Z" || allo === "-1") {
      unlimited = true;
    } else if (allo != null) {
      const n = Number(allo);
      if (!Number.isNaN(n)) {
        total += n * scale;
        sawTotal = true;
      }
    }
  }
  if (unlimited) return Metric.unlimited(formatUnit(unit, Math.max(0, used)));
  if (!sawTotal) return Metric.UNKNOWN;
  return Metric.ofRaw(Math.max(0, used), Math.max(0, total), unit);
}

async function get(http: HttpEngine, path: string, query: Record<string, string> = {}) {
  return http.request({ method: "GET", url: API + path, query, origin: WEB, referer: `${WEB}/` });
}

export const aldotAdapter: CarrierAdapter = {
  id: "aldot",
  displayName: "알닷",
  authKind: "webonly",
  loginUrl: `${WEB}/login`,
  allowedDomains: ["uplusmvno.com", "naver.com", "naver.net", "kakao.com", "kakao.co.kr"],
  refreshWindowMs: 45 * 60 * 1000,

  hasSession(http) {
    return http.hasCookie(API);
  },

  isLoginComplete(url) {
    return url.includes("/care/");
  },

  async refreshSession(http) {
    const res = await http.request({
      method: "POST",
      url: `${API}/umah/fo/user/v1/refreshTokenCreate`,
      body: "{}",
      contentType: "application/json",
      origin: WEB,
      referer: `${WEB}/`,
    });
    return res.isSuccess && !aldotAdapter.isSessionExpired(res.code, res.body);
  },

  async fetchLines(http) {
    const res = await get(http, LINE_INFO);
    if (aldotAdapter.isSessionExpired(res.code, res.body)) throw new SessionExpiredError();
    if (!res.isSuccess) throw new Error(`회선 목록 조회 실패: HTTP ${res.code}`);
    const root = JSON.parse(res.body);
    if (root.resultCode !== OK) throw new Error(`회선 목록 resultCode=${root.resultCode}`);
    const arr: any[] = root.entrSvcList ?? [];
    const out: LineRef[] = [];
    for (const o of arr) {
      const entrId = o.entrId?.trim();
      if (!entrId) continue;
      const xUserId = o.xuserId || o.xUserId || o.xUsereId || "";
      const partner = o.mvnopPtnNm?.trim() || undefined;
      out.push({
        id: entrId,
        label: o.encnTlno?.trim() || partner || entrId,
        phone: o.encnTlnoUnMask?.trim() || undefined,
        planName: cleanPlanName(o.ppNm),
        carrierName: partner,
        extra: { xUserId },
      });
    }
    return out;
  },

  async fetchUsage(http, line) {
    const q = { entrId: line.id, xUserId: line.extra?.xUserId ?? "" };
    let prepaid = false;
    try {
      const r = await get(http, PREPAID, q);
      prepaid = r.isSuccess && JSON.parse(r.body).resultCode === "Y";
    } catch {
      prepaid = false;
    }
    const res = await get(http, REAL_TIME, q);
    if (!res.isSuccess) throw new Error(`알닷 사용량 조회 실패 (${res.code})`);
    const root = JSON.parse(res.body);
    if (root.resultCode !== OK) throw new Error("알닷 조회 코드 이상");
    return {
      lineKey: line.phone || `aldot:${line.id}`,
      label: line.label,
      planName: line.planName,
      carrierName: line.carrierName || "알닷",
      network: "LGU+",
      data: sum(root.useDataList, "BYTES", prepaid),
      voice: sum(root.useVoicList, "SECONDS", prepaid),
      sms: sum(root.useSmsList, "COUNT", prepaid),
      sourceId: "aldot",
      fetchedAt: Date.now(),
    };
  },

  isSessionExpired(code, body) {
    if (code === 401 || code === 403) return true;
    if (code < 200 || code > 299) return false;
    try {
      return LOGIN_REQUIRED.has(JSON.parse(body).resultCode);
    } catch {
      return false;
    }
  },
};

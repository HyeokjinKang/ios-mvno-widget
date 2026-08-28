import { LineRef, Metric, MetricUnit, SessionExpiredError, normalizeNetwork, formatUnit } from "../types/model.js";
import { CarrierAdapter } from "./types.js";

// 문서의 PindirectAdapter.kt 원문을 그대로 이식.
const API = "https://z-api.pindirectshop.com";
const WEB = "https://www.pindirectshop.com";

function metric(o: any, totalKey: string, usedKey: string, unit: MetricUnit, scale: number): Metric {
  if (!(totalKey in o)) return Metric.UNKNOWN;
  const total = Number(o[totalKey] ?? 0);
  const used = Number(o[usedKey] ?? 0);
  if (total < 0) return Metric.unlimited(formatUnit(unit, used * scale));
  if (total === 0 && used === 0) return Metric.UNKNOWN;
  return Metric.ofRaw(used * scale, total * scale, unit);
}

export const pindirectAdapter: CarrierAdapter = {
  id: "pindirect",
  displayName: "핀다이렉트",
  authKind: "webonly",
  loginUrl: `${WEB}/login`,
  allowedDomains: ["pindirectshop.com", "kauth.kakao.com", "kakao.com"],
  refreshWindowMs: 7 * 24 * 60 * 60 * 1000,

  hasSession(http) {
    return http.hasCookie(API);
  },

  isLoginComplete(url) {
    return !url.includes("/login") && !url.includes("kakao");
  },

  async refreshSession(http) {
    const res = await http.request({ method: "GET", url: `${API}/auth/token/refresh`, origin: WEB, referer: `${WEB}/` });
    return res.isSuccess && !pindirectAdapter.isSessionExpired(res.code, res.body);
  },

  matchesPartnerName(name) {
    return !!name?.includes("핀다이렉트");
  },

  isSessionExpired(code, body) {
    if (code === 401 || code === 403) return true;
    if (code < 200 || code > 299) return false;
    try {
      const rc = JSON.parse(body).resultCode;
      return rc === "N0009" || rc === "N0010";
    } catch {
      return false;
    }
  },

  async fetchLines(http) {
    const res = await http.request({
      method: "GET",
      url: `${API}/lineInfo`,
      origin: WEB,
      referer: `${WEB}/my-pindirect/subscription`,
    });
    if (pindirectAdapter.isSessionExpired(res.code, res.body)) throw new SessionExpiredError();
    if (!res.isSuccess) throw new Error(`회선 목록 조회 실패: HTTP ${res.code}`);
    const body = res.body.trimStart();
    let arr: any[];
    if (body.startsWith("[")) {
      arr = JSON.parse(body);
    } else {
      const parsed = JSON.parse(body);
      arr = parsed.entrSvcList ?? parsed.data ?? [];
      if (!Array.isArray(arr) || arr.length === 0) return [];
    }
    const out: LineRef[] = [];
    for (const o of arr) {
      const lineId = o.lineId?.trim() || o.entrId?.trim();
      if (!lineId) continue;
      const phone = o.encnTlnoUnMask?.trim() || o.phoneNumber?.trim() || undefined;
      out.push({
        id: lineId,
        label: o.maskedPhoneNumber?.trim() || o.encnTlno?.trim() || phone || lineId,
        phone: phone ? phone.replace(/[^\d*]/g, "") : undefined,
        planName: o.ppNm?.trim() || undefined,
        carrierName: o.mvnopPtnNm?.trim() || "핀다이렉트",
      });
    }
    return out;
  },

  async fetchUsage(http, line) {
    const res = await http.request({
      method: "GET",
      url: `${API}/lineInfo/${line.id}/usage`,
      origin: WEB,
      referer: `${WEB}/my-pindirect/subscription/realtime-usage`,
    });
    if (!res.isSuccess) throw new Error(`핀다이렉트 사용량 조회 실패 (${res.code})`);
    const o = JSON.parse(res.body);
    return {
      lineKey: line.phone || `pindirect:${line.id}`,
      label: line.label,
      planName: line.planName || o.dataAddPaymentPlanSpec?.trim() || undefined,
      carrierName: line.carrierName || "핀다이렉트",
      network: normalizeNetwork(o.provider) ?? undefined,
      data: metric(o, "totalDataAmount", "usedDataAmount", "BYTES", 1024),
      voice: metric(o, "totalCallAmount", "usedCallAmount", "SECONDS", 1),
      sms: metric(o, "totalTextMessageAmount", "usedTextMessageAmount", "COUNT", 1),
      sourceId: "pindirect",
      fetchedAt: Date.now(),
    };
  },
};

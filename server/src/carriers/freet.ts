import { HttpEngine } from "../core/httpEngine.js";
import { LineRef, Metric, MetricUnit, SessionExpiredError, normalizeNetwork, formatUnit } from "../types/model.js";
import { CarrierAdapter } from "./types.js";

// 문서의 FreetAdapter.kt 원문을 그대로 이식.
const API = "https://api.freet.co.kr";
const WEB = "https://www.freet.co.kr";

function shouldExclude(name: string): boolean {
  const n = name.replace(/\s/g, "").toLowerCase();
  return n === "qos" || n.includes("테더링") || n.includes("핫스팟");
}

function toBase(v: number, unit: MetricUnit): number {
  return unit === "BYTES" ? v * 1024 : v;
}

function metricOf(arr: any[] | undefined, unit: MetricUnit): Metric {
  if (!arr || arr.length === 0) return Metric.UNKNOWN;
  let used = 0;
  let total = 0;
  let sawTotal = false;
  let unlimited = false;
  for (const o of arr) {
    const name = String(o.name ?? "");
    if (shouldExclude(name)) continue;
    const u = o.use != null && String(o.use).trim() !== "" ? Number(o.use) : NaN;
    const t = o.total != null && String(o.total).trim() !== "" ? Number(o.total) : NaN;
    if (o.total != null && String(o.total).trim() !== "" && Number.isNaN(t)) unlimited = true;
    if (!Number.isNaN(u)) used += toBase(u, unit);
    if (!Number.isNaN(t)) {
      total += toBase(t, unit);
      sawTotal = true;
    }
  }
  if (unlimited) return Metric.unlimited(formatUnit(unit, used));
  if (!sawTotal) return Metric.UNKNOWN;
  return Metric.ofRaw(used, total, unit);
}

function normalizePhone(masked: string | undefined): string | undefined {
  if (!masked || !masked.trim()) return undefined;
  const v = masked.replace(/-/g, "");
  return v || undefined;
}

export const freetAdapter: CarrierAdapter = {
  id: "freet",
  displayName: "프리티",
  authKind: "credential",
  loginUrl: `${WEB}/login?loginType=withId&redirectUrl=%2Fmain`,
  allowedDomains: ["freet.co.kr", "nid.naver.com", "kauth.kakao.com"],

  hasSession(http) {
    return http.hasCookie(API);
  },

  async login(http, userId, password) {
    const res = await http.request({
      method: "POST",
      url: `${API}/login/process`,
      body: HttpEngine.form({ username: userId, password, rememberMe: "true" }),
      contentType: "application/x-www-form-urlencoded",
      origin: WEB,
      referer: `${WEB}/login`,
    });
    return res.isSuccess && !freetAdapter.isSessionExpired(res.code, res.body);
  },

  matchesPartnerName(name) {
    return !!name?.includes("프리티");
  },

  isSessionExpired(code, body) {
    if (code === 401 || code === 403) return true;
    if (code < 200 || code > 299) return false;
    let status = "";
    let ret = "";
    try {
      const j = JSON.parse(body);
      status = j.status ?? "";
      ret = j.retCode ?? "";
    } catch {
      // not JSON
    }
    const looksLikeLoginPage = body.includes("/login") && !body.trimStart().startsWith("{");
    return looksLikeLoginPage || (status !== "" && status !== "success" && ret === "99");
  },

  async fetchLines(http) {
    const res = await http.request({
      method: "POST",
      url: `${API}/mypage/info/multi_line/getInfo`,
      headers: { "X-Requested-With": "XMLHttpRequest" },
      body: "",
      contentType: "application/x-www-form-urlencoded",
      origin: WEB,
      referer: `${WEB}/main`,
    });
    if (freetAdapter.isSessionExpired(res.code, res.body)) throw new SessionExpiredError();
    if (!res.isSuccess) throw new Error(`회선 목록 조회 실패: HTTP ${res.code}`);
    const arr: any[] = JSON.parse(res.body).data ?? [];
    if (!Array.isArray(arr)) throw new Error("회선 목록에 data 없음");
    const out: LineRef[] = [];
    for (const o of arr) {
      const entrNo = o.entrNo?.trim();
      if (!entrNo) continue;
      out.push({
        id: entrNo,
        label: o.maskedTelNo?.trim() || o.plan?.trim() || entrNo,
        phone: normalizePhone(o.maskedTelNo),
        planName: o.plan?.trim() || undefined,
        carrierName: "프리티",
        extra: {
          comType: o.networkCd ?? "",
          network: (o.network ?? "").trim(),
          prepaid: o.prepaid ?? "",
        },
      });
    }
    return out;
  },

  async fetchUsage(http, line) {
    const res = await http.request({
      method: "GET",
      url: `${API}/global/v1/main/usage`,
      query: { _: String(Date.now()) },
      headers: { "X-Requested-With": "XMLHttpRequest" },
      origin: WEB,
      referer: `${WEB}/main`,
    });
    if (!res.isSuccess) throw new Error(`프리티 사용량 조회 실패 (${res.code})`);
    const root = JSON.parse(res.body);
    const data = root.data;
    if (!data) throw new Error("프리티 응답에 data가 없습니다");
    const usage = data.usageData;
    if (!usage) throw new Error("프리티 응답에 usageData가 없습니다");
    return {
      lineKey: line.phone || line.id,
      label: line.label,
      planName: line.planName,
      carrierName: "프리티",
      network: normalizeNetwork(line.extra?.network) ?? "SKT",
      data: metricOf(usage.DATA, "BYTES"),
      voice: metricOf(usage.VOICE, "SECONDS"),
      sms: metricOf(usage.SMS, "COUNT"),
      sourceId: "freet",
      fetchedAt: Date.now(),
    };
  },
};

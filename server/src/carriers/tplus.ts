import { HttpEngine } from "../core/httpEngine.js";
import { LineRef, Metric, MetricUnit, formatUnit } from "../types/model.js";
import { CarrierAdapter } from "./types.js";
import { sessionStore } from "../core/sessionStore.js";

// 문서의 TplusAdapter.kt 원문을 그대로 이식.
// 회선 식별이 세션마다 바뀌는 토큰(num)이라 순번 폴백 저장이 필요 (문서 §2.10).
const WEB = "https://www.tplusmobile.com";
const WEB_BARE = "https://tplusmobile.com";
const NUM_TOKEN_RE = /num=([0-9A-F]{32,80})/g;
const LINE_PAGES = ["/main/member/member-info", "/main/member/realtime-data", "/main/mypage", "/"];

function toRefs(nums: string[]): LineRef[] {
  return nums.map((num, idx) => ({
    id: num,
    label: nums.length === 1 ? "티플러스" : `티플러스 ${idx + 1}`,
    carrierName: "티플러스",
  }));
}

function loadSavedTokens(): string[] {
  const raw = sessionStore.getExtra("tplus", "lineTokens");
  if (!raw) return [];
  try {
    return JSON.parse(raw) as string[];
  } catch {
    return [];
  }
}

function saveTokens(nums: string[]): void {
  const merged = Array.from(new Set([...loadSavedTokens(), ...nums]));
  sessionStore.setExtra("tplus", "lineTokens", JSON.stringify(merged));
}

function metric(
  o: any,
  totalKey: string,
  usedKey: string,
  percentKey: string,
  unit: MetricUnit,
  scale: number,
): Metric {
  if (!(totalKey in o) && !(usedKey in o)) return Metric.UNKNOWN;
  const totalRaw = Number(o[totalKey] ?? -1);
  const usedRaw = Number(o[usedKey] ?? -1);
  if (usedRaw < 0) return Metric.UNKNOWN;
  if (totalRaw < 0) return Metric.unlimited(formatUnit(unit, usedRaw * scale));
  const base = Metric.ofRaw(usedRaw * scale, totalRaw * scale, unit);
  const serverPercent =
    percentKey in o ? Math.min(100, Math.max(0, 100 - Number(o[percentKey] ?? 0))) : base.remainPercent;
  return { ...base, remainPercent: serverPercent };
}

export const tplusAdapter: CarrierAdapter = {
  id: "tplus",
  displayName: "티플러스",
  authKind: "credential",
  loginUrl: `${WEB}/main/member/login`,
  allowedDomains: ["tplusmobile.com"],

  hasSession(http) {
    return http.hasCookie(WEB) || http.hasCookie(WEB_BARE);
  },

  async login(http, userId, password) {
    const res = await http.request({
      method: "POST",
      url: `${WEB}/BackBone/Member/login`,
      headers: { "X-Requested-With": "XMLHttpRequest" },
      body: HttpEngine.form({ mber_id: userId, mber_pw: password }),
      contentType: "application/x-www-form-urlencoded; charset=UTF-8",
      origin: WEB,
      referer: `${WEB}/main/member/login`,
    });
    if (!res.isSuccess) return false;
    try {
      return (await tplusAdapter.fetchLines(http)).length > 0;
    } catch {
      return false;
    }
  },

  matchesPartnerName(name) {
    return !!name?.includes("티플");
  },

  isSessionExpired(code, body) {
    if (code === 401 || code === 403) return true;
    NUM_TOKEN_RE.lastIndex = 0;
    if (NUM_TOKEN_RE.test(body)) return false;
    return body.includes("loginFail");
  },

  async fetchLines(http) {
    for (const host of [WEB, WEB_BARE]) {
      for (const path of LINE_PAGES) {
        let res;
        try {
          res = await http.request({ method: "GET", url: host + path, origin: host, referer: `${host}/` });
        } catch {
          continue;
        }
        const nums = Array.from(new Set([...res.body.matchAll(NUM_TOKEN_RE)].map((m) => m[1])));
        if (nums.length > 0) {
          saveTokens(nums);
          return toRefs(nums);
        }
      }
    }
    return toRefs(loadSavedTokens());
  },

  async fetchUsage(http, line) {
    const res = await http.request({
      method: "POST",
      url: `${WEB}/BackBone/Member/getCallView`,
      headers: { "X-Requested-With": "XMLHttpRequest" },
      body: HttpEngine.form({ num: line.id }),
      contentType: "application/x-www-form-urlencoded; charset=UTF-8",
      origin: WEB,
      referer: `${WEB}/main/member/realtime-data?num=${line.id}`,
    });
    if (!res.isSuccess) throw new Error(`티플러스 사용량 조회 실패 (${res.code})`);
    const o = JSON.parse(res.body);
    if (o.status !== "OK") throw new Error(`티플러스 조회 상태 이상: ${o.status}`);
    return {
      lineKey: line.phone || `tplus:${line.id}`,
      label: line.label,
      planName: o.gdsName?.trim() || undefined,
      carrierName: "티플러스",
      network: undefined,
      data: metric(o, "totalData", "useData", "percentData", "BYTES", 1024),
      voice: metric(o, "totalVoice", "useVoice", "percentVoice", "SECONDS", 1),
      sms: metric(o, "totalMsg", "useMsg", "percentMsg", "COUNT", 1),
      sourceId: "tplus",
      fetchedAt: Date.now(),
    };
  },
};

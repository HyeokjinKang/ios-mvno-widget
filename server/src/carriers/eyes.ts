import { HttpEngine } from "../core/httpEngine.js";
import { LineRef, Metric, MetricUnit, UsageFormat, normalizeNetwork, isUnknownMetric, formatUnit } from "../types/model.js";
import { CarrierAdapter } from "./types.js";

// 문서의 EyesAdapter.kt 원문을 그대로 이식. HTML을 직접 정규식으로 파싱한다.
const WEB = "https://eyes.co.kr";
const WEB_WWW = "https://www.eyes.co.kr";
const SESSION_COOKIE = "ci_session";
const UNLIMITED = "기본제공";
const NOT_QUERIED = "조회전";
const NUMBER_RE = /([0-9]+(?:\.[0-9]+)?)/;
const SELECT_OPTION_RE = /<option[^>]*value="([0-9]{9,12})"[^>]*>([^<]*)<\/option>/g;
const NETWORK_RE = /<li class="primary">([^<]+)<\/li>/;
const PLAN_NAME_RE = /<div class="box">[\s\S]*?<p>([^<]+)<\/p>/;

function spanText(html: string, elementId: string): string | null {
  const m = new RegExp(`id="${elementId}"[^>]*>([^<]*)<`).exec(html);
  const v = m?.[1]?.trim();
  return v ? v : null;
}

function widthPercent(html: string, elementId: string): number | null {
  const m = new RegExp(`id="${elementId}"[^>]*style="[^"]*width:\\s*([0-9.]+)%`).exec(html);
  if (!m) return null;
  const n = parseFloat(m[1]);
  return Number.isNaN(n) ? null : Math.min(100, Math.max(0, Math.trunc(n)));
}

function textOf(html: string, re: RegExp): string | undefined {
  const v = re.exec(html)?.[1]?.trim();
  return v || undefined;
}

function fromText(v: string | null | undefined, unit: MetricUnit): number | null {
  if (!v) return null;
  if (unit === "BYTES") return UsageFormat.parseBytes(v);
  if (unit === "SECONDS") {
    const n = NUMBER_RE.exec(v)?.[1];
    if (n == null) return null;
    const num = parseFloat(n);
    return v.includes("초") ? Math.trunc(num) : Math.trunc(num * 60);
  }
  const n = NUMBER_RE.exec(v)?.[1];
  return n == null ? null : Math.trunc(parseFloat(n));
}

function ratio(used: number | null, total: number | null): number | null {
  if (used == null || total == null || total <= 0) return null;
  return Math.min(100, Math.max(0, Math.trunc((100 * Math.max(0, total - used)) / total)));
}

function withUnit(v: string | undefined, unit: MetricUnit): string | undefined {
  if (!v || !v.trim()) return undefined;
  const hasUnit = /[a-zA-Z가-힣]/.test(v) || v.includes("분") || v.includes("초") || v.includes("건");
  if (hasUnit) return v;
  if (unit === "SECONDS") return v + "분";
  if (unit === "COUNT") return v + "건";
  return v;
}

function metricFromHtml(html: string, prefix: string, unit: MetricUnit): Metric {
  const remainText = spanText(html, prefix + "Change1");
  const usedText = spanText(html, prefix + "Change2");
  const totalText = spanText(html, prefix + "Change3");
  const percent = widthPercent(html, prefix + "Change4");
  if (remainText == null && usedText == null && totalText == null) return Metric.UNKNOWN;
  if (remainText === NOT_QUERIED || totalText === NOT_QUERIED) return Metric.UNKNOWN;
  if (totalText === UNLIMITED || remainText === UNLIMITED) return Metric.unlimited(usedText ?? "-");
  const usedRaw = fromText(usedText, unit);
  const totalRaw = fromText(totalText, unit);
  // 아이즈는 HTML(Change1)에 남은 양을 직접 넣어주므로 그 문자열을 그대로 쓴다.
  const remainRaw = fromText(remainText, unit) ?? (usedRaw != null && totalRaw != null ? Math.max(0, totalRaw - usedRaw) : null);
  return {
    usedText: usedText ?? "-",
    totalText: totalText ?? "-",
    remainText: remainText ?? (remainRaw != null ? formatUnit(unit, remainRaw) : null),
    usedRaw,
    totalRaw,
    remainRaw,
    remainPercent: ratio(usedRaw, totalRaw) ?? percent,
    unlimited: false,
  };
}

function qty(o: any, unit: MetricUnit): Metric {
  if (!o) return Metric.UNKNOWN;
  const rawTotal: string | undefined = o.TOTAL_QTY != null && String(o.TOTAL_QTY).trim() !== "" ? String(o.TOTAL_QTY) : undefined;
  const rawUsed: string | undefined = o.USE_QTY != null && String(o.USE_QTY).trim() !== "" ? String(o.USE_QTY) : undefined;
  if (rawTotal === undefined && rawUsed === undefined) return Metric.UNKNOWN;
  if (rawTotal === UNLIMITED) return Metric.unlimited(withUnit(rawUsed, unit) ?? "-");
  const used = withUnit(rawUsed, unit);
  const total = withUnit(rawTotal, unit);
  const scale = unit === "BYTES" ? 1024 : 1;
  const useQty1 = o.USE_QTY1 != null ? Number(o.USE_QTY1) : NaN;
  const totalQty1 = o.TOTAL_QTY1 != null ? Number(o.TOTAL_QTY1) : NaN;
  const usedRaw = !Number.isNaN(useQty1) ? useQty1 * scale : fromText(used, unit);
  const totalRaw = !Number.isNaN(totalQty1) ? totalQty1 * scale : fromText(total, unit);
  const remainRaw = usedRaw != null && totalRaw != null ? Math.max(0, totalRaw - usedRaw) : null;
  return {
    usedText: used ?? "-",
    totalText: total ?? "-",
    remainText: remainRaw != null ? formatUnit(unit, remainRaw) : null,
    usedRaw,
    totalRaw,
    remainRaw,
    remainPercent: ratio(usedRaw, totalRaw),
    unlimited: false,
  };
}

function hostsInOrder(http: HttpEngine): string[] {
  return [WEB, WEB_WWW].sort((a, b) => {
    const score = (h: string) => (http.cookieHeader(h)?.includes(SESSION_COOKIE) ? 1 : 0);
    return score(b) - score(a);
  });
}

async function mainHtml(http: HttpEngine, serviceNumber: string | null): Promise<string | null> {
  for (const host of hostsInOrder(http)) {
    const res =
      serviceNumber == null
        ? await http.request({ method: "GET", url: `${host}/mypage/main`, origin: host, referer: `${host}/` })
        : await http.request({
            method: "POST",
            url: `${host}/mypage/main`,
            body: HttpEngine.form({ service_number: serviceNumber }),
            contentType: "application/x-www-form-urlencoded",
            origin: host,
            referer: `${host}/mypage/main`,
          });
    if (res.isSuccess && !eyesAdapter.isSessionExpired(res.code, res.body)) return res.body;
  }
  return null;
}

async function realtime(
  http: HttpEngine,
  serviceNumber: string,
): Promise<[Metric, Metric, Metric] | null> {
  for (const host of hostsInOrder(http)) {
    let res;
    try {
      res = await http.request({
        method: "POST",
        url: `${host}/mypage/usageData`,
        headers: { "X-Requested-With": "XMLHttpRequest" },
        body: HttpEngine.form({ service_number: serviceNumber }),
        contentType: "application/x-www-form-urlencoded; charset=UTF-8",
        origin: host,
        referer: `${host}/mypage/main`,
      });
    } catch {
      continue;
    }
    if (!res.isSuccess) continue;
    let o: any;
    try {
      o = JSON.parse(res.body);
    } catch {
      continue;
    }
    const arr = o.ResBody;
    if (o.ResCode !== "0000" || !Array.isArray(arr) || arr.length < 3) continue;
    return [qty(arr[2], "BYTES"), qty(arr[0], "SECONDS"), qty(arr[1], "COUNT")];
  }
  return null;
}

export const eyesAdapter: CarrierAdapter = {
  id: "eyes",
  displayName: "아이즈모바일",
  authKind: "credential",
  loginUrl: `${WEB}/`,
  allowedDomains: ["eyes.co.kr", "kakao.com", "naver.com"],
  supportsParallelLines: false,

  hasSession(http) {
    return http.hasCookie(WEB) || http.hasCookie(WEB_WWW);
  },

  async login(http, userId, password) {
    const host = hostsInOrder(http)[0];
    const boundary = "----MvnoWidget" + Date.now();
    const body =
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="login_id"\r\n\r\n${userId}\r\n` +
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="login_pw"\r\n\r\n${password}\r\n` +
      `--${boundary}--\r\n`;
    const res = await http.request({
      method: "POST",
      url: `${host}/member/get_login_v3`,
      headers: { "X-Requested-With": "XMLHttpRequest" },
      body,
      contentType: `multipart/form-data; boundary=${boundary}`,
      origin: host,
      referer: `${host}/`,
    });
    if (!res.isSuccess) return false;
    try {
      return (await eyesAdapter.fetchLines(http)).length > 0;
    } catch {
      return false;
    }
  },

  matchesPartnerName(name) {
    return !!name?.includes("아이즈");
  },

  isSessionExpired(code, body) {
    if (code === 401 || code === 403) return true;
    if (body.includes('id="service_number"')) return false;
    return body.includes('id="login_id"') || body.includes("/member/get_login");
  },

  async fetchLines(http) {
    const html = await mainHtml(http, null);
    if (!html) return [];
    const out: LineRef[] = [];
    for (const m of html.matchAll(SELECT_OPTION_RE)) {
      const value = m[1].trim();
      const text = m[2].trim();
      if (!value) continue;
      out.push({
        id: value,
        label: text || value,
        phone: value.replace(/\D/g, ""),
        carrierName: "아이즈모바일",
      });
    }
    return out;
  },

  async fetchUsage(http, line) {
    const html = await mainHtml(http, line.id);
    if (!html) throw new Error("아이즈 사용량 페이지를 가져오지 못했습니다");
    let data = metricFromHtml(html, "data", "BYTES");
    let voice = metricFromHtml(html, "voice", "SECONDS");
    let sms = metricFromHtml(html, "sms", "COUNT");
    if (isUnknownMetric(data)) {
      const rt = await realtime(http, line.id);
      if (rt) [data, voice, sms] = rt;
    }
    return {
      lineKey: line.phone || line.id,
      label: line.label,
      planName: textOf(html, PLAN_NAME_RE),
      carrierName: "아이즈모바일",
      network: normalizeNetwork(textOf(html, NETWORK_RE)) ?? undefined,
      data,
      voice,
      sms,
      sourceId: "eyes",
      fetchedAt: Date.now(),
    };
  },
};

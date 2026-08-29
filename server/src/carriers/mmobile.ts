import { HttpEngine } from "../core/httpEngine.js";
import { LineRef, Metric, MetricUnit, SessionExpiredError, UsageFormat } from "../types/model.js";
import { CarrierAdapter } from "./types.js";

// KT M모바일(엠모바일). 원본 문서에는 없던 사업자라 사이트를 직접 조사해 붙였다.
//
// 로그인 폼(userId/passWord)에 reCAPTCHA v3가 걸려 있어 아이디/비번을 그대로 POST하면
// 막힌다. 그래서 다른 credential 사업자들과 달리 원격 브라우저(webonly)로 처리한다.
// 브라우저가 reCAPTCHA를 통과시키고 나면 그 쿠키로 일반 요청을 보낼 수 있다.
const WEB = "https://www.ktmmobile.com";
const USAGE_PATH = "/m/mypage/callView01.do";

// 미로그인 상태로 마이페이지를 열면 /m/loginForm.do?uri=... 로 넘어간다.
function looksLikeLoginPage(body: string): boolean {
  return body.includes('name="passWord"') || body.includes("loginForm.do");
}

async function usageHtml(http: HttpEngine): Promise<string> {
  const res = await http.request({
    method: "GET",
    url: WEB + USAGE_PATH,
    origin: WEB,
    referer: `${WEB}/m/main.do`,
  });
  if (mmobileAdapter.isSessionExpired(res.code, res.body)) throw new SessionExpiredError();
  if (!res.isSuccess) throw new Error(`엠모바일 사용량 페이지 조회 실패: HTTP ${res.code}`);
  return res.body;
}

function textOf(html: string, re: RegExp): string | undefined {
  const v = re.exec(html)?.[1]?.replace(/<[^>]*>/g, "").trim();
  return v || undefined;
}

// 사용량 표기는 "3.5GB / 10GB", "150분 / 300분", "20건 / 100건" 형태로 붙어 나온다.
// 무제한은 숫자 대신 "무제한"이 들어간다.
function parseMetric(usedText: string | undefined, totalText: string | undefined, unit: MetricUnit): Metric {
  if (!usedText && !totalText) return Metric.UNKNOWN;
  if (totalText && /무제한|기본제공/.test(totalText)) return Metric.unlimited(usedText ?? "-");
  const used = parseAmount(usedText, unit);
  const total = parseAmount(totalText, unit);
  if (used == null || total == null) {
    return {
      usedText: usedText ?? "-",
      totalText: totalText ?? "-",
      remainText: null,
      unlimited: false,
    };
  }
  return Metric.ofRaw(used, total, unit);
}

function parseAmount(text: string | undefined, unit: MetricUnit): number | null {
  if (!text) return null;
  if (unit === "BYTES") return UsageFormat.parseBytes(text);
  const n = /([0-9]+(?:\.[0-9]+)?)/.exec(text.replace(/,/g, ""))?.[1];
  if (n == null) return null;
  const v = parseFloat(n);
  if (unit === "SECONDS") return text.includes("초") ? Math.trunc(v) : Math.trunc(v * 60);
  return Math.trunc(v);
}

export const mmobileAdapter: CarrierAdapter = {
  id: "mmobile",
  displayName: "KT M모바일",
  authKind: "webonly",
  loginUrl: `${WEB}/m/loginForm.do?uri=${encodeURIComponent(USAGE_PATH)}`,
  allowedDomains: ["ktmmobile.com", "kakao.com", "kauth.kakao.com", "naver.com", "nid.naver.com"],

  hasSession(http) {
    return http.hasCookie(WEB) || http.hasCookie("ktmmobile.com");
  },

  isLoginComplete(url) {
    return url.includes("/mypage/") && !url.includes("loginForm.do");
  },

  matchesPartnerName(name) {
    return !!name && (name.includes("엠모바일") || name.includes("M모바일"));
  },

  isSessionExpired(code, body) {
    if (code === 401 || code === 403) return true;
    if (code < 200 || code > 299) return false;
    return looksLikeLoginPage(body);
  },

  async fetchLines(http) {
    const html = await usageHtml(http);
    // 회선 선택 <select>가 있으면 다회선, 없으면 단일 회선이다.
    const options = [...html.matchAll(/<option[^>]*value="([^"]{6,})"[^>]*>([^<]*)<\/option>/g)]
      .map((m) => ({ value: m[1].trim(), text: m[2].trim() }))
      .filter((o) => /[0-9]{3}[-*]/.test(o.text));

    if (options.length > 0) {
      return options.map<LineRef>((o) => ({
        id: o.value,
        label: o.text || o.value,
        phone: o.text.replace(/[^\d*]/g, "") || undefined,
        carrierName: "KT M모바일",
      }));
    }

    const phone = textOf(html, /(01[016789][-\s]?[0-9*]{3,4}[-\s]?[0-9*]{4})/);
    return [
      {
        id: "default",
        label: phone ?? "KT M모바일",
        phone: phone?.replace(/[^\d*]/g, ""),
        carrierName: "KT M모바일",
      },
    ];
  },

  async fetchUsage(http, line) {
    const html = await usageHtml(http);
    const data = parseMetric(
      textOf(html, /데이터[\s\S]{0,400}?([0-9.,]+\s*(?:KB|MB|GB|TB))/i),
      textOf(html, /데이터[\s\S]{0,400}?\/\s*([0-9.,]+\s*(?:KB|MB|GB|TB)|무제한)/i),
      "BYTES",
    );
    const voice = parseMetric(
      textOf(html, /음성|통화[\s\S]{0,400}?([0-9.,]+\s*분)/),
      textOf(html, /음성|통화[\s\S]{0,400}?\/\s*([0-9.,]+\s*분|무제한)/),
      "SECONDS",
    );
    const sms = parseMetric(
      textOf(html, /문자[\s\S]{0,400}?([0-9.,]+\s*건)/),
      textOf(html, /문자[\s\S]{0,400}?\/\s*([0-9.,]+\s*건|무제한)/),
      "COUNT",
    );

    return {
      lineKey: line.phone || `mmobile:${line.id}`,
      label: line.label,
      planName: textOf(html, /요금제[\s\S]{0,200}?<[^>]*>([^<]{3,40})</),
      carrierName: "KT M모바일",
      network: "KT",
      data,
      voice,
      sms,
      sourceId: "mmobile",
      fetchedAt: Date.now(),
    };
  },
};

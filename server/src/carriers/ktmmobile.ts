import { mkdirSync, writeFileSync } from "node:fs";
import { HttpEngine } from "../core/httpEngine.js";
import { LineRef, Metric, MetricUnit, SessionExpiredError, formatUnit } from "../types/model.js";
import { CarrierAdapter } from "./types.js";

// kt M모바일(엠모바일). 원본 명세 문서에는 없는 사업자라 사이트를 직접 보고 붙였다.
//
// - 로그인 폼에 reCAPTCHA v3와 SMS 추가인증이 걸려 있어 서버가 아이디/비밀번호를 직접 POST할 수
//   없다. 그래서 알닷/핀다이렉트처럼 원격 브라우저(webonly)로 로그인한다. 아이디 로그인과
//   네이버/카카오 간편 로그인 모두 그 화면에서 할 수 있다.
// - 이용량은 JSON API가 아니라 서버 렌더링 HTML(/mypage/callView01.do)이다. 회선 선택은
//   <select id="ctn">의 option(value = 계약번호 ncn)이고, 다른 회선은 ncn을 POST해서 다시 받는다.
// - 로그인 후 페이지 마크업을 직접 확인하지 못했으므로 사용량 파싱은 특정 클래스명에 기대지 않고
//   "데이터/음성/문자" 구역 안의 "제공/사용/잔여" 문구와 수치를 읽는 방식으로 짰다. 파싱에 실패하면
//   MVNO_DEBUG_DUMP=1 일 때 data/debug/ 에 HTML을 남겨 마크업을 맞출 수 있게 한다.
const WEB = "https://www.ktmmobile.com";
const USAGE_PATH = "/mypage/callView01.do";
const NETWORK = "KT";

const DATA_DIR = process.env.MVNO_DATA_DIR ?? new URL("../../data", import.meta.url).pathname;

function decodeEntities(s: string): string {
  return s
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&amp;/g, "&");
}

function stripTags(html: string): string {
  return decodeEntities(
    html
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<!--[\s\S]*?-->/g, " ")
      .replace(/<[^>]+>/g, " "),
  )
    .replace(/\s+/g, " ")
    .trim();
}

function looksLikeLoginPage(body: string): boolean {
  return (
    body.includes("loginForm.js") ||
    body.includes('id="passWord"') ||
    /<link rel="canonical" href="[^"]*loginForm\.do/.test(body)
  );
}

interface LineOption {
  ncn: string;
  text: string;
}

function selectOptions(html: string, id: string): LineOption[] {
  const sel = new RegExp(`<select[^>]*\\bid="${id}"[^>]*>([\\s\\S]*?)</select>`).exec(html);
  if (!sel) return [];
  const out: LineOption[] = [];
  for (const m of sel[1].matchAll(/<option([^>]*)>([\s\S]*?)<\/option>/g)) {
    const value = /\bvalue="([^"]*)"/.exec(m[1])?.[1]?.trim();
    if (!value) continue;
    out.push({ ncn: value, text: stripTags(m[2]) });
  }
  return out;
}

function hiddenValue(html: string, name: string): string | undefined {
  const m =
    new RegExp(`<input[^>]*\\bname="${name}"[^>]*\\bvalue="([^"]+)"`).exec(html) ??
    new RegExp(`<input[^>]*\\bvalue="([^"]+)"[^>]*\\bname="${name}"`).exec(html);
  return m?.[1]?.trim() || undefined;
}

const PHONE_RE = /01[016789][-\s]?[0-9*]{3,4}[-\s]?[0-9*]{4}/;

function lineFromOption(o: LineOption): LineRef {
  const phone = PHONE_RE.exec(o.text)?.[0];
  // option 문구가 "010-12**-34** (요금제명)" 형태면 괄호 안을 요금제로 본다.
  const plan = /\(([^)]+)\)/.exec(o.text)?.[1]?.trim();
  return {
    id: o.ncn,
    label: phone ?? (o.text || o.ncn),
    phone: phone ? phone.replace(/[^\d*]/g, "") : undefined,
    planName: plan || undefined,
    carrierName: "kt M모바일",
    network: NETWORK,
  };
}

// 상단 메뉴(GNB)에도 "데이터", "문자" 같은 단어가 잔뜩 있으므로 본문 영역만 잘라낸다.
function contentRegion(html: string): string {
  const starts = [
    html.search(/<select[^>]*\bid="ctn"/),
    html.search(/<select[^>]*\bid="ncn"/),
    html.search(/c-indicator-arc/),
    html.search(/<main\b/),
  ].filter((i) => i >= 0);
  const start = starts.length ? Math.min(...starts) : Math.max(0, html.lastIndexOf("</header>"));
  const endIdx = html.indexOf("<footer", start);
  return html.slice(start, endIdx > start ? endIdx : undefined);
}

const CATEGORY_RE: Record<"data" | "voice" | "sms", RegExp> = {
  data: /데이터/g,
  voice: /음성|통화/g,
  sms: /문자|SMS|메시지/g,
};

/** 텍스트에서 단위가 붙은 수치 하나를 기본 단위(바이트/초/건)로 바꾼다. */
function parseAmount(text: string, unit: MetricUnit): number | null {
  if (unit === "BYTES") {
    const m = /([0-9][0-9,]*(?:\.[0-9]+)?)\s*(TB|GB|MB|KB)/i.exec(text);
    if (!m) return null;
    const n = parseFloat(m[1].replace(/,/g, ""));
    const mul = { TB: 1024 ** 4, GB: 1024 ** 3, MB: 1024 ** 2, KB: 1024 }[m[2].toUpperCase() as "TB" | "GB" | "MB" | "KB"];
    return Math.trunc(n * mul);
  }
  if (unit === "SECONDS") {
    const m = /([0-9][0-9,]*)\s*분(?:\s*([0-9]+)\s*초)?|([0-9][0-9,]*)\s*초/.exec(text);
    if (!m) return null;
    if (m[3] != null) return parseInt(m[3].replace(/,/g, ""), 10);
    return parseInt(m[1].replace(/,/g, ""), 10) * 60 + (m[2] ? parseInt(m[2], 10) : 0);
  }
  const m = /([0-9][0-9,]*)\s*(건|회|통)/.exec(text);
  return m ? parseInt(m[1].replace(/,/g, ""), 10) : null;
}

function amountPattern(unit: MetricUnit): string {
  if (unit === "BYTES") return "[0-9][0-9,]*(?:\\.[0-9]+)?\\s*(?:TB|GB|MB|KB)";
  if (unit === "SECONDS") return "(?:[0-9][0-9,]*\\s*분(?:\\s*[0-9]+\\s*초)?|[0-9][0-9,]*\\s*초)";
  return "[0-9][0-9,]*\\s*(?:건|회|통)";
}

function labeled(text: string, labels: string, unit: MetricUnit): number | null {
  const re = new RegExp(`(?:${labels})\\s*[:：]?\\s*(${amountPattern(unit)})`, "i");
  const m = re.exec(text);
  return m ? parseAmount(m[1], unit) : null;
}

function metricFromWindow(text: string, htmlWindow: string, unit: MetricUnit): Metric {
  let total = labeled(text, "기본\\s*제공량?|총\\s*제공량?|제공량|기본량|총량|제공", unit);
  let used = labeled(text, "사용량|사용한\\s*양|사용|이용량|이용", unit);
  let remain = labeled(text, "잔여량|잔여|남은\\s*(?:양|데이터|통화|문자)?|남음", unit);

  // "2.5GB / 10GB" 처럼 라벨 없이 사용/제공을 나란히 쓰는 형태
  if (used == null && total == null) {
    const pat = amountPattern(unit);
    const m = new RegExp(`(${pat})\\s*/\\s*(${pat})`, "i").exec(text);
    if (m) {
      used = parseAmount(m[1], unit);
      total = parseAmount(m[2], unit);
    }
  }

  const unlimited = /무제한/.test(text) || (/기본\s*제공/.test(text) && total == null && remain == null);
  if (unlimited && total == null) {
    return Metric.unlimited(used != null ? formatUnit(unit, used) : "-");
  }

  if (total == null && used != null && remain != null) total = used + remain;
  if (used == null && total != null && remain != null) used = Math.max(0, total - remain);

  if (total != null && used != null) {
    const m = Metric.ofRaw(used, total, unit);
    // 사이트가 잔여량을 따로 적어줬다면 그 값을 우선한다 (이월/쿠폰 등으로 단순 차와 다를 수 있음).
    if (remain != null) {
      m.remainRaw = remain;
      m.remainText = formatUnit(unit, remain);
      if (total > 0) m.remainPercent = Math.min(100, Math.max(0, Math.round((100 * remain) / total)));
    }
    return m;
  }

  if (remain != null) {
    const pct = /data-percent="([0-9.]+)"/.exec(htmlWindow)?.[1];
    return {
      usedText: used != null ? formatUnit(unit, used) : "-",
      totalText: "-",
      remainText: formatUnit(unit, remain),
      usedRaw: used,
      totalRaw: null,
      remainRaw: remain,
      remainPercent: pct != null ? Math.min(100, Math.max(0, Math.round(parseFloat(pct)))) : null,
      unlimited: false,
    };
  }
  return Metric.UNKNOWN;
}

/** 본문을 데이터/음성/문자 구역으로 나눠 각 구역의 사용량을 읽는다. */
export function parseUsageHtml(html: string): { data: Metric; voice: Metric; sms: Metric } {
  const region = contentRegion(html);
  // 구역 경계는 HTML 기준으로 잡아야 data-percent 같은 속성도 함께 볼 수 있다.
  // 라벨은 태그 밖 텍스트에서만 찾는다.
  const marks: { key: "data" | "voice" | "sms"; at: number }[] = [];
  const textNodeRe = />([^<]+)</g;
  for (const m of region.matchAll(textNodeRe)) {
    const t = m[1];
    for (const key of ["data", "voice", "sms"] as const) {
      const re = new RegExp(CATEGORY_RE[key].source);
      if (re.test(t) && t.trim().length <= 20) {
        // 제목처럼 짧은 텍스트만 구역 시작으로 본다 (안내 문장 속 단어는 제외).
        marks.push({ key, at: m.index! });
        break;
      }
    }
  }
  // 같은 종류가 연속되면 첫 위치만 남긴다.
  const sections: { key: "data" | "voice" | "sms"; start: number; end: number }[] = [];
  for (const mk of marks) {
    const last = sections[sections.length - 1];
    if (last && last.key === mk.key) continue;
    if (last) last.end = mk.at;
    sections.push({ key: mk.key, start: mk.at, end: region.length });
  }

  const unitOf = { data: "BYTES", voice: "SECONDS", sms: "COUNT" } as const;
  const result = { data: Metric.UNKNOWN, voice: Metric.UNKNOWN, sms: Metric.UNKNOWN };
  for (const s of sections) {
    if (result[s.key] !== Metric.UNKNOWN) continue;
    const win = region.slice(s.start, s.end);
    const m = metricFromWindow(stripTags(win), win, unitOf[s.key]);
    if (m !== Metric.UNKNOWN) result[s.key] = m;
  }
  return result;
}

function dumpForDebug(html: string): void {
  if (process.env.MVNO_DEBUG_DUMP !== "1") return;
  try {
    const dir = `${DATA_DIR}/debug`;
    mkdirSync(dir, { recursive: true });
    writeFileSync(`${dir}/ktmmobile-callView01.html`, html, { mode: 0o600 });
    console.warn(`[ktmmobile] 사용량을 읽지 못해 ${dir}/ktmmobile-callView01.html 에 원본을 저장했습니다`);
  } catch {
    // 디버그 저장 실패는 무시
  }
}

async function usagePage(http: HttpEngine, ncn: string | null): Promise<string> {
  const res =
    ncn == null
      ? await http.request({ method: "GET", url: WEB + USAGE_PATH, origin: WEB, referer: `${WEB}/main.do` })
      : await http.request({
          method: "POST",
          url: WEB + USAGE_PATH,
          body: HttpEngine.form({ ncn }),
          contentType: "application/x-www-form-urlencoded",
          origin: WEB,
          referer: WEB + USAGE_PATH,
        });
  if (ktmmobileAdapter.isSessionExpired(res.code, res.body)) throw new SessionExpiredError();
  if (!res.isSuccess) throw new Error(`kt M모바일 이용량 페이지 조회 실패: HTTP ${res.code}`);
  return res.body;
}

function isUsageUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return u.hostname.endsWith("ktmmobile.com") && /^\/(m\/)?mypage\//.test(u.pathname);
  } catch {
    return false;
  }
}

export const ktmmobileAdapter: CarrierAdapter = {
  id: "ktmmobile",
  displayName: "kt M모바일",
  authKind: "webonly",
  // 로그인 후 곧바로 이용량 페이지로 돌아오게 uri를 붙인다. 그 주소에 도달하면 완료로 본다.
  loginUrl: `${WEB}/loginForm.do?uri=${encodeURIComponent(USAGE_PATH)}`,
  allowedDomains: ["ktmmobile.com", "naver.com", "naver.net", "kakao.com", "kakao.co.kr", "google.com", "gstatic.com"],
  // 회선 전환이 "ncn을 POST해서 페이지를 다시 받는" 방식이라 서버측 선택 상태가 바뀔 수 있다.
  supportsParallelLines: false,
  // 전용 세션 연장 API가 없어 마이페이지 조회로 세션을 살려둔다. 30분 주기 갱신마다 확인되도록 짧게 둔다.
  refreshWindowMs: 10 * 60 * 1000,

  hasSession(http) {
    return http.hasCookie(WEB);
  },

  isLoginComplete(url) {
    return isUsageUrl(url);
  },

  // 간편 로그인 등으로 uri를 잃고 메인으로 돌아오면 이용량 페이지로 가 보고,
  // 로그인 화면으로 튕기지 않으면 완료로 본다.
  loginProbeFor(url) {
    try {
      const u = new URL(url);
      if (!u.hostname.endsWith("ktmmobile.com")) return null;
      return /^\/(m\/)?(main\.do)?$/.test(u.pathname) ? WEB + USAGE_PATH : null;
    } catch {
      return null;
    }
  },

  async refreshSession(http) {
    try {
      await usagePage(http, null);
      return true;
    } catch {
      return false;
    }
  },

  matchesPartnerName(name) {
    return !!name && /kt\s*m\s*모바일|엠모바일|ktm/i.test(name);
  },

  isSessionExpired(code, body) {
    if (code === 401 || code === 403) return true;
    // 미로그인 시 loginForm.do로 302 → 따라간 결과 로그인 화면 HTML이 200으로 온다.
    return code >= 200 && code < 300 && looksLikeLoginPage(body);
  },

  async fetchLines(http) {
    const html = await usagePage(http, null);
    let opts = selectOptions(html, "ctn");
    if (opts.length === 0) opts = selectOptions(html, "ncn");
    if (opts.length > 0) return opts.map(lineFromOption);
    // 단일 회선이라 선택 상자가 없는 경우
    const ncn = hiddenValue(html, "ncn") ?? "default";
    const region = stripTags(contentRegion(html));
    return [lineFromOption({ ncn, text: PHONE_RE.exec(region)?.[0] ?? "kt M모바일" })];
  },

  async fetchUsage(http, line) {
    const html = await usagePage(http, line.id === "default" ? null : line.id);
    const { data, voice, sms } = parseUsageHtml(html);
    if (data === Metric.UNKNOWN && voice === Metric.UNKNOWN && sms === Metric.UNKNOWN) {
      dumpForDebug(html);
      throw new Error("kt M모바일 이용량 화면에서 사용량을 찾지 못했습니다");
    }
    return {
      lineKey: line.phone || `ktmmobile:${line.id}`,
      label: line.label,
      planName: line.planName,
      carrierName: "kt M모바일",
      network: NETWORK,
      data,
      voice,
      sms,
      sourceId: "ktmmobile",
      fetchedAt: Date.now(),
    };
  },
};

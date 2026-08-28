// Kotlin 원본(Metric/MetricUnit/UsageFormat/LineRef/LineUsage/normalizeNetwork)을 그대로 이식.

export type MetricUnit = "BYTES" | "SECONDS" | "COUNT";

const KB = 1024;
const MB = 1024 * 1024;
const GB = 1024 * 1024 * 1024;

function trim(v: number): string {
  const r = Math.round(v * 10) / 10;
  return r >= 10 || r % 1 === 0 ? r.toFixed(0) : r.toFixed(1);
}

export const UsageFormat = {
  bytes(v: number): string {
    if (v >= GB) return trim(v / GB) + "GB";
    if (v >= MB) return trim(v / MB) + "MB";
    return trim(v / KB) + "KB";
  },
  minutes(seconds: number): string {
    return `${Math.floor(seconds / 60)}분`;
  },
  parseBytes(text: string | null | undefined): number | null {
    if (!text) return null;
    const re = /([0-9]+(?:\.[0-9]+)?)\s*([GMK])B?/gi;
    let total = 0;
    let matched = false;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) {
      matched = true;
      const n = parseFloat(m[1]);
      if (Number.isNaN(n)) continue;
      const unit = m[2].toUpperCase();
      total += unit === "G" ? n * GB : unit === "M" ? n * MB : n * KB;
    }
    return matched ? Math.trunc(total) : null;
  },
};

export function formatUnit(unit: MetricUnit, v: number): string {
  switch (unit) {
    case "BYTES":
      return UsageFormat.bytes(v);
    case "SECONDS":
      return UsageFormat.minutes(v);
    case "COUNT":
      return `${v}건`;
  }
}

export interface Metric {
  usedText: string;
  totalText: string;
  /** 남은 사용량. 위젯은 used가 아니라 이 값을 주로 보여준다. 무제한/미상이면 null. */
  remainText?: string | null;
  usedRaw?: number | null;
  totalRaw?: number | null;
  remainRaw?: number | null;
  remainPercent?: number | null;
  unlimited: boolean;
}

export const Metric = {
  UNKNOWN: Object.freeze({ usedText: "-", totalText: "-", remainText: null, unlimited: false }) as Metric,
  // 무제한이면 "남은 양"이라는 개념이 없으므로 remainText를 비운다.
  unlimited(usedText = "-"): Metric {
    return { usedText, totalText: "무제한", remainText: null, unlimited: true };
  },
  ofRaw(used: number, total: number | null | undefined, unit: MetricUnit): Metric {
    const remain = total != null ? Math.max(0, total - used) : null;
    const pct =
      total != null && total > 0
        ? Math.min(100, Math.max(0, Math.round((100 * Math.max(0, total - used)) / total)))
        : null;
    return {
      usedText: formatUnit(unit, used),
      totalText: total != null ? formatUnit(unit, total) : "-",
      remainText: remain != null ? formatUnit(unit, remain) : null,
      usedRaw: used,
      totalRaw: total ?? null,
      remainRaw: remain,
      remainPercent: pct,
      unlimited: false,
    };
  },
};

// Kotlin data class의 구조적 동등성(==)을 흉내내기 위한 헬퍼. 참조 비교(===)는 쓸 수 없다.
export function isUnknownMetric(m: Metric): boolean {
  return m.usedText === "-" && m.totalText === "-" && !m.unlimited && m.usedRaw == null && m.totalRaw == null;
}

export function normalizeNetwork(raw: string | null | undefined): string | null {
  if (!raw || !raw.trim()) return null;
  const s = raw.toUpperCase().replace(/\s/g, "").replace(/망/g, "");
  if (s.includes("SKT") || s.includes("SK")) return "SKT";
  if (s.includes("LGU") || s.includes("LG") || s.includes("U+")) return "LGU+";
  if (s.includes("KT")) return "KT";
  return null;
}

export interface LineRef {
  id: string;
  label: string;
  phone?: string | null;
  planName?: string | null;
  carrierName?: string | null;
  network?: string | null;
  extra?: Record<string, string>;
}

export interface LineUsage {
  lineKey: string;
  label: string;
  /** 사용자가 지정한 회선 별칭. 위젯은 이게 있으면 label 대신 쓴다. */
  nickname?: string | null;
  /** 사업자별 회선 순번. 티플러스처럼 회선 ID가 바뀌는 곳의 별칭 폴백 키로 쓴다 (문서 §2.10). */
  ordinal?: number;
  planName?: string | null;
  carrierName?: string | null;
  network?: string | null;
  data: Metric;
  voice?: Metric | null;
  sms?: Metric | null;
  sourceId: string;
  fetchedAt: number;
}

export class SessionExpiredError extends Error {
  constructor(message = "세션이 만료되었습니다") {
    super(message);
    this.name = "SessionExpiredError";
  }
}

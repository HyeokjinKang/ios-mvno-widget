import { LineUsage, isUnknownMetric } from "../types/model.js";

// 문서 §2.9 중복 회선 처리: 알닷이 다른 사업자 회선을 함께 제공해 중복이 생긴다.
// 우선순위 = (사용량 없음 +10) + (알닷 +1); 낮을수록 우선.
function priority(line: LineUsage): number {
  let score = 0;
  if (isUnknownMetric(line.data)) score += 10;
  if (line.sourceId === "aldot") score += 1;
  return score;
}

function isRealPhoneKey(key: string): boolean {
  return /^\d{9,12}$/.test(key);
}

export function dedupeLines(lines: LineUsage[]): LineUsage[] {
  const groups = new Map<string, LineUsage[]>();
  const passthrough: LineUsage[] = [];
  for (const line of lines) {
    if (!isRealPhoneKey(line.lineKey)) {
      passthrough.push(line);
      continue;
    }
    const g = groups.get(line.lineKey) ?? [];
    g.push(line);
    groups.set(line.lineKey, g);
  }
  const deduped = [...groups.values()].map((g) => g.slice().sort((a, b) => priority(a) - priority(b))[0]);
  return [...deduped, ...passthrough];
}

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

// 원본 문서 §2.10 LabelStore 대응. 사용자가 지정한 회선 별칭을 보관한다.
// 비밀 값이 아니므로 세션과 달리 평문 JSON으로 저장한다.
//
// 별칭은 두 개의 키에 동시에 저장한다:
//   1) 회선 키       (예: "01012345678")
//   2) (사업자, 순번) (예: "tplus#0")
// 티플러스처럼 회선 ID가 세션마다 바뀌는 곳은 1)이 흔들리므로 2)로 폴백해서 별칭을 지킨다.

const DATA_DIR = process.env.MVNO_DATA_DIR ?? new URL("../../data", import.meta.url).pathname;
const FILE_PATH = `${DATA_DIR}/labels.json`;

export function fallbackKey(sourceId: string, ordinal: number | undefined): string | null {
  if (ordinal == null) return null;
  return `${sourceId}#${ordinal}`;
}

class LabelStore {
  private labels: Record<string, string> = {};

  constructor() {
    if (!existsSync(FILE_PATH)) return;
    try {
      this.labels = JSON.parse(readFileSync(FILE_PATH, "utf8"));
    } catch (err) {
      console.error("[labelStore] 별칭 파일 로드 실패, 빈 상태로 시작:", (err as Error).message);
      this.labels = {};
    }
  }

  private persist(): void {
    mkdirSync(dirname(FILE_PATH), { recursive: true });
    writeFileSync(FILE_PATH, JSON.stringify(this.labels, null, 2));
  }

  get(lineKey: string, sourceId: string, ordinal?: number): string | null {
    const direct = this.labels[lineKey];
    if (direct) return direct;
    const fb = fallbackKey(sourceId, ordinal);
    return (fb && this.labels[fb]) || null;
  }

  set(lineKey: string, sourceId: string, ordinal: number | undefined, nickname: string): void {
    const trimmed = nickname.trim();
    const fb = fallbackKey(sourceId, ordinal);
    if (!trimmed) {
      delete this.labels[lineKey];
      if (fb) delete this.labels[fb];
    } else {
      this.labels[lineKey] = trimmed;
      if (fb) this.labels[fb] = trimmed;
    }
    this.persist();
  }

  all(): Record<string, string> {
    return { ...this.labels };
  }
}

export const labelStore = new LabelStore();

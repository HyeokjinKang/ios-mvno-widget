import { LineUsage } from "../types/model.js";

export interface CarrierRefreshStatus {
  carrierId: string;
  ok: boolean;
  needsLogin: boolean;
  error?: string;
  updatedAt: number;
}

// 위젯은 갱신 "결과"가 아니라 이 StateStore를 읽는다 (문서 §갱신 흐름).
class StateStore {
  private lines: LineUsage[] = [];
  private statuses = new Map<string, CarrierRefreshStatus>();
  private lastRefreshAt: number | null = null;

  setCarrierLines(carrierId: string, lines: LineUsage[]): void {
    this.lines = this.lines.filter((l) => l.sourceId !== carrierId).concat(lines);
  }

  setStatus(status: CarrierRefreshStatus): void {
    this.statuses.set(status.carrierId, status);
  }

  markRefreshed(): void {
    this.lastRefreshAt = Date.now();
  }

  getLines(): LineUsage[] {
    return this.lines;
  }

  getStatuses(): CarrierRefreshStatus[] {
    return [...this.statuses.values()];
  }

  getLastRefreshAt(): number | null {
    return this.lastRefreshAt;
  }
}

export const stateStore = new StateStore();

import { HttpEngine } from "../core/httpEngine.js";
import { LineRef, LineUsage } from "../types/model.js";

export type AuthKind = "credential" | "webonly";

export interface CarrierAdapter {
  id: string;
  displayName: string;
  authKind: AuthKind;
  loginUrl: string;
  /** webonly: 원격 브라우저 로그인 시 허용할 도메인 화이트리스트 */
  allowedDomains?: string[];
  /** eyes처럼 회선 전환이 서버측 상태라 병렬 조회가 불가능한 경우 false */
  supportsParallelLines?: boolean;
  /** 갱신 여유시간(ms). aldot=45분, pindirect=7일 등 */
  refreshWindowMs?: number;

  hasSession(http: HttpEngine): boolean;
  /** webonly: 원격 브라우저가 이 URL에 도달하면 로그인 완료로 판단 */
  isLoginComplete?(url: string): boolean;
  /** credential: 아이디/비밀번호 직접 로그인 */
  login?(http: HttpEngine, userId: string, password: string): Promise<boolean>;
  /** 전용 세션 갱신 엔드포인트 호출 (조회 API만으로는 세션이 연장되지 않음) */
  refreshSession?(http: HttpEngine): Promise<boolean>;

  fetchLines(http: HttpEngine): Promise<LineRef[]>;
  fetchUsage(http: HttpEngine, line: LineRef): Promise<LineUsage>;
  isSessionExpired(code: number, body: string): boolean;
  matchesPartnerName?(name?: string | null): boolean;
}

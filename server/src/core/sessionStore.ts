import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { CookieJar } from "./cookieJar.js";
import { encrypt, decrypt } from "./crypto.js";

// 원본 SecureStore 대응. 통신사별 쿠키/토큰/보조정보를 프로세스 재시작 후에도 유지한다.
// 파일 전체를 AES-GCM으로 암호화해 디스크에 저장 (encryptedFilePath).

export interface CarrierState {
  cookies: ReturnType<CookieJar["toJSON"]> | Record<string, never>;
  extra: Record<string, string>;
  updatedAt: number;
  sessionExpiresAt?: number;
}

interface StoreFile {
  carriers: Record<string, CarrierState>;
}

const DATA_DIR = process.env.MVNO_DATA_DIR ?? new URL("../../data", import.meta.url).pathname;
const FILE_PATH = `${DATA_DIR}/sessions.enc`;

function emptyFile(): StoreFile {
  return { carriers: {} };
}

class SessionStore {
  private data: StoreFile = emptyFile();
  private jars = new Map<string, CookieJar>();

  constructor() {
    this.load();
  }

  private load(): void {
    if (!existsSync(FILE_PATH)) {
      this.data = emptyFile();
      return;
    }
    try {
      const raw = readFileSync(FILE_PATH, "utf8");
      this.data = raw.trim() ? (JSON.parse(decrypt(raw)) as StoreFile) : emptyFile();
    } catch (err) {
      console.error("[sessionStore] 세션 파일 로드 실패, 빈 상태로 시작:", (err as Error).message);
      this.data = emptyFile();
    }
  }

  private persist(): void {
    mkdirSync(dirname(FILE_PATH), { recursive: true });
    writeFileSync(FILE_PATH, encrypt(JSON.stringify(this.data)), { mode: 0o600 });
  }

  private ensure(carrierId: string): CarrierState {
    let state = this.data.carriers[carrierId];
    if (!state) {
      state = { cookies: {}, extra: {}, updatedAt: 0 };
      this.data.carriers[carrierId] = state;
    }
    return state;
  }

  jarFor(carrierId: string): CookieJar {
    let jar = this.jars.get(carrierId);
    if (!jar) {
      jar = CookieJar.fromJSON(this.ensure(carrierId).cookies);
      this.jars.set(carrierId, jar);
    }
    return jar;
  }

  getExtra(carrierId: string, key: string): string | undefined {
    return this.ensure(carrierId).extra[key];
  }

  setExtra(carrierId: string, key: string, value: string): void {
    const state = this.ensure(carrierId);
    state.extra[key] = value;
    this.save(carrierId);
  }

  getSessionExpiresAt(carrierId: string): number | undefined {
    return this.ensure(carrierId).sessionExpiresAt;
  }

  setSessionExpiresAt(carrierId: string, at: number): void {
    this.ensure(carrierId).sessionExpiresAt = at;
    this.save(carrierId);
  }

  getCredential(carrierId: string): { userId: string; password: string } | null {
    const state = this.ensure(carrierId);
    const userId = state.extra.credUserId;
    const password = state.extra.credPassword;
    if (!userId || !password) return null;
    return { userId, password };
  }

  setCredential(carrierId: string, userId: string, password: string): void {
    const state = this.ensure(carrierId);
    state.extra.credUserId = userId;
    state.extra.credPassword = password;
    this.save(carrierId);
  }

  clearCredential(carrierId: string): void {
    const state = this.ensure(carrierId);
    delete state.extra.credUserId;
    delete state.extra.credPassword;
    this.save(carrierId);
  }

  hasAnySession(carrierId: string): boolean {
    const state = this.data.carriers[carrierId];
    return !!state && Object.keys(state.cookies).length > 0;
  }

  clear(carrierId: string): void {
    delete this.data.carriers[carrierId];
    this.jars.delete(carrierId);
    this.persist();
  }

  /** 캐리어 어댑터가 쿠키를 갱신한 뒤 호출해 디스크에 반영한다. */
  save(carrierId: string): void {
    const state = this.ensure(carrierId);
    state.cookies = this.jarFor(carrierId).toJSON();
    state.updatedAt = Date.now();
    this.persist();
  }
}

export const sessionStore = new SessionStore();

// 통신사별 세션을 완전히 분리하기 위해 캐리어마다 별도 인스턴스를 사용한다.
//
// 두 가지 저장소를 구분한다:
//  - hostOnly: 우리가 직접 fetch로 받은 Set-Cookie (Domain 속성은 무시하고 응답 hostname에만 귀속).
//    eyes 어댑터가 요구하는 "www/비-www 쿠키는 다른 세션" 규칙이 자연히 성립한다.
//  - domainWide: 원격 브라우저(Playwright) 로그인에서 가져온 실제 쿠키. 브라우저가 보고하는
//    Domain 속성이 ".example.com" 형태(선행 점)면 서브도메인 전체에 적용되는 쿠키이므로 접미사 매칭한다.

export interface RawCookie {
  domain: string;
  name: string;
  value: string;
}

export class CookieJar {
  private hostOnly = new Map<string, Map<string, string>>();
  private domainWide = new Map<string, Map<string, string>>();

  private hostOf(urlOrHost: string): string {
    if (urlOrHost.includes("://")) return new URL(urlOrHost).hostname;
    return urlOrHost;
  }

  storeFromResponse(url: string, setCookieValues: string[]): void {
    if (setCookieValues.length === 0) return;
    const host = this.hostOf(url);
    const jar = this.hostOnly.get(host) ?? new Map<string, string>();
    for (const raw of setCookieValues) {
      const firstPair = raw.split(";")[0];
      const eq = firstPair.indexOf("=");
      if (eq <= 0) continue;
      jar.set(firstPair.slice(0, eq).trim(), firstPair.slice(eq + 1).trim());
    }
    this.hostOnly.set(host, jar);
  }

  /** Playwright `context.cookies()` 결과를 그대로 반영 (원격 브라우저 로그인 완료 후 호출). */
  importFromBrowser(cookies: RawCookie[]): void {
    for (const c of cookies) {
      if (!c.domain) continue;
      if (c.domain.startsWith(".")) {
        const domain = c.domain.slice(1);
        const jar = this.domainWide.get(domain) ?? new Map<string, string>();
        jar.set(c.name, c.value);
        this.domainWide.set(domain, jar);
      } else {
        const jar = this.hostOnly.get(c.domain) ?? new Map<string, string>();
        jar.set(c.name, c.value);
        this.hostOnly.set(c.domain, jar);
      }
    }
  }

  cookieHeader(urlOrHost: string): string | null {
    const host = this.hostOf(urlOrHost);
    const merged = new Map<string, string>();
    for (const [domain, jar] of this.domainWide) {
      if (host === domain || host.endsWith(`.${domain}`)) {
        for (const [k, v] of jar) merged.set(k, v);
      }
    }
    for (const [k, v] of this.hostOnly.get(host) ?? []) merged.set(k, v);
    if (merged.size === 0) return null;
    return [...merged.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
  }

  hasCookie(urlOrHost: string): boolean {
    const header = this.cookieHeader(urlOrHost);
    return !!header && header.length > 0;
  }

  clear(): void {
    this.hostOnly.clear();
    this.domainWide.clear();
  }

  toJSON(): { hostOnly: Record<string, Record<string, string>>; domainWide: Record<string, Record<string, string>> } {
    const dump = (m: Map<string, Map<string, string>>) => {
      const out: Record<string, Record<string, string>> = {};
      for (const [host, jar] of m) out[host] = Object.fromEntries(jar);
      return out;
    };
    return { hostOnly: dump(this.hostOnly), domainWide: dump(this.domainWide) };
  }

  static fromJSON(data: any): CookieJar {
    const jar = new CookieJar();
    // 구버전(단일 맵) 포맷과의 혼용을 피하기 위해 신버전 필드가 있을 때만 복원한다.
    for (const [host, cookies] of Object.entries<Record<string, string>>(data?.hostOnly ?? {})) {
      jar.hostOnly.set(host, new Map(Object.entries(cookies)));
    }
    for (const [domain, cookies] of Object.entries<Record<string, string>>(data?.domainWide ?? {})) {
      jar.domainWide.set(domain, new Map(Object.entries(cookies)));
    }
    return jar;
  }
}

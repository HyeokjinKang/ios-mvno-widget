import { CookieJar } from "./cookieJar.js";

// 원본 Android HttpEngine을 Node fetch 위에 재현.
// 보안 체크리스트(문서 §보안)를 따라 HTTPS만 허용하고 리다이렉트를 수동으로 처리한다.

export interface HttpRequestOptions {
  method: "GET" | "POST";
  url: string;
  query?: Record<string, string>;
  body?: string;
  contentType?: string;
  headers?: Record<string, string>;
  origin?: string;
  referer?: string;
}

export interface HttpResponse {
  code: number;
  body: string;
  isSuccess: boolean;
}

const MAX_REDIRECTS = 5;
const DEFAULT_UA =
  "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Mobile Safari/537.36";

export class HttpEngine {
  constructor(public jar: CookieJar) {}

  static form(fields: Record<string, string>): string {
    return new URLSearchParams(fields).toString();
  }

  hasCookie(urlOrHost: string): boolean {
    return this.jar.hasCookie(urlOrHost);
  }

  cookieHeader(urlOrHost: string): string | null {
    return this.jar.cookieHeader(urlOrHost);
  }

  async request(opts: HttpRequestOptions): Promise<HttpResponse> {
    let target = new URL(opts.url);
    if (opts.query) {
      for (const [k, v] of Object.entries(opts.query)) target.searchParams.set(k, v);
    }

    let redirects = 0;
    for (;;) {
      // 일부 사업자(엠모바일 등)는 Location 헤더를 http:// 로 내려준다. 평문으로 보내면
      // 쿠키가 노출되므로, 요청을 보내기 전에 https로 승격한다. 승격이 불가능한 스킴이면
      // 그대로 거부한다.
      if (target.protocol === "http:") target.protocol = "https:";
      if (target.protocol !== "https:") {
        throw new Error(`HTTPS만 허용됨: ${target.toString()}`);
      }

      const headers: Record<string, string> = {
        "User-Agent": DEFAULT_UA,
        Accept: "*/*",
        ...opts.headers,
      };
      if (opts.contentType) headers["Content-Type"] = opts.contentType;
      if (opts.origin) headers.Origin = opts.origin;
      if (opts.referer) headers.Referer = opts.referer;
      const cookie = this.jar.cookieHeader(target.toString());
      if (cookie) headers.Cookie = cookie;

      const res = await fetch(target.toString(), {
        method: opts.method,
        headers,
        body: opts.method === "POST" ? opts.body ?? "" : undefined,
        redirect: "manual",
      });

      const setCookies =
        typeof (res.headers as any).getSetCookie === "function"
          ? ((res.headers as any).getSetCookie() as string[])
          : [];
      this.jar.storeFromResponse(target.toString(), setCookies);

      if (res.status >= 300 && res.status < 400) {
        const location = res.headers.get("location");
        if (!location || redirects >= MAX_REDIRECTS) {
          return { code: res.status, body: await res.text().catch(() => ""), isSuccess: false };
        }
        target = new URL(location, target);
        redirects += 1;
        continue;
      }

      const body = await res.text();
      return { code: res.status, body, isSuccess: res.status >= 200 && res.status < 300 };
    }
  }
}

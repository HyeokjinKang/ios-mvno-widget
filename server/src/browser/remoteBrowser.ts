import { chromium, Browser, BrowserContext, Page, CDPSession } from "playwright";
import { EventEmitter } from "node:events";
import { CarrierAdapter } from "../carriers/types.js";
import { sessionStore } from "../core/sessionStore.js";
import { refreshCarrier } from "../engine/refreshEngine.js";

// aldot/pindirect는 네이버/카카오 소셜 로그인을 WebView 팝업으로 처리한다 (문서 참고).
// 이를 웹에서 재현하기 위해 서버에서 실제 브라우저(Playwright)를 띄우고 CDP 스크린캐스트로
// 화면을 스트리밍, 사용자의 마우스/키보드 입력을 그대로 그 브라우저에 전달한다.
// 로그인이 끝나면(carrier.isLoginComplete) 브라우저의 쿠키를 추출해 CookieJar에 반영하고
// 이후의 실제 API 호출은 항상 일반 fetch로 수행한다 (브라우저는 로그인 순간에만 필요).

const UA = "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36";
const VIEWPORT = { width: 430, height: 820 };

export type RemoteLoginEvent =
  | { type: "frame"; data: string }
  | { type: "url"; url: string }
  | { type: "completed" }
  | { type: "error"; message: string }
  | { type: "closed" };

class RemoteLoginSession extends EventEmitter {
  browser: Browser | null = null;
  context: BrowserContext | null = null;
  page: Page | null = null;
  cdp: CDPSession | null = null;
  completed = false;
  closed = false;

  constructor(public carrier: CarrierAdapter) {
    super();
  }

  async start(): Promise<void> {
    this.browser = await chromium.launch({ headless: true });
    this.context = await this.browser.newContext({ viewport: VIEWPORT, userAgent: UA, locale: "ko-KR" });
    this.page = await this.context.newPage();
    this.cdp = await this.context.newCDPSession(this.page);
    await this.cdp.send("Page.startScreencast", {
      format: "jpeg",
      quality: 65,
      maxWidth: VIEWPORT.width,
      maxHeight: VIEWPORT.height,
    });

    this.cdp.on("Page.screencastFrame", async (frame: any) => {
      this.emit("event", { type: "frame", data: frame.data } satisfies RemoteLoginEvent);
      try {
        await this.cdp?.send("Page.screencastFrameAck", { sessionId: frame.sessionId });
      } catch {
        // 세션이 이미 닫혔으면 무시
      }
    });

    this.page.on("framenavigated", (frame) => {
      if (frame !== this.page?.mainFrame()) return;
      this.emit("event", { type: "url", url: frame.url() } satisfies RemoteLoginEvent);
      if (!this.completed && this.carrier.isLoginComplete?.(frame.url())) {
        this.finish().catch((err) => this.fail(err));
      }
    });

    this.page.on("popup", (popup) => {
      // 카카오/네이버 팝업 로그인 창도 같은 방식으로 스크린캐스트에 태운다.
      this.attachPopup(popup).catch((err) => this.fail(err));
    });

    try {
      await this.page.goto(this.carrier.loginUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
    } catch (err) {
      this.fail(err as Error);
    }
  }

  private async attachPopup(popup: Page): Promise<void> {
    const cdp = await this.context!.newCDPSession(popup);
    await cdp.send("Page.startScreencast", { format: "jpeg", quality: 65, maxWidth: VIEWPORT.width, maxHeight: VIEWPORT.height });
    cdp.on("Page.screencastFrame", async (frame: any) => {
      this.emit("event", { type: "frame", data: frame.data } satisfies RemoteLoginEvent);
      try {
        await cdp.send("Page.screencastFrameAck", { sessionId: frame.sessionId });
      } catch {
        // ignore
      }
    });
    // 팝업이 활성 입력 대상이 되도록 전환
    this.activePage = popup;
    this.activeCdp = cdp;
    popup.on("close", () => {
      this.activePage = this.page ?? undefined;
      this.activeCdp = this.cdp ?? undefined;
    });
    popup.on("framenavigated", (frame) => {
      if (frame !== popup.mainFrame()) return;
      if (!this.completed && this.carrier.isLoginComplete?.(frame.url())) {
        this.finish().catch((err) => this.fail(err));
      }
    });
  }

  activePage?: Page;
  activeCdp?: CDPSession;

  private targetPage(): Page {
    return this.activePage ?? this.page!;
  }

  async click(x: number, y: number): Promise<void> {
    const page = this.targetPage();
    await page.mouse.click(x, y).catch(() => {});
  }

  async type(text: string): Promise<void> {
    await this.targetPage().keyboard.insertText(text).catch(() => {});
  }

  async key(key: string): Promise<void> {
    await this.targetPage().keyboard.press(key).catch(() => {});
  }

  async scroll(deltaY: number): Promise<void> {
    const page = this.targetPage();
    await page.mouse.wheel(0, deltaY).catch(() => {});
  }

  private async finish(): Promise<void> {
    if (this.completed || !this.context) return;
    this.completed = true;
    const cookies = await this.context.cookies();
    const jar = sessionStore.jarFor(this.carrier.id);
    jar.importFromBrowser(cookies.map((c) => ({ domain: c.domain, name: c.name, value: c.value })));
    sessionStore.save(this.carrier.id);
    this.emit("event", { type: "completed" } satisfies RemoteLoginEvent);
    await this.close();
    refreshCarrier(this.carrier.id).catch((err) => console.error("[remoteBrowser] 로그인 직후 갱신 실패:", err));
  }

  private fail(err: Error): void {
    console.error(`[remoteBrowser] ${this.carrier.id} 원격 로그인 오류:`, err.message);
    this.emit("event", { type: "error", message: err.message } satisfies RemoteLoginEvent);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.emit("event", { type: "closed" } satisfies RemoteLoginEvent);
    await this.page?.close().catch(() => {});
    await this.context?.close().catch(() => {});
    await this.browser?.close().catch(() => {});
  }
}

const sessions = new Map<string, RemoteLoginSession>();

export async function startRemoteLogin(carrier: CarrierAdapter): Promise<RemoteLoginSession> {
  await sessions.get(carrier.id)?.close();
  const session = new RemoteLoginSession(carrier);
  sessions.set(carrier.id, session);
  await session.start();
  return session;
}

export function getRemoteLogin(carrierId: string): RemoteLoginSession | undefined {
  return sessions.get(carrierId);
}

export async function stopRemoteLogin(carrierId: string): Promise<void> {
  const session = sessions.get(carrierId);
  if (session) {
    await session.close();
    sessions.delete(carrierId);
  }
}

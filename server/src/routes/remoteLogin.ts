import type { Server as HttpServer } from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import { Router } from "express";
import { getCarrier, CARRIERS } from "../carriers/index.js";
import { startRemoteLogin, stopRemoteLogin, getRemoteLogin } from "../browser/remoteBrowser.js";

// aldot / pindirect 처럼 소셜 로그인이 필요한 통신사는 서버가 실제 브라우저를 띄우고
// CDP 스크린캐스트로 화면을 웹 클라이언트에 스트리밍한다. 클라이언트는 캔버스를 클릭/입력하면
// 그 좌표/텍스트가 WebSocket을 통해 서버의 Playwright 페이지에 그대로 전달된다.

export const remoteLoginRouter = Router();

remoteLoginRouter.get("/api/remote-login/carriers", (_req, res) => {
  res.json(CARRIERS.filter((c) => c.authKind === "webonly").map((c) => ({ id: c.id, displayName: c.displayName })));
});

remoteLoginRouter.post("/api/remote-login/:carrierId/stop", async (req, res) => {
  await stopRemoteLogin(req.params.carrierId);
  res.json({ ok: true });
});

export function registerRemoteLoginWs(server: HttpServer): void {
  const wss = new WebSocketServer({ noServer: true });

  server.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url ?? "", "http://internal");
    const match = url.pathname.match(/^\/ws\/remote-login\/([a-z]+)$/);
    if (!match) return;
    const carrierId = match[1];
    let carrier;
    try {
      carrier = getCarrier(carrierId);
    } catch {
      socket.destroy();
      return;
    }
    if (carrier.authKind !== "webonly") {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      handleConnection(ws, carrierId).catch((err) => {
        console.error("[remoteLoginWs] 연결 처리 실패:", err);
        ws.close();
      });
    });
  });
}

async function handleConnection(ws: WebSocket, carrierId: string): Promise<void> {
  const carrier = getCarrier(carrierId);
  const existing = getRemoteLogin(carrierId);
  const reusable = existing && !existing.completed && !existing.closed;
  const session = reusable ? existing! : await startRemoteLogin(carrier);

  const listener = (event: any) => {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(event));
  };
  session.on("event", listener);

  ws.on("message", (raw) => {
    let msg: any;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }
    switch (msg.type) {
      case "click":
        session.click(Number(msg.x), Number(msg.y));
        break;
      case "type":
        session.type(String(msg.text ?? ""));
        break;
      case "key":
        session.key(String(msg.key ?? ""));
        break;
      case "scroll":
        session.scroll(Number(msg.deltaY ?? 0));
        break;
    }
  });

  ws.on("close", () => {
    session.off("event", listener);
    // 브라우저는 로그인 완료/명시적 stop 전까지 유지 (재접속 대비). 완료됐다면 이미 close된 상태.
  });
}

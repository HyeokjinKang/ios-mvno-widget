const carriersEl = document.getElementById("carriers");
const usageListEl = document.getElementById("usageList");
const lastRefreshEl = document.getElementById("lastRefresh");
const refreshBtn = document.getElementById("refreshBtn");

const modal = document.getElementById("remoteModal");
const canvas = document.getElementById("remoteCanvas");
const ctx = canvas.getContext("2d");
const remoteTitle = document.getElementById("remoteTitle");
const remoteStatus = document.getElementById("remoteStatus");
const remoteInput = document.getElementById("remoteInput");
let ws = null;

function statusBadge(status) {
  if (!status) return `<span class="badge unknown">대기중</span>`;
  if (status.needsLogin) return `<span class="badge needs-login">로그인 필요</span>`;
  if (!status.ok) return `<span class="badge error" title="${escapeHtml(status.error ?? "")}">오류</span>`;
  return `<span class="badge ok">정상</span>`;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

async function loadStatus() {
  const res = await fetch("/api/status");
  const data = await res.json();
  // 입력 중인 폼이 있으면 주기 갱신이 입력값을 지우지 않도록 해당 영역 렌더를 건너뛴다.
  const active = document.activeElement;
  if (!active?.closest?.("form.cred-form")) renderCarriers(data.carriers, data.statuses);
  if (!active?.closest?.("form.nick-form")) renderUsage(data.lines);
  lastRefreshEl.textContent = data.lastRefreshAt ? `마지막 갱신: ${new Date(data.lastRefreshAt).toLocaleString("ko-KR")}` : "아직 갱신 안 됨";
}

function renderCarriers(carriers, statuses) {
  const byId = Object.fromEntries(statuses.map((s) => [s.carrierId, s]));
  carriersEl.innerHTML = carriers
    .map((c) => {
      const status = byId[c.id];
      const body =
        c.authKind === "credential"
          ? `<form class="cred-form" data-carrier="${c.id}">
              <input name="userId" placeholder="아이디" autocomplete="off" required />
              <input name="password" type="password" placeholder="비밀번호" required />
              <label class="remember"><input type="checkbox" name="remember" checked /> 자동 재로그인 저장</label>
              <button type="submit">로그인</button>
            </form>`
          : `<button data-remote="${c.id}">원격 브라우저로 로그인</button>`;
      return `<div class="carrier-card">
        <div class="row"><span class="name">${c.displayName}</span>${statusBadge(status)}</div>
        ${body}
      </div>`;
    })
    .join("");

  carriersEl.querySelectorAll("form.cred-form").forEach((form) => {
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const fd = new FormData(form);
      const carrierId = form.dataset.carrier;
      const res = await fetch(`/api/login/${carrierId}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          userId: fd.get("userId"),
          password: fd.get("password"),
          remember: fd.get("remember") === "on",
        }),
      });
      const data = await res.json();
      if (!res.ok) alert(data.error ?? "로그인 실패");
      else alert(`${carrierId} 로그인 성공`);
      loadStatus();
    });
  });

  carriersEl.querySelectorAll("button[data-remote]").forEach((btn) => {
    btn.addEventListener("click", () => openRemoteLogin(btn.dataset.remote));
  });
}

function renderUsage(lines) {
  if (!lines.length) {
    usageListEl.innerHTML = `<p class="muted">아직 수집된 사용량이 없습니다.</p>`;
    return;
  }
  // 위젯과 같은 표기: 무제한이면 "무제한", 아니면 "남은 양 / 총량".
  const metric = (m, label) => {
    if (!m) return "";
    const value = m.unlimited ? "무제한" : `${m.remainText ?? "-"} / ${m.totalText}`;
    const pct = !m.unlimited && m.remainPercent != null ? ` (잔여 ${m.remainPercent}%)` : "";
    return `<span>${label} ${escapeHtml(value)}${pct}</span>`;
  };
  usageListEl.innerHTML = lines
    .map((l, i) => {
      const net = l.network ?? "";
      return `<div class="usage-card ${net}">
        <div class="title">${escapeHtml(l.nickname || l.label)} <span class="muted">${escapeHtml(l.carrierName ?? "")} ${escapeHtml(l.planName ?? "")}</span></div>
        <div class="metrics">
          ${metric(l.data, "데이터")}
          ${metric(l.voice, "통화")}
          ${metric(l.sms, "문자")}
        </div>
        <form class="nick-form" data-idx="${i}">
          <input name="nickname" placeholder="별칭 (예: 내폰, 태블릿)" maxlength="40" value="${escapeHtml(l.nickname ?? "")}" />
          <button type="submit">저장</button>
          <span class="muted">${escapeHtml(l.label)}</span>
        </form>
      </div>`;
    })
    .join("");

  usageListEl.querySelectorAll("form.nick-form").forEach((form) => {
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const line = lines[Number(form.dataset.idx)];
      const res = await fetch("/api/labels", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          lineKey: line.lineKey,
          sourceId: line.sourceId,
          ordinal: line.ordinal,
          nickname: form.querySelector("input[name=nickname]").value,
        }),
      });
      if (!res.ok) alert((await res.json()).error ?? "별칭 저장 실패");
      loadStatus();
    });
  });
}

refreshBtn.addEventListener("click", async () => {
  refreshBtn.disabled = true;
  refreshBtn.textContent = "새로고침 중...";
  await fetch("/api/status"); // no-op warmup
  const token = prompt("서버 관리용 위젯 토큰을 입력하세요 (.env의 MVNO_WIDGET_TOKEN)");
  if (token) {
    await fetch(`/api/refresh?token=${encodeURIComponent(token)}`, { method: "POST" });
  }
  refreshBtn.disabled = false;
  refreshBtn.textContent = "지금 새로고침";
  loadStatus();
});

function openRemoteLogin(carrierId) {
  modal.classList.remove("hidden");
  remoteTitle.textContent = `${carrierId} 원격 로그인`;
  remoteStatus.textContent = "연결 중...";
  const proto = location.protocol === "https:" ? "wss" : "ws";
  ws = new WebSocket(`${proto}://${location.host}/ws/remote-login/${carrierId}`);
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.type === "frame") {
      const img = new Image();
      img.onload = () => ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      img.src = `data:image/jpeg;base64,${msg.data}`;
    } else if (msg.type === "url") {
      remoteStatus.textContent = msg.url;
    } else if (msg.type === "completed") {
      remoteStatus.textContent = "로그인 완료! 창을 닫습니다.";
      setTimeout(closeRemoteLogin, 1200);
      loadStatus();
    } else if (msg.type === "error") {
      remoteStatus.textContent = `오류: ${msg.message}`;
    }
  };
  ws.onclose = () => {
    if (!modal.classList.contains("hidden")) remoteStatus.textContent = "연결 종료됨";
  };
}

canvas.addEventListener("click", (e) => {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  const rect = canvas.getBoundingClientRect();
  const x = ((e.clientX - rect.left) / rect.width) * canvas.width;
  const y = ((e.clientY - rect.top) / rect.height) * canvas.height;
  ws.send(JSON.stringify({ type: "click", x, y }));
});

canvas.addEventListener(
  "wheel",
  (e) => {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({ type: "scroll", deltaY: e.deltaY }));
    e.preventDefault();
  },
  { passive: false },
);

// 한글 IME는 조합 중에도 input 이벤트를 흘린다. 그때마다 전송하면 자모가 하나씩 따로
// 전달돼 "안녕"이 "ㅇㅏㄴ..."으로 깨진다. 조합이 끝난 문자열을 전송 시점에 한 번만 보낸다.
function sendRemoteText() {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  const text = remoteInput.value;
  if (!text) return;
  ws.send(JSON.stringify({ type: "type", text }));
  remoteInput.value = "";
}

remoteInput.addEventListener("keydown", (e) => {
  // 조합 확정용 Enter(isComposing)는 전송으로 치지 않는다.
  if (e.key !== "Enter" || e.isComposing) return;
  e.preventDefault();
  sendRemoteText();
});

document.getElementById("remoteSend").addEventListener("click", sendRemoteText);

document.getElementById("remoteEnter").addEventListener("click", () => {
  ws?.send(JSON.stringify({ type: "key", key: "Enter" }));
});
document.getElementById("remoteBackspace").addEventListener("click", () => {
  ws?.send(JSON.stringify({ type: "key", key: "Backspace" }));
});

function closeRemoteLogin() {
  modal.classList.add("hidden");
  ws?.close();
  ws = null;
}
document.getElementById("remoteClose").addEventListener("click", async () => {
  const carrierId = remoteTitle.textContent.split(" ")[0];
  await fetch(`/api/remote-login/${carrierId}/stop`, { method: "POST" });
  closeRemoteLogin();
});

loadStatus();
setInterval(loadStatus, 15000);

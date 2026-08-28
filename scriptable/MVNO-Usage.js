// Variables used by Scriptable.
// icon-color: deep-purple; icon-glyph: sim-card;

// ===== 설정: 서버 주소와 토큰을 여기에 채워넣으세요 =====
const CONFIG = {
  // 웹 서버 주소 (끝에 / 없이). 아이폰에서 접근 가능한 주소여야 한다.
  SERVER_URL: "https://your-server.example.com",
  // server/.env 의 MVNO_WIDGET_TOKEN과 동일한 값.
  // /api/usage 는 이 토큰만으로 인증하므로 대시보드의 Basic Auth와는 무관하다.
  WIDGET_TOKEN: "REPLACE_WITH_MVNO_WIDGET_TOKEN",
};
// =====================================================

// 문서 §2.14 위젯 망 색상 (앱 색상 기준)
const NETWORK_COLOR = {
  SKT: new Color("#EA002C"),
  KT: new Color("#2E9E92"),
  "LGU+": new Color("#E6007E"),
};
const DEFAULT_COLOR = new Color("#8E8E93");

async function fetchUsage() {
  const url = `${CONFIG.SERVER_URL}/api/usage?token=${encodeURIComponent(CONFIG.WIDGET_TOKEN)}`;
  const req = new Request(url);
  req.timeoutInterval = 15;
  const json = await req.loadJSON();
  if (req.response?.statusCode && req.response.statusCode >= 400) {
    throw new Error(json?.error ?? `HTTP ${req.response.statusCode}`);
  }
  return json;
}

function formatRefreshedAt(ts) {
  if (!ts) return "갱신 기록 없음";
  const df = new DateFormatter();
  df.locale = "ko_KR";
  const d = new Date(ts);
  const sameDay = new Date().toDateString() === d.toDateString();
  df.dateFormat = sameDay ? "HH:mm" : "M/d HH:mm";
  return `${df.string(d)} 갱신`;
}

// 그래프는 "남은 양"을 그린다. 남은 비율을 모르면 막대를 비워 둔다.
function remainFraction(metric) {
  if (!metric || metric.unlimited) return null;
  if (metric.remainPercent == null) return null;
  return Math.min(1, Math.max(0, metric.remainPercent / 100));
}

function addBar(container, metric, color, width) {
  const track = container.addStack();
  track.layoutHorizontally();
  track.size = new Size(width, 6);
  track.backgroundColor = color.alpha(0.2);
  track.cornerRadius = 3;

  const frac = remainFraction(metric);
  if (metric?.unlimited) {
    const full = track.addStack();
    full.size = new Size(width, 6);
    full.backgroundColor = color.alpha(0.55);
    full.cornerRadius = 3;
  } else if (frac != null && frac > 0) {
    const remain = track.addStack();
    remain.size = new Size(Math.max(4, width * frac), 6);
    remain.backgroundColor = color;
    remain.cornerRadius = 3;
  }
  // 남은 만큼만 채우고 나머지는 밀어내서 항상 왼쪽부터 그려지게 한다.
  track.addSpacer();
}

// "남은 양 / 총량". 무제한이면 남은 양이라는 개념이 없으므로 무제한만 표기한다.
function metricText(metric) {
  if (!metric) return "-";
  if (metric.unlimited) return "무제한";
  const remain = metric.remainText;
  if (!remain) return metric.totalText === "-" ? "-" : `- / ${metric.totalText}`;
  if (metric.totalText === "-") return remain;
  return `${remain} / ${metric.totalText}`;
}

function addLineRow(container, line, { showVoiceSms, barWidth }) {
  const row = container.addStack();
  row.layoutVertically();
  row.spacing = 2;

  const head = row.addStack();
  head.centerAlignContent();
  const color = NETWORK_COLOR[line.network] ?? DEFAULT_COLOR;
  const dot = head.addText("●");
  dot.font = Font.systemFont(10);
  dot.textColor = color;
  head.addSpacer(4);
  const title = head.addText(line.nickname || line.label || "회선");
  title.font = Font.semiboldSystemFont(13);
  title.lineLimit = 1;
  head.addSpacer();
  const carrier = head.addText(line.carrierName ?? "");
  carrier.font = Font.systemFont(10);
  carrier.textColor = Color.gray();

  const dataRow = row.addStack();
  dataRow.centerAlignContent();
  const dataLabel = dataRow.addText("데이터  ");
  dataLabel.font = Font.systemFont(11);
  dataLabel.textColor = Color.gray();
  const dataValue = dataRow.addText(metricText(line.data));
  dataValue.font = Font.systemFont(11);
  dataRow.addSpacer();

  addBar(row, line.data, color, barWidth);

  if (showVoiceSms) {
    const sub = row.addStack();
    sub.spacing = 10;
    const voice = sub.addText(`통화 ${metricText(line.voice)}`);
    voice.font = Font.systemFont(10);
    voice.textColor = Color.gray();
    const sms = sub.addText(`문자 ${metricText(line.sms)}`);
    sms.font = Font.systemFont(10);
    sms.textColor = Color.gray();
  }
}

function addHeader(w, data) {
  const head = w.addStack();
  head.centerAlignContent();
  const title = head.addText("MVNO 잔여량");
  title.font = Font.boldSystemFont(14);
  head.addSpacer();
  // 회선이 하나도 안 잡혔을 때만 로그인 안내를 띄운다. 회선이 있으면 일부 사업자가
  // 만료됐더라도 남은 데이터를 보여주는 게 우선.
  const noLines = (data.lines ?? []).length === 0;
  const needsLogin = (data.statuses ?? []).some((s) => s.needsLogin);
  if (noLines && needsLogin) {
    const warn = head.addText("⚠︎ 로그인 필요");
    warn.font = Font.systemFont(10);
    warn.textColor = new Color("#EA002C");
  }
  w.addSpacer(4);
}

function addFooter(w, data) {
  w.addSpacer(4);
  const footer = w.addText(formatRefreshedAt(data.lastRefreshAt));
  footer.font = Font.systemFont(9);
  footer.textColor = Color.gray();
}

function buildWidget(data, family) {
  const w = new ListWidget();
  w.backgroundColor = Color.dynamic(new Color("#ffffff"), new Color("#1c1c1e"));
  w.url = CONFIG.SERVER_URL;
  w.setPadding(12, 14, 10, 14);

  const lines = data.lines ?? [];

  if (family === "small") {
    addHeader(w, data);
    if (lines.length === 0) {
      w.addText("표시할 회선 없음").font = Font.systemFont(12);
    } else {
      // 접는 순서(문서 §2.13): 통화/문자 → 생략, 데이터는 끝까지 유지. small은 1개만.
      addLineRow(w, lines[0], { showVoiceSms: false, barWidth: 140 });
      if (lines.length > 1) {
        w.addSpacer(2);
        const more = w.addText(`외 ${lines.length - 1}개 회선`);
        more.font = Font.systemFont(10);
        more.textColor = Color.gray();
      }
    }
    addFooter(w, data);
    return w;
  }

  const maxLines = family === "medium" ? 2 : 6;
  const showVoiceSms = family === "large";
  const barWidth = family === "medium" ? 130 : 260;

  addHeader(w, data);
  if (lines.length === 0) {
    w.addText("표시할 회선이 없습니다. 웹에서 로그인해주세요.").font = Font.systemFont(12);
  } else {
    lines.slice(0, maxLines).forEach((line, idx) => {
      if (idx > 0) w.addSpacer(8);
      addLineRow(w, line, { showVoiceSms, barWidth });
    });
    if (lines.length > maxLines) {
      w.addSpacer(4);
      const more = w.addText(`외 ${lines.length - maxLines}개 회선 (앱에서 확인)`);
      more.font = Font.systemFont(10);
      more.textColor = Color.gray();
    }
  }
  addFooter(w, data);
  return w;
}

function errorWidget(message) {
  const w = new ListWidget();
  w.setPadding(14, 14, 14, 14);
  w.url = CONFIG.SERVER_URL;
  const title = w.addText("MVNO 잔여량");
  title.font = Font.boldSystemFont(14);
  w.addSpacer(6);
  const body = w.addText(String(message));
  body.font = Font.systemFont(11);
  body.textColor = Color.red();
  body.lineLimit = 4;
  return w;
}

async function run() {
  let widget;
  try {
    if (!CONFIG.SERVER_URL.startsWith("http") || CONFIG.WIDGET_TOKEN.startsWith("REPLACE")) {
      throw new Error("CONFIG.SERVER_URL / WIDGET_TOKEN을 먼저 설정하세요");
    }
    const data = await fetchUsage();
    widget = buildWidget(data, config.widgetFamily ?? "medium");
  } catch (err) {
    widget = errorWidget(err.message ?? String(err));
  }

  if (config.runsInWidget) {
    Script.setWidget(widget);
  } else {
    const family = config.widgetFamily ?? "medium";
    if (family === "small") await widget.presentSmall();
    else if (family === "large") await widget.presentLarge();
    else await widget.presentMedium();
  }
  Script.complete();
}

await run();

// 로그인된 세션으로 엠모바일 사용량 페이지를 받아 구조를 확인하기 위한 임시 도구.
// 저장된 쿠키를 쓰므로 대시보드에서 원격 로그인을 먼저 끝내야 한다.
import "dotenv/config";
import { writeFileSync } from "node:fs";
import { HttpEngine } from "./src/core/httpEngine.js";
import { sessionStore } from "./src/core/sessionStore.js";

const WEB = "https://www.ktmmobile.com";
const http = new HttpEngine(sessionStore.jarFor("mmobile"));

const res = await http.request({
  method: "GET",
  url: `${WEB}/m/mypage/callView01.do`,
  origin: WEB,
  referer: `${WEB}/m/main.do`,
});

console.log("HTTP", res.code, "| 길이", res.body.length);
console.log("로그인 페이지로 튕겼는지:", res.body.includes('name="passWord"') ? "예 (세션 없음)" : "아니오 (세션 유효)");

writeFileSync("data/mmobile-usage.html", res.body);
console.log("원본 저장: data/mmobile-usage.html");

// 숫자+단위가 붙은 조각만 추려서 구조 파악을 돕는다.
const text = res.body.replace(/<script[\s\S]*?<\/script>/g, " ").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
const hits = text.match(/[^ ]{0,25}\s?[0-9.,]+\s?(?:KB|MB|GB|분|초|건|무제한)[^ ]{0,15}/gi) ?? [];
console.log("\n숫자/단위 조각:");
[...new Set(hits)].slice(0, 40).forEach((h) => console.log("  " + h.trim()));

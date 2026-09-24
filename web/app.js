// 사주 명식을 브라우저 안에서만 계산합니다. 생년월일시는 이 페이지 밖으로 나가지 않습니다.
// 서버에서 받는 것은 wasm(.gz)과 rules.json 두 정적 파일뿐이고, 둘 다 사람과 무관합니다.
//
// wasm은 「사주 보기」를 누른 뒤에만 받습니다(지연 로딩). 소개 페이지(../index.html)에는
// 이 코드가 실리지 않으므로, 소개 페이지 첫 로딩에 18MB가 딸려오지 않습니다.
//
// 화면은 다섯 탭입니다 — 오늘·이달·올해·명식·대운. 오늘 날짜는 서버가 아니라
// 브라우저(new Date)가 wasm 인자(today=YYYY-MM-DD)로 넘깁니다. 계산은 전부 wasm 안에서.
import { WASI, File, Directory, OpenFile, ConsoleStdout, PreopenDirectory }
  from "./vendor/index.js";

const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
// ?patch=0 이면 shim 버그 우회를 끕니다 — 크롬에서도 그 함정을 밟는지 보이기 위해서입니다.
const PATCH = params.get("patch") !== "0";
// ?debug=1 이면 #status 에 전송·컴파일 시간 같은 개발 기록을 보입니다. 평소엔 「계산 완료」만.
const DEBUG = params.get("debug") === "1";

// 시즌(2027 정미년 연말연시 대목) — 한국 시각 2026-11-15 00:00 ~ 2027-02-20 23:59 에만 켠다.
// ?season=1 이면 날짜와 무관하게 켠다(미리보기·시험용). 켜고 끄는 판단은 이 함수 하나뿐이다.
// 한국은 서머타임이 없어 항상 UTC+9이므로, 방문자 로컬 시계가 어느 시간대든 흔들리지 않도록
// KST 벽시계를 고정 UTC 오프셋으로 미리 계산해 둔다(방문자 기기의 타임존 설정에 기대지 않는다).
function isSeason() {
  if (params.get("season") === "1") return true;
  const now = Date.now();
  const start = Date.UTC(2026, 10, 14, 15, 0, 0); // 2026-11-15 00:00 KST
  const end = Date.UTC(2027, 1, 20, 15, 0, 0);    // 2027-02-21 00:00 KST(=2027-02-20 23:59:59 KST 까지 포함)
  return now >= start && now < end;
}

// 오행 색은 앱 팔레트(CSS 변수)를 그대로 씁니다 — 명리에서 의미가 있는 색입니다.
const ELEMENT_VAR = { "목":"--wood", "화":"--fire", "토":"--earth", "금":"--metal", "수":"--water" };
const color = (el) => `var(${ELEMENT_VAR[el] || "--ink"})`;

let compiledModule = null;   // 한 번만 컴파일해 계산마다 재사용
let rulesBytes = null;       // rules.json (한 번만)
const timings = {};

const log = (m) => { $("status").textContent = m; };
const showLoading = (on) => { $("loading").classList.toggle("on", on); };

// 방문 계측 — 이름만 보낸다. 생년월일시나 상담 내용은 실리지 않는다. 실패해도 조용히 넘어간다.
function sendEvent(e) {
  if (DEBUG || location.hostname === "localhost") return;
  try { navigator.sendBeacon("/api/pass/event", new Blob([JSON.stringify({ e })], { type: "application/json" })); }
  catch (err) { /* 조용히 무시 */ }
}

function buildFds(stdout, stderr) {
  const root = new Map();
  root.set("rules", new Directory(new Map([["rules.json", new File(rulesBytes)]])));
  return [
    new OpenFile(new File([])),
    ConsoleStdout.lineBuffered((m) => stdout.push(m)),
    ConsoleStdout.lineBuffered((m) => stderr.push(m)),
    new PreopenDirectory("/", root),
  ];
}

async function runSaju(argv) {
  const stdout = [], stderr = [];
  const wasi = new WASI(["SajuProof", ...argv], [], buildFds(stdout, stderr), { debug: false });

  if (PATCH) {
    // @bjorn3/browser_wasi_shim 0.4.2 버그 우회.
    // args_sizes_get은 인자 버퍼 크기를 JS 문자열 길이(UTF-16)로 세는데 args_get은 UTF-8로
    // 씁니다. "남"은 1 대 3이라 wasm 버퍼 밖으로 넘겨 쓰고, 그 자리에서 죽지 않고 힙을
    // 망가뜨려 한참 뒤 엉뚱한 곳에서 트랩이 납니다. 사주 입력은 한국어라 이 버그를
    // 정면으로 밟습니다. 브라우저엔 node 내장 WASI가 없으니 이 우회가 반드시 있어야 합니다.
    const utf8 = new TextEncoder();
    wasi.wasiImport.args_sizes_get = (argcPtr, bufSizePtr) => {
      const view = new DataView(wasi.inst.exports.memory.buffer);
      view.setUint32(argcPtr, wasi.args.length, true);
      const bytes = wasi.args.reduce((n, a) => n + utf8.encode(a).length + 1, 0);
      view.setUint32(bufSizePtr, bytes, true);
      return 0;
    };
  }

  const instance = await WebAssembly.instantiate(compiledModule, { wasi_snapshot_preview1: wasi.wasiImport });
  try {
    wasi.start(instance);
  } catch (e) {
    if (!(e && typeof e.code === "number")) throw e;   // WASIProcExit(0)만 삼킴
  }
  if (stdout.length === 0) throw new Error("wasm이 값을 내지 않았습니다. stderr: " + (stderr.join(" ") || "(없음)"));
  return JSON.parse(stdout.join(""));
}

async function ensureLoaded() {
  if (compiledModule) return;
  showLoading(true);
  timings.t0 = performance.now();
  const [wasmResp, rulesResp] = await Promise.all([fetch("SajuProof.wasm.gz"), fetch("rules.json")]);
  if (!("DecompressionStream" in self)) {
    throw new Error("이 브라우저는 DecompressionStream(gzip 해제)을 지원하지 않습니다. 최신 크롬·사파리·파이어폭스에서 열어 주세요.");
  }
  // nginx가 .wasm을 gzip으로 눌러 주지 않으므로, 눌러 둔 .gz를 받아 브라우저에서 풉니다.
  // 이렇게 하면 서버 설정과 무관하게 전송량이 약 18MB로 유지됩니다.
  const stream = wasmResp.body.pipeThrough(new DecompressionStream("gzip"));
  const wasmBuf = await new Response(stream).arrayBuffer();
  rulesBytes = new Uint8Array(await rulesResp.arrayBuffer());
  timings.tFetch = performance.now();
  compiledModule = await WebAssembly.compile(wasmBuf);
  timings.tCompile = performance.now();
  timings.wasmBytes = wasmBuf.byteLength;
  showLoading(false);
}

// ── 렌더 조각들 ──────────────────────────────────────────────────────────

const esc = (s) => String(s == null ? "" : s);

// ── 재미로 보는 오늘의 행운 번호 ─────────────────────────────────────────
// seed = 개인 명식 + 오늘 날짜. 같은 사람·같은 날이면 같은 번호가 나오고 날마다 바뀝니다.
// 사주로 당첨을 맞출 수는 없습니다 — 오늘 일진에서 뽑은 재미 요소입니다.
function hash32(str) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
  return h >>> 0;
}
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function luckyNumbers(seedStr) {
  const rnd = mulberry32(hash32(seedStr));
  const pool = []; for (let i = 1; i <= 45; i++) pool.push(i);
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    const tmp = pool[i]; pool[i] = pool[j]; pool[j] = tmp;
  }
  return pool.slice(0, 6).sort((a, b) => a - b);
}
// 실제 로또 공 색(번호대별)을 그대로 써서 재미를 살립니다.
function lottoColor(n) {
  return n <= 10 ? "#fbc400" : n <= 20 ? "#69c8f2" : n <= 30 ? "#ff7272" : n <= 40 ? "#aaaaaa" : "#b0d840";
}
function luckyBlock(personSeed, dateStr) {
  const nums = luckyNumbers((personSeed || "") + "|" + dateStr);
  const balls = nums.map(n => `<span class="lotto-ball" style="background:${lottoColor(n)}">${n}</span>`).join("");
  return `<div class="block"><div class="btitle">재미로 보는 오늘의 행운 번호</div>
    <div class="lotto">${balls}</div>
    <div class="fine">사주로 당첨 번호를 맞출 수는 없습니다. 오늘 일진에서 뽑은 재미 요소이고, 날마다 바뀝니다.</div></div>`;
}

// 간지 두 글자(천간 위, 지지 아래)를 오행 색으로. size: "lg" | "md" | "sm".
function ganjiBlock(cell, size = "md") {
  return `<div class="gj gj-${size}">` +
    `<span class="gc hanja" style="color:${color(cell.stemElement)}">${cell.stemHanja}</span>` +
    `<span class="gc hanja" style="color:${color(cell.branchElement)}">${cell.branchHanja}</span>` +
    `</div>`;
}

// 대운·세운·월운 한 칸.
function cycleTile(label, cell, god, detail) {
  return `<div class="cyc">
    <div class="cyc-l">${label}</div>
    <div class="cyc-b">${ganjiBlock(cell, "sm")}<div class="cyc-t"><b>${god}</b><span>${detail}</span></div></div>
  </div>`;
}

// 오늘 — 일진.
function renderToday(t, dayMaster, personSeed) {
  const d = t.today;
  const chips = [
    `<span class="chip strong">${d.stemGod}의 기운</span>`,
    `<span class="chip">${d.stage}</span>`,
  ];
  if (d.isVoid) chips.push(`<span class="chip">공망</span>`);
  if (d.combinesDayMaster) chips.push(`<span class="chip">일간과 합</span>`);

  let html = `<div class="today-head block">
    <div class="today-gj">${ganjiBlock(d.cell, "lg")}</div>
    <div class="today-info">
      <div class="today-title hanja">${d.date} · ${d.cell.ganjiKorean}일</div>
      <div class="chips">${chips.join("")}</div>
      <div class="sub-note">일간 ${dayMaster} 기준 · 천간 ${d.stemGod} · 지지 ${d.branchGod} · 십이운성 ${d.stage}</div>
    </div>
  </div>`;

  // 대운·세운·월운 띠.
  const band = [];
  const cur = (t.daeun && t.daeun.currentIndex != null)
    ? t.daeun.periods.find(p => p.index === t.daeun.currentIndex) : null;
  if (cur) band.push(cycleTile("대운", cur.cell, cur.stemGod, `${cur.startAge}세~`));
  band.push(cycleTile("세운", t.year.cell, t.year.stemGod, t.year.label));
  band.push(cycleTile("월운", t.month.cell, t.month.stemGod, t.month.label));
  html += `<div class="cyc-band">${band.join("")}</div>`;

  // 명식과 만나는 지점.
  const contacts = [];
  d.relations.forEach(r => contacts.push(
    `<span class="chip ${r.kind === "충" ? "strong" : "rel"}">${r.display} · ${r.position}</span>`));
  if (d.isVoid) contacts.push(`<span class="chip">일주 공망에 해당</span>`);
  if (d.combinesDayMaster) contacts.push(`<span class="chip">${dayMaster}${d.cell.stemKorean} 천간합</span>`);
  if (contacts.length) {
    html += `<div class="block"><div class="btitle">명식과 만나는 지점</div>
      <div class="chips">${contacts.join("")}</div>
      <div class="fine">충과 형은 좋고 나쁨이 아니라 움직임과 조정이 생기는 국면을 뜻합니다.</div></div>`;
  }

  // 오늘의 기운 해석(근거 규칙).
  const sec = (t.sections || []).find(s => s.title === "오늘의 기운");
  if (sec) {
    html += `<div class="block"><div class="btitle">오늘의 기운</div>
      <div class="sec-b">${sec.text.replace(/\n/g, "<br>")}</div></div>`;
  }

  // 재미로 보는 오늘의 행운 번호.
  html += luckyBlock(personSeed, d.date);
  return html;
}

// 이달 / 올해 — 월운·세운. kind: "month" | "year".
function renderPeriod(t, kind, dayMaster) {
  const p = kind === "month" ? t.month : t.year;
  const heading = kind === "month" ? "이달 · 월운" : "올해 · 세운";
  let html = `<div class="today-head block">
    <div class="today-gj">${ganjiBlock(p.cell, "lg")}</div>
    <div class="today-info">
      <div class="today-title hanja">${p.label} · ${p.cell.ganjiKorean}(${p.cell.ganjiHanja})</div>
      <div class="chips"><span class="chip strong">${p.stemGod}</span><span class="chip">지지 ${p.branchGod}</span></div>
      <div class="sub-note">${heading} · 일간 ${dayMaster} 기준</div>
    </div>
  </div>`;
  const sec = (t.sections || []).find(s => s.title === "이달과 올해");
  if (sec) {
    html += `<div class="block"><div class="btitle">이달과 올해</div>
      <div class="sec-b">${sec.text.replace(/\n/g, "<br>")}</div></div>`;
  }
  return html;
}

// 대운 — 10년 단위 흐름 타임라인.
function renderDaeun(t) {
  const dae = t.daeun;
  if (!dae) return `<div class="block">대운을 계산할 수 없습니다(출생 정보 부족).</div>`;
  let head = `<div class="btitle">대운 <span class="lab">${dae.isForward ? "순행" : "역행"} · 대운수 ${dae.daeunSu} · 만 ${dae.ageYears}세</span></div>`;
  const tiles = dae.periods.map(p => {
    const on = p.isCurrent ? " on" : "";
    return `<div class="tl${on}">
      <div class="tl-age">${p.startAge}세</div>
      ${ganjiBlock(p.cell, "sm")}
      <div class="tl-god">${p.stemGod}</div>
      <div class="tl-yr">${p.startYear}</div>
    </div>`;
  }).join("");
  return `<div class="block">${head}<div class="tl-row">${tiles}</div>
    <div class="fine">현재 대운을 주황으로 표시했습니다. 대운은 10년 단위로 바뀌는 큰 흐름입니다.</div></div>`;
}

// 명식 — 기존 화면 그대로.
function renderChart(c) {
  const corr = [];
  corr.push(`진태양시 <b>${c.solarTime}</b>`);
  corr.push(`경도보정 ${c.longitudeCorrectionMinutes.toFixed(1)}분`);
  if (c.equationOfTimeMinutes) corr.push(`균시차 ${c.equationOfTimeMinutes.toFixed(1)}분`);
  corr.push(`UTC${c.utcOffsetSeconds >= 0 ? "+" : ""}${(c.utcOffsetSeconds/3600).toFixed(1).replace(/\.0$/,"")}h`);
  if (c.isDST) corr.push(`<span class="flag">서머타임</span>`);
  if (c.isNightJasi) corr.push(`<span class="flag">야자시</span>`);

  let html = `<div class="head">
    <div class="hline"><span class="lab">입력</span> ${c.inputLine}</div>
    <div class="hline"><span class="lab">양력</span> ${c.solarDate}${c.lunarDate ? ` · <span class="lab">음력</span> ${c.lunarDate}` : ""}</div>
    <div class="hline"><span class="lab">보정</span> ${corr.join(" · ")}</div>
    <div class="hline"><span class="lab">일간</span> <b class="hanja" style="color:${color(c.dayMasterElement)}">${c.dayMasterKorean}${c.dayMasterHanja}</b> ${c.dayMasterElement}·${c.dayMasterYinYang} · <span class="lab">사주년</span> ${c.sajuYear}(${c.governingJeol})</div>
  </div>`;

  const order = ["시주","일주","월주","년주"];
  const byPos = {}; c.pillars.forEach(p => byPos[p.position] = p);
  const cols = order.filter(o => byPos[o]);
  const cell = (fn) => cols.map(o => fn(byPos[o])).join("");
  html += `<table class="saju"><thead><tr><th></th>${cols.map(o=>`<th>${o}</th>`).join("")}</tr></thead><tbody>
    <tr><td class="rl">천간 십신</td>${cell(p=>`<td>${p.tenGodStem ?? "일간"}</td>`)}</tr>
    <tr>${`<td class="rl">천간</td>`}${cell(p=>`<td style="color:${color(p.stemElement)}"><span class="ch hanja">${p.stemHanja}</span><span class="kr">${p.stemKorean}·${p.stemElement}</span></td>`)}</tr>
    <tr>${`<td class="rl">지지</td>`}${cell(p=>`<td style="color:${color(p.branchElement)}"><span class="ch hanja">${p.branchHanja}</span><span class="kr">${p.branchKorean}·${p.branchElement}</span></td>`)}</tr>
    <tr><td class="rl">지지 십신</td>${cell(p=>`<td>${p.tenGodBranch ?? ""}</td>`)}</tr>
    <tr><td class="rl">십이운성</td>${cell(p=>`<td>${p.twelveStage ?? ""}</td>`)}</tr>
  </tbody></table>`;
  html += `<div class="palja hanja">${c.compactHanja} <span class="lab">(년월일시)</span></div>`;

  const maxCount = Math.max(1, ...c.oheng.map(o=>o.count));
  html += `<div class="block"><div class="btitle">오행 분포</div><div class="oheng">` +
    c.oheng.map(o=>`<div class="obar"><div class="obar-track"><div class="obar-fill" style="height:${o.count/maxCount*100}%;background:${color(o.element)}"></div></div><div class="olab" style="color:${color(o.element)}">${o.element}<span class="hanja">${o.hanja}</span></div><div class="ocnt">${o.count}</div></div>`).join("") +
    `</div></div>`;

  const chips = [`<span class="chip strong">${c.strength} ${c.strengthPercent}%</span>`];
  c.sinsal.forEach(s => chips.push(`<span class="chip">${s}</span>`));
  if (c.voidPositions.length) chips.push(`<span class="chip">공망 ${c.voidPositions.join("·")}</span>`);
  c.relations.forEach(r => chips.push(`<span class="chip rel">${r}</span>`));
  html += `<div class="block"><div class="btitle">신강약 · 신살 · 관계</div><div class="chips">${chips.join("")}</div></div>`;

  if (c.sections && c.sections.length) {
    html += `<div class="block"><div class="btitle">해석 <span class="lab">(근거 규칙 v${c.rulesVersion} · 브라우저에서 조립)</span></div>`;
    c.sections.forEach(s => {
      html += `<div class="sec"><div class="sec-t">${s.title}</div><div class="sec-b">${s.text.replace(/\n/g,"<br>")}</div></div>`;
    });
    html += `</div>`;
  } else if (c.rulesError) {
    html += `<div class="block">규칙 로드 실패: ${c.rulesError}</div>`;
  }
  return html;
}

// 탭 다섯을 그리고 전환을 붙인다. 오늘·이달·올해는 time 이 있을 때만.
// ── AI 점술가 — 사주 상담 ────────────────────────────────────────────────
// 사주 계산은 브라우저 안에서 끝납니다. 상담을 눌러야만, 계산된 명식 기호와
// 적으신 고민만 서버로 갑니다(생년월일시 원본은 나가지 않습니다).
// 위기 표현은 여기(브라우저)에서 먼저 걸러 서버를 부르지 않고 핫라인을 띄웁니다.
const CHAT_URL = "https://secretary.seti.or.kr/vrof-chat/chat";
const CONSENT_KEY = "saju_consult_consent_v1";

const CONSULT_TOPICS = [
  ["identity", "나와 성향"], ["career", "일과 진로"], ["wealth", "돈과 재물"],
  ["relationship", "관계와 인연"], ["study", "배움과 자격"], ["people", "사람과 조직"],
  ["expression", "표현과 창작"], ["wellbeing", "몸과 마음의 기운"],
  ["movement", "이동과 거처"], ["timing", "지금 이 시기"],
];

// 위기 표현. 서버와 같은 목록을 브라우저에도 둡니다(1차 방어).
const CRISIS_PHRASES = [
  "죽고 싶", "죽고싶", "자살", "자해", "살기 싫", "사라지고 싶", "다 끝내고 싶",
  "목을 매", "목을 맬", "손목을 그", "뛰어내리", "유서를 쓰", "유서를 남",
  "약을 모으", "죽는 게 낫", "죽여버리고 싶",
];
function isCrisis(text) { return CRISIS_PHRASES.some(p => text.includes(p)); }
const HOTLINE_LINES = [
  "지금 많이 힘드신 것 같습니다. 이것은 사주로 풀 일이 아니라, 지금 바로 사람과 이야기하실 일입니다.",
  "· 자살예방 상담전화 109 (24시간, 전화·문자)",
  "· 정신건강 위기상담 1577-0199",
  "· 청소년 전화 1388",
  "혼자 견디지 않으셔도 됩니다. 지금 전화 한 통을 권합니다.",
];

const ohengLine = (c) => c.oheng.map(o => `${o.element}${o.count}`).join(" ");

// 서버로 보낼 명식 근거 블록. 생년월일시 원본은 넣지 않습니다 — 계산된 기호만.
function buildFacts(c, topicLabel) {
  const L = ["[명식 사실]", "사주: " + c.compactHanja,
    `일간: ${c.dayMasterKorean}(${c.dayMasterHanja}) ${c.dayMasterElement}·${c.dayMasterYinYang}`,
    "오행 분포: " + ohengLine(c),
    `신강약: ${c.strength} (세력비 ${c.strengthPercent}%)`];
  if (c.sinsal && c.sinsal.length) L.push("신살: " + c.sinsal.join(" "));
  if (c.voidPositions && c.voidPositions.length) L.push("공망: " + c.voidPositions.join(" "));
  if (c.relations && c.relations.length) L.push("지지 관계: " + c.relations.join(", "));
  L.push("", "[상담 주제] " + topicLabel);
  if (c.sections && c.sections.length) {
    L.push("", "[근거]");
    c.sections.forEach(s => L.push(`- (${s.title}) ${s.text.replace(/\n/g, " ")}`));
  }
  return L.join("\n").slice(0, 3500);
}

function renderConsult(c) {
  const chips = CONSULT_TOPICS.map(([k, label]) =>
    `<button class="ctopic" data-k="${k}" data-label="${label}">${label}</button>`).join("");
  return `<div class="block">
    <div class="btitle">AI 점술가 <span class="lab">명식을 바탕으로 고민을 풀어 드립니다</span></div>
    <div class="cnote">🔒 사주 계산은 이 기기 안에서 끝났습니다. 상담을 보내면 <b>계산된 명식 기호와 적으신 고민만</b> 서버로 갑니다. 생년월일시 원본은 나가지 않습니다.</div>
    <div class="ctopics">${chips}</div>
    <div class="cbox" id="cbox"></div>
    <div class="cinput">
      <textarea id="cq" rows="2" placeholder="주제를 고르고, 지금 걸리는 고민을 적어 주세요. (예: 지금 하는 일을 계속해야 할지 고민입니다)"></textarea>
      <button id="csend">풀이 받기</button>
    </div>
    <div class="fine">AI가 작성하며 심리 치료나 전문 상담이 아닙니다. 주민번호·계좌·연락처 등 민감정보는 적지 마세요. 위급하시면 자살예방 상담전화 109.</div>
  </div>`;
}

// 전송 고지 모달 — 한 번만 묻습니다. 동의하면 다음부터 바로 보냅니다.
function askConsent() {
  return new Promise((resolve) => {
    if (localStorage.getItem(CONSENT_KEY) === "1") { resolve(true); return; }
    const ov = document.createElement("div");
    ov.className = "cmodal-ov";
    ov.innerHTML = `<div class="cmodal">
      <h3>상담 내용이 서버로 전송됩니다</h3>
      <p class="cm-lead">사주 풀이를 위해 아래 내용만 AI 서버로 전송됩니다. 보내기 전에 확인해 주세요.</p>
      <div class="cm-sec"><div class="cm-h go">전송되는 것</div>
        <ul><li>계산이 끝난 명식 기호 (간지·오행·신강약·근거 규칙)</li><li>고르신 주제와 적으신 고민, 최근 대화</li></ul></div>
      <div class="cm-sec"><div class="cm-h no">전송되지 않는 것 (이 기기에만 남습니다)</div>
        <ul><li>이름·성별</li><li>생년월일시 원본 (양력·음력·출생 시각)</li><li>출생지, 진태양시 보정값</li></ul></div>
      <p class="cm-warn">AI가 작성하며 심리 치료나 전문 상담이 아닙니다. 민감한 개인정보는 입력하지 마세요.</p>
      <div class="cm-btns"><button class="cm-cancel">취소</button><button class="cm-ok">동의하고 풀이 받기</button></div>
    </div>`;
    document.body.appendChild(ov);
    const close = (v) => { ov.remove(); resolve(v); };
    ov.querySelector(".cm-cancel").onclick = () => close(false);
    ov.querySelector(".cm-ok").onclick = () => { localStorage.setItem(CONSENT_KEY, "1"); close(true); };
    ov.addEventListener("click", (e) => { if (e.target === ov) close(false); });
  });
}

function cBubble(box, who, text) {
  const d = document.createElement("div");
  d.className = "cb cb-" + who;
  d.textContent = text;
  box.appendChild(d);
  box.scrollTop = box.scrollHeight;
  return d;
}

async function streamConsult(body, bubble) {
  let cid = "", got = "", flags = {};
  const res = await fetch(CHAT_URL, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  if (!res.ok || !res.body) throw new Error("서버 응답 오류 (" + res.status + ")");
  const reader = res.body.getReader(); const dec = new TextDecoder(); let buf = "";
  for (;;) {
    const { value, done } = await reader.read(); if (done) break;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf("\n\n")) >= 0) {
      const chunk = buf.slice(0, i); buf = buf.slice(i + 2);
      let ev = "", data = "";
      chunk.split("\n").forEach(l => {
        if (l.startsWith("event:")) ev = l.slice(6).trim();
        else if (l.startsWith("data:")) data += l.slice(5).trim();
      });
      if (!data) continue;
      let d; try { d = JSON.parse(data); } catch (e) { continue; }
      if (d.conversation_id) cid = d.conversation_id;
      if (ev === "delta" && d.text) { got += d.text; bubble.textContent = got; bubble.parentElement.scrollTop = bubble.parentElement.scrollHeight; }
      if (ev === "done") flags = d;
    }
  }
  return { cid, text: got, flags };
}

function setupConsult(c, root) {
  const panel = root.querySelector('[data-p="consult"]'); if (!panel) return;
  const box = panel.querySelector("#cbox");
  const q = panel.querySelector("#cq");
  const send = panel.querySelector("#csend");
  const topics = [...panel.querySelectorAll(".ctopic")];
  let topicK = "", topicLabel = "", cid = "", busy = false;

  topics.forEach(b => b.addEventListener("click", () => {
    topics.forEach(x => x.classList.toggle("on", x === b));
    topicK = b.dataset.k; topicLabel = b.dataset.label;
  }));

  async function go() {
    if (busy) return;
    const text = q.value.trim();
    if (!text) { q.focus(); return; }
    // 🔴 위기 표현: 서버를 부르지 않고 즉시 핫라인.
    if (isCrisis(text)) {
      cBubble(box, "me", text); q.value = "";
      const card = document.createElement("div"); card.className = "chotline";
      card.innerHTML = HOTLINE_LINES.map((l, i) => i === 0 || i === HOTLINE_LINES.length - 1
        ? `<p>${l}</p>` : `<p class="num">${l}</p>`).join("");
      box.appendChild(card); box.scrollTop = box.scrollHeight;
      return;
    }
    if (!topicLabel) { cBubble(box, "sys", "먼저 위에서 상담 주제를 하나 골라 주세요."); return; }
    const ok = await askConsent(); if (!ok) return;
    sendEvent("consult_send");

    busy = true; send.disabled = true;
    cBubble(box, "me", text); q.value = "";
    const bubble = cBubble(box, "ai", "…");
    try {
      const body = { tenant: "saju", message: text, locale: "ko",
        context: buildFacts(c, topicLabel), page_url: location.href };
      if (cid) body.conversation_id = cid;
      // 1년 이용권 코드(pass.js 가 저장해 둔 것). 서버가 이용권을 요구할 때만 쓴다.
      let passCode = null; try { passCode = localStorage.getItem("fe_pass_code"); } catch (e) { /* 막힌 창 */ }
      if (passCode) body.pass_code = passCode;
      const r = await streamConsult(body, bubble);
      if (r.cid) cid = r.cid;
      // 서버가 이용권을 요구하면 이용권 상자를 연다(pass.js 가 받는다).
      if (r.flags && r.flags.need_pass) { sendEvent("need_pass"); dispatchEvent(new CustomEvent("fe-pass:need")); }
      if (!r.text) bubble.textContent = "잠시 답변이 어렵습니다. 잠시 뒤 다시 시도해 주세요.";
    } catch (e) {
      bubble.textContent = "연결에 실패했습니다. 잠시 뒤 다시 시도해 주세요.";
    } finally {
      busy = false; send.disabled = false;
    }
  }
  send.addEventListener("click", go);
  q.addEventListener("keydown", (e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) go(); });
}

// ── 2027 정미년(시즌) ────────────────────────────────────────────────────
// 근거는 전부 십신이고, 좋다/나쁘다·점수·길흉 표현은 쓰지 않는다(CLAUDE.md §2).
// 마지막 글자에 받침이 있는지로 「으로/로」를 고른다 — 십신 이름 10개 전부에 맞는다.
function hasBatchim(word) {
  const ch = word.charCodeAt(word.length - 1);
  if (ch < 0xAC00 || ch > 0xD7A3) return false;
  return (ch - 0xAC00) % 28 !== 0;
}
const eulLo = (word) => (hasBatchim(word) ? "으로" : "로");

// "이달과 올해" 섹션의 baselineText는 (월운 규칙 text) + "\n\n" + (세운 규칙 text) 순서로
// 이어붙여져 있습니다(SajuKit RuleEngine.baselineText·TimeFacts.timeSections 참고 — 태그 순서가
// wolwoon_sibsin 다음 sewoon_sibsin이라 항상 이 순서로 매칭됩니다). rules.json의 월운 규칙 10개는
// 전부 "…월운은"으로, 세운 규칙 10개는 전부 "…세운은"으로 문장이 시작하고 서로의 낱말("월운"/"세운")이
// 상대 문단에 섞이는 사례가 없음을 확인했습니다 — 그래서 "\n\n"으로 문단을 나눈 뒤 "세운"이 들어간
// 문단만 남기면 월운 문단이 안전하게 빠집니다. 혹시 못 가르면(문단이 하나뿐이거나 "세운"이 없으면)
// 통째로 쓰지 않고 빈 채로 둡니다 — 위 십신 문장만으로 근거는 이미 있습니다.
function sewoonOnlyParagraphs(c2027) {
  const sec = ((c2027.time && c2027.time.sections) || []).find(s => s.title === "이달과 올해");
  if (!sec) return [];
  return sec.text.split("\n\n").filter(p => p.includes("세운"));
}

function renderYear2027(c, c2027) {
  const y = c2027.time.year;
  const dm = `${c.dayMasterKorean}${c.dayMasterHanja}`;
  let html = `<div class="today-head block">
    <div class="today-gj">${ganjiBlock(y.cell, "lg")}</div>
    <div class="today-info">
      <div class="today-title hanja">2027 정미년 · ${y.cell.ganjiKorean}(${y.cell.ganjiHanja})</div>
      <div class="chips"><span class="chip strong">천간 ${y.stemGod}</span><span class="chip">지지 ${y.branchGod}</span></div>
      <div class="sub-note">붉은 양의 해 · 일간 ${dm} 기준 · 세운</div>
    </div>
  </div>`;

  html += `<div class="block"><div class="sec-b">2027 정미년의 천간 丁(화)은 당신의 일간 ${dm}에게 ${esc(y.stemGod)}, `
    + `지지 未(토)는 ${esc(y.branchGod)}${eulLo(y.branchGod)} 들어옵니다.</div></div>`;

  const paras = sewoonOnlyParagraphs(c2027);
  if (paras.length) {
    html += `<div class="block"><div class="btitle">올해의 흐름</div>`
      + `<div class="sec-b">${paras.join("\n\n").replace(/\n/g, "<br>")}</div></div>`;
  }

  html += `<div class="block"><div class="fine" style="margin-top:0">사주에서 새해는 2월 4일 입춘부터입니다. `
    + `1월 1일과 설날(2월 7일)은 아직 병오년의 끝자락입니다.</div></div>`;

  html += `<div class="block"><div class="sec-b">더 깊은 풀이는 <a href="#" class="y27-consult-link">AI 점술가</a>에게 — `
    + `주제 「지금 이 시기」를 고르고 2027년을 물어보세요.</div>
    <div class="y27-actions">
      <button class="y27-btn y27-share" type="button">이미지로 저장</button>
      <button class="y27-btn y27-ics" type="button">입춘에 다시 보기(캘린더에 추가)</button>
    </div>
    <div class="fine y27-share-msg" aria-live="polite"></div>
  </div>`;

  return html;
}

// QR — 외부 서비스를 부르지 않고 브라우저 안에서 그린다(vendor/qrcode.js, MIT).
// 표준 quiet zone(모듈 4칸)을 둬야 다른 리더가 잘 읽는다.
function drawQrOnCanvas(ctx, text, x, y, size) {
  const qr = window.qrcode(0, "M");
  qr.addData(text);
  qr.make();
  const count = qr.getModuleCount();
  const margin = 4;
  const cell = size / (count + margin * 2);
  ctx.fillStyle = "#fff";
  ctx.fillRect(x, y, size, size);
  ctx.fillStyle = "#000";
  for (let row = 0; row < count; row++) {
    for (let col = 0; col < count; col++) {
      if (qr.isDark(row, col)) {
        ctx.fillRect(x + (col + margin) * cell, y + (row + margin) * cell, Math.ceil(cell) + 0.5, Math.ceil(cell) + 0.5);
      }
    }
  }
}

function loadImageSafeY27(src) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null); // 이미지가 없어도 카드는 만들어진다
    img.src = src;
  });
}

const Y27_W = 1080, Y27_H = 1350;

// 공유 카드 — 생년월일시·이름은 절대 넣지 않는다. 丁未 두 글자는 앱 오행 팔레트의 «라이트» 값을
// 그대로 쓴다(pass.js의 선물 카드와 같은 방식 — 카드 자체는 누구 화면에서 열리든 같은 색으로 보여야
// 하므로 뷰어의 다크모드를 따라가지 않는다). 화면 결과가 아니라 «다운로드되는 파일»이라는 점이 다르다.
async function buildYear2027Canvas(c, c2027) {
  const y = c2027.time.year;
  const canvas = document.createElement("canvas");
  canvas.width = Y27_W; canvas.height = Y27_H;
  const ctx = canvas.getContext("2d");
  const cx = Y27_W / 2;
  const PAPER = "#FAF7F0", INK = "#2A251F", INK_SOFT = "#6B6154", CINNABAR = "#B43A2E";
  const FIRE = "#EE7038", EARTH = "#7F5502"; // --fire, --earth 라이트 값(CLAUDE.md §13)

  ctx.fillStyle = PAPER; ctx.fillRect(0, 0, Y27_W, Y27_H);

  const BANNER_H = 560;
  const hero = await loadImageSafeY27("assets/hero-tall.webp");
  if (hero) {
    ctx.save();
    ctx.beginPath(); ctx.rect(0, 0, Y27_W, BANNER_H); ctx.clip();
    const h = Y27_W * (hero.height / hero.width);
    ctx.drawImage(hero, 0, 0, Y27_W, h);
    ctx.restore();
    const fade = ctx.createLinearGradient(0, BANNER_H - 160, 0, BANNER_H);
    fade.addColorStop(0, "rgba(250,247,240,0)");
    fade.addColorStop(1, PAPER);
    ctx.fillStyle = fade;
    ctx.fillRect(0, BANNER_H - 160, Y27_W, 160);
  }

  try {
    await document.fonts.load('700 46px "Noto Serif KR"');
    await document.fonts.load('700 220px "Noto Serif KR"');
    await document.fonts.load('500 34px "Pretendard"');
  } catch (e) { /* 대체 글꼴로 진행 */ }

  ctx.textAlign = "center";

  ctx.fillStyle = CINNABAR;
  ctx.font = '700 46px "Noto Serif KR", "AppleMyungjo", "Nanum Myeongjo", serif';
  ctx.fillText("나의 2027 정미년", cx, 660);

  ctx.font = '700 220px "Noto Serif KR", "AppleMyungjo", "Nanum Myeongjo", serif';
  ctx.fillStyle = FIRE; ctx.fillText("丁", cx - 130, 900);
  ctx.fillStyle = EARTH; ctx.fillText("未", cx + 130, 900);

  ctx.fillStyle = INK;
  ctx.font = '500 36px -apple-system, "Pretendard", "Apple SD Gothic Neo", sans-serif';
  ctx.fillText(`천간 ${y.stemGod} · 지지 ${y.branchGod}`, cx, 990);

  // 남은 세로 공간(캔버스 높이 1350)에 다 들어가도록 QR 크기·자리를 먼저 계산해 둔다 —
  // 예전 판은 QR 아래 두 줄이 캔버스 밖으로 나가 "fe.eet.kr" 글자가 통째로 안 보였다.
  const qrSize = 250, qrY = 1020;
  drawQrOnCanvas(ctx, "https://fe.eet.kr/", cx - qrSize / 2, qrY, qrSize);

  ctx.font = '600 30px -apple-system, "Pretendard", sans-serif';
  ctx.fillStyle = CINNABAR;
  ctx.fillText("fe.eet.kr", cx, qrY + qrSize + 55);

  return canvas;
}

async function saveYear2027Card(c, c2027, btn, msgEl) {
  const original = btn.textContent;
  btn.disabled = true; btn.textContent = "카드 만드는 중…"; msgEl.textContent = "";
  try {
    const canvas = await buildYear2027Canvas(c, c2027);
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
    if (!blob) throw new Error("no-blob");
    const file = new File([blob], "fe-eet-kr-2027-정미년.png", { type: "image/png" });
    if (navigator.share && navigator.canShare && navigator.canShare({ files: [file] })) {
      try {
        await navigator.share({ files: [file], title: "나의 2027 정미년" });
        btn.textContent = original; btn.disabled = false;
        return;
      } catch (e) {
        if (e && e.name === "AbortError") { btn.textContent = original; btn.disabled = false; return; }
        // 공유가 지원된다고 했는데 실패했으면 저장으로 대신한다
      }
    }
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = file.name;
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  } catch (e) {
    msgEl.textContent = "카드를 만들지 못했습니다. 잠시 뒤 다시 시도해 주세요.";
    btn.textContent = original; btn.disabled = false;
    return;
  }
  btn.textContent = original; btn.disabled = false;
}

// 입춘(2027-02-04) 알림 — 캘린더 .ics 파일. 연락처는 받지 않는다(달력 앱이 로컬에서 처리한다).
function icsUtcStamp(d) {
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}T${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
}
function buildIcs() {
  const esc = (s) => String(s).replace(/([,;])/g, "\\$1");
  const lines = [
    "BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//fe.eet.kr//2027 season//KO", "CALSCALE:GREGORIAN",
    "BEGIN:VEVENT",
    "UID:fe-eet-kr-ipchun-2027@fe.eet.kr",
    "DTSTAMP:" + icsUtcStamp(new Date()),
    "DTSTART;VALUE=DATE:20270204",
    "DTEND;VALUE=DATE:20270205",
    "SUMMARY:" + esc("입춘 — 2027 정미년 시작"),
    "DESCRIPTION:" + esc("사주에서 2027년(정미년)이 시작되는 날입니다. https://fe.eet.kr/"),
    // 알림 하루 전 오전 9시 — 종일 일정의 시작(자정)에서 15시간 전이 그 전날 09:00이다.
    "BEGIN:VALARM", "ACTION:DISPLAY", "DESCRIPTION:입춘 알림", "TRIGGER:-PT15H", "END:VALARM",
    "END:VEVENT", "END:VCALENDAR",
  ];
  return lines.join("\r\n") + "\r\n";
}

function downloadIcs() {
  const blob = new Blob([buildIcs()], { type: "text/calendar;charset=utf-8" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "입춘-2027-정미년.ics";
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

function setupYear2027(c, c2027, root, activateTab) {
  const panel = root.querySelector('[data-p="y2027"]'); if (!panel) return;
  const link = panel.querySelector(".y27-consult-link");
  if (link) link.addEventListener("click", (e) => {
    e.preventDefault();
    activateTab("consult");
    const timing = root.querySelector('.ctopic[data-k="timing"]');
    if (timing) timing.click();
  });
  const shareBtn = panel.querySelector(".y27-share");
  const msgEl = panel.querySelector(".y27-share-msg");
  if (shareBtn) shareBtn.addEventListener("click", () => saveYear2027Card(c, c2027, shareBtn, msgEl));
  const icsBtn = panel.querySelector(".y27-ics");
  if (icsBtn) icsBtn.addEventListener("click", downloadIcs);
}

function render(c, c2027) {
  const dm = `${c.dayMasterKorean}${c.dayMasterHanja}`;
  const t = c.time;
  const tabs = [];
  const panels = [];
  const add = (key, label, html) => {
    tabs.push(`<button class="tab" data-t="${key}">${label}</button>`);
    panels.push(`<div class="panel" data-p="${key}">${html}</div>`);
  };
  if (t) {
    add("today", "오늘", renderToday(t, dm, c.compactHanja));
    add("month", "이달", renderPeriod(t, "month", dm));
    add("year", "올해", renderPeriod(t, "year", dm));
  }
  // 「2027」 탭 — 「올해」 바로 옆(시즌에만, 계산이 됐을 때만).
  if (c2027 && c2027.time && c2027.time.year) add("y2027", "2027", renderYear2027(c, c2027));
  add("chart", "명식", renderChart(c));
  if (t) add("daeun", "대운", renderDaeun(t));
  add("consult", "AI 점술가", renderConsult(c));

  const el = $("result");
  el.innerHTML = `<div class="tabs">${tabs.join("")}</div>${panels.join("")}`;
  el.hidden = false;

  const buttons = [...el.querySelectorAll(".tab")];
  const pans = [...el.querySelectorAll(".panel")];
  const activate = (key) => {
    buttons.forEach(b => b.classList.toggle("active", b.dataset.t === key));
    pans.forEach(p => p.classList.toggle("on", p.dataset.p === key));
  };
  buttons.forEach(b => b.addEventListener("click", () => activate(b.dataset.t)));
  // 기본 탭 — 시간운이 있으면 오늘, 없으면 명식.
  activate(t ? "today" : "chart");
  setupConsult(c, el);
  if (c2027 && c2027.time && c2027.time.year) setupYear2027(c, c2027, el, activate);
}

function showError(e) {
  showLoading(false);
  $("result").hidden = true;
  const box = $("error"); box.hidden = false;
  box.innerHTML = `<b>계산 실패${PATCH ? "" : " (우회 꺼짐)"}</b><br>${String(e && e.stack || e)}`;
}

// 오늘 날짜(브라우저 로컬)를 YYYY-MM-DD 로. 서버로 나가지 않고 wasm 인자로만 들어간다.
function todayArg() {
  const now = new Date();
  return `today=${now.getFullYear()}-${now.getMonth() + 1}-${now.getDate()}`;
}

// todayOverride를 주면 그 today= 인자로 바꿔 계산합니다(같은 출생 정보를 다른 기준일로
// 다시 돌릴 때 — 예: 2027 정미년 세운 카드). 안 주면 지금까지와 같이 오늘 날짜입니다.
function readForm(todayOverride) {
  const h = $("h").value.trim() === "" ? "-" : $("h").value.trim();
  const argv = [$("y").value, $("mo").value, $("d").value, h, $("mi").value || "0", $("g").value, "/rules/rules.json"];
  if ($("cal").value === "음력") argv.push("음력");
  argv.push(todayOverride || todayArg());
  return argv;
}

async function calculate() {
  $("error").hidden = true;
  try {
    await ensureLoaded();
    log("계산 중…");
    const t0 = performance.now();
    const chart = await runSaju(readForm());
    // 시즌이면 같은 출생 정보를 기준일 2027-06-15 로 한 번 더 돌려 2027 정미년(세운) 정보만 뽑습니다.
    // 본계산 결과(chart)는 건드리지 않고, 이 두 번째 결과는 「2027」 탭에만 씁니다.
    let chart2027 = null;
    if (isSeason()) {
      try { chart2027 = await runSaju(readForm("today=2027-6-15")); }
      catch (e) { chart2027 = null; /* 2027 카드만 못 만들 뿐, 본계산은 그대로 보여준다 */ }
    }
    const t1 = performance.now();
    render(chart, chart2027);
    sendEvent("calc");
    if (DEBUG) {
      const wire = (timings.wasmBytes/1024/1024).toFixed(1);
      const first = timings.firstDone ? "" : ` · 최초 전체 ${((t1 - timings.t0)/1000).toFixed(2)}s`;
      log(`완료 — 전송+압축해제 ${((timings.tFetch-timings.t0)/1000).toFixed(2)}s · 컴파일 ${((timings.tCompile-timings.tFetch)/1000).toFixed(2)}s · 계산 ${(t1-t0).toFixed(0)}ms (gzip 약 18MB 전송, ${wire}MB로 해제)${first}`);
    } else {
      log("계산 완료");
    }
    timings.firstDone = true;
  } catch (e) {
    showError(e); log("오류");
  }
}

$("go").addEventListener("click", calculate);

// 시즌 띠 — 보일지 말지는 isSeason() 하나로 정한다. 계산 전이면 href="#start" 기본 동작(스크롤)에
// 맡기고, 계산 후(결과가 있으면)면 「2027」 탭을 눌러 준다.
const seasonStrip = $("season-strip");
if (seasonStrip) {
  if (isSeason()) seasonStrip.hidden = false;
  seasonStrip.addEventListener("click", (e) => {
    const resultEl = $("result");
    const tabBtn = resultEl && !resultEl.hidden && resultEl.querySelector('.tab[data-t="y2027"]');
    if (tabBtn) {
      e.preventDefault();
      tabBtn.click();
      resultEl.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  });
}

// 자동 실행(헤드리스 스크린샷용). ?auto=1&y=&mo=&d=&h=&mi=&g=&cal=&tab=
if (params.get("auto") === "1") {
  const set = (id, key, def) => { const v = params.get(key); $(id).value = v != null ? v : def; };
  set("y","y","2003"); set("mo","mo","2"); set("d","d","22"); set("h","h","13"); set("mi","mi","13");
  if (params.get("g")) $("g").value = params.get("g");
  if (params.get("cal")) $("cal").value = params.get("cal");
  addEventListener("load", async () => {
    await calculate();
    // ?tab=today|month|year|chart|daeun 로 특정 탭을 연다.
    const tab = params.get("tab");
    if (tab) { const b = document.querySelector(`.tab[data-t="${tab}"]`); if (b) b.click(); }
  });
}

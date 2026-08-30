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

// 오행 색은 앱 팔레트(CSS 변수)를 그대로 씁니다 — 명리에서 의미가 있는 색입니다.
const ELEMENT_VAR = { "목":"--wood", "화":"--fire", "토":"--earth", "금":"--metal", "수":"--water" };
const color = (el) => `var(${ELEMENT_VAR[el] || "--ink"})`;

let compiledModule = null;   // 한 번만 컴파일해 계산마다 재사용
let rulesBytes = null;       // rules.json (한 번만)
const timings = {};

const log = (m) => { $("status").textContent = m; };
const showLoading = (on) => { $("loading").classList.toggle("on", on); };

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
function renderToday(t, dayMaster) {
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
function render(c) {
  const dm = `${c.dayMasterKorean}${c.dayMasterHanja}`;
  const t = c.time;
  const tabs = [];
  const panels = [];
  const add = (key, label, html) => {
    tabs.push(`<button class="tab" data-t="${key}">${label}</button>`);
    panels.push(`<div class="panel" data-p="${key}">${html}</div>`);
  };
  if (t) {
    add("today", "오늘", renderToday(t, dm));
    add("month", "이달", renderPeriod(t, "month", dm));
    add("year", "올해", renderPeriod(t, "year", dm));
  }
  add("chart", "명식", renderChart(c));
  if (t) add("daeun", "대운", renderDaeun(t));

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

function readForm() {
  const h = $("h").value.trim() === "" ? "-" : $("h").value.trim();
  const argv = [$("y").value, $("mo").value, $("d").value, h, $("mi").value || "0", $("g").value, "/rules/rules.json"];
  if ($("cal").value === "음력") argv.push("음력");
  argv.push(todayArg());
  return argv;
}

async function calculate() {
  $("error").hidden = true;
  try {
    await ensureLoaded();
    log("계산 중…");
    const t0 = performance.now();
    const chart = await runSaju(readForm());
    const t1 = performance.now();
    render(chart);
    const wire = (timings.wasmBytes/1024/1024).toFixed(1);
    const first = timings.firstDone ? "" : ` · 최초 전체 ${((t1 - timings.t0)/1000).toFixed(2)}s`;
    log(`완료 — 전송+압축해제 ${((timings.tFetch-timings.t0)/1000).toFixed(2)}s · 컴파일 ${((timings.tCompile-timings.tFetch)/1000).toFixed(2)}s · 계산 ${(t1-t0).toFixed(0)}ms (gzip 약 18MB 전송, ${wire}MB로 해제)${first}`);
    timings.firstDone = true;
  } catch (e) {
    showError(e); log("오류");
  }
}

$("go").addEventListener("click", calculate);

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

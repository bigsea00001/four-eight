// 명식을 브라우저 안에서만 계산합니다. 생년월일시는 이 페이지 밖으로 나가지 않습니다.
// 서버에서 받아오는 것은 wasm 바이너리와 rules.json 두 파일뿐이고, 둘 다 사람과
// 무관한 정적 파일입니다. 계산은 전부 wasm 안에서 일어납니다.
import { WASI, File, Directory, OpenFile, ConsoleStdout, PreopenDirectory }
  from "./vendor/index.js";

const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
// ?patch=0 이면 shim 버그 우회를 끕니다 — 크롬에서도 그 함정을 밟는지 보이기 위해서입니다.
const PATCH = params.get("patch") !== "0";

let compiledModule = null;   // 한 번만 컴파일해 두고 계산마다 재사용
let rulesBytes = null;       // rules.json 바이트 (한 번만 fetch)
const timings = {};

// 오행 색.
const ELEMENT_COLOR = { "목": "#2e7d32", "화": "#c62828", "토": "#8d6e63", "금": "#b08d00", "수": "#1565c0" };

function log(msg) {
  const el = $("status");
  el.textContent = msg;
}

// tzdata 없이도 시간대가 나오는지는 앞서 확인했습니다(바이너리에 포함).
// 여기서는 VFS에 rules.json만 얹으면 됩니다.
function buildFds(stdoutLines, stderrLines) {
  const rootMap = new Map();
  rootMap.set("rules", new Directory(new Map([
    ["rules.json", new File(rulesBytes)],
  ])));
  return [
    new OpenFile(new File([])),                                  // fd 0 stdin
    ConsoleStdout.lineBuffered((m) => stdoutLines.push(m)),       // fd 1 stdout
    ConsoleStdout.lineBuffered((m) => stderrLines.push(m)),       // fd 2 stderr
    new PreopenDirectory("/", rootMap),                          // fd 3 "/"
  ];
}

// 한글 인자로 wasm을 부릅니다. 반환은 파싱된 명식 객체.
async function runSaju(argv) {
  const stdout = [], stderr = [];
  const wasi = new WASI(["SajuProof", ...argv], [], buildFds(stdout, stderr), { debug: false });

  if (PATCH) {
    // @bjorn3/browser_wasi_shim 0.4.2 버그 우회.
    // args_sizes_get은 인자 버퍼 크기를 JS 문자열 길이(UTF-16 단위)로 세는데
    // args_get은 UTF-8로 씁니다. "남"은 1 대 3이라 wasm 버퍼 밖으로 넘겨 쓰고,
    // 그 자리에서 죽지 않고 힙만 망가뜨려 한참 뒤 엉뚱한 곳에서 트랩이 납니다.
    // 사주 입력은 한국어라 이 버그를 정면으로 밟습니다.
    const utf8 = new TextEncoder();
    wasi.wasiImport.args_sizes_get = (argcPtr, bufSizePtr) => {
      const view = new DataView(wasi.inst.exports.memory.buffer);
      view.setUint32(argcPtr, wasi.args.length, true);
      const bytes = wasi.args.reduce((n, a) => n + utf8.encode(a).length + 1, 0);
      view.setUint32(bufSizePtr, bytes, true);
      return 0;
    };
  }

  const instance = await WebAssembly.instantiate(compiledModule, {
    wasi_snapshot_preview1: wasi.wasiImport,
  });
  let exitCode = 0;
  try {
    wasi.start(instance);
  } catch (e) {
    // WASIProcExit(0)은 정상 종료입니다. 그 외 트랩은 그대로 올립니다.
    if (e && typeof e.code === "number") { exitCode = e.code; }
    else { throw e; }
  }
  if (stdout.length === 0) {
    throw new Error("wasm이 값을 내지 않았습니다. stderr: " + (stderr.join(" ") || "(없음)") + " exit=" + exitCode);
  }
  return JSON.parse(stdout.join(""));
}

async function ensureLoaded() {
  if (compiledModule) return;
  timings.t0 = performance.now();
  const [wasmResp, rulesResp] = await Promise.all([
    fetch("SajuProof.wasm"),
    fetch("rules.json"),
  ]);
  const wasmBuf = await wasmResp.arrayBuffer();
  rulesBytes = new Uint8Array(await rulesResp.arrayBuffer());
  timings.tFetch = performance.now();
  compiledModule = await WebAssembly.compile(wasmBuf);
  timings.tCompile = performance.now();
  timings.wasmBytes = wasmBuf.byteLength;
}

function color(el) { return ELEMENT_COLOR[el] || "#333"; }

function render(c) {
  // 헤더 — 입력과 보정.
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
    <div class="hline"><span class="lab">일간</span> <b style="color:${color(c.dayMasterElement)}">${c.dayMasterKorean}${c.dayMasterHanja}</b> ${c.dayMasterElement}·${c.dayMasterYinYang} · <span class="lab">사주년</span> ${c.sajuYear}(${c.governingJeol})</div>
  </div>`;

  // 사주팔자 표 — 시 일 월 년 순(전통 배열). 각 칸에 위치를 라벨.
  const order = ["시주","일주","월주","년주"];
  const byPos = {}; c.pillars.forEach(p => byPos[p.position] = p);
  const cols = order.filter(o => byPos[o]);
  const cell = (fn) => cols.map(o => fn(byPos[o])).join("");
  html += `<table class="saju"><thead><tr><th></th>${cols.map(o=>`<th>${o}</th>`).join("")}</tr></thead><tbody>
    <tr><td class="rl">천간 십신</td>${cell(p=>`<td>${p.tenGodStem ?? "일간"}</td>`)}</tr>
    <tr class="gan">${`<td class="rl">천간</td>`}${cell(p=>`<td style="color:${color(p.stemElement)}"><span class="ch">${p.stemHanja}</span><span class="kr">${p.stemKorean}·${p.stemElement}</span></td>`)}</tr>
    <tr class="ji">${`<td class="rl">지지</td>`}${cell(p=>`<td style="color:${color(p.branchElement)}"><span class="ch">${p.branchHanja}</span><span class="kr">${p.branchKorean}·${p.branchElement}</span></td>`)}</tr>
    <tr><td class="rl">지지 십신</td>${cell(p=>`<td>${p.tenGodBranch ?? ""}</td>`)}</tr>
    <tr><td class="rl">십이운성</td>${cell(p=>`<td>${p.twelveStage ?? ""}</td>`)}</tr>
  </tbody></table>`;
  html += `<div class="palja">${c.compactHanja} <span class="lab">(년월일시)</span></div>`;

  // 오행 분포.
  const maxCount = Math.max(1, ...c.oheng.map(o=>o.count));
  html += `<div class="block"><div class="btitle">오행 분포</div><div class="oheng">` +
    c.oheng.map(o=>`<div class="obar"><div class="obar-track"><div class="obar-fill" style="height:${o.count/maxCount*100}%;background:${color(o.element)}"></div></div><div class="olab" style="color:${color(o.element)}">${o.element}${o.hanja}</div><div class="ocnt">${o.count}</div></div>`).join("") +
    `</div></div>`;

  // 신강약·신살·관계.
  const chips = [];
  chips.push(`<span class="chip strong">${c.strength} ${c.strengthPercent}%</span>`);
  c.sinsal.forEach(s => chips.push(`<span class="chip">${s}</span>`));
  if (c.voidPositions.length) chips.push(`<span class="chip">공망 ${c.voidPositions.join("·")}</span>`);
  c.relations.forEach(r => chips.push(`<span class="chip rel">${r}</span>`));
  html += `<div class="block"><div class="btitle">신강약 · 신살 · 관계</div><div class="chips">${chips.join("")}</div></div>`;

  // 해석 — 근거 문장(RuleEngine 108룰).
  if (c.sections && c.sections.length) {
    html += `<div class="block"><div class="btitle">해석 <span class="lab">(근거 규칙 v${c.rulesVersion} · 브라우저에서 조립)</span></div>`;
    c.sections.forEach(s => {
      html += `<div class="sec"><div class="sec-t">${s.title}</div><div class="sec-b">${s.text.replace(/\n/g,"<br>")}</div></div>`;
    });
    html += `</div>`;
  } else if (c.rulesError) {
    html += `<div class="block err">규칙 로드 실패: ${c.rulesError}</div>`;
  }

  $("result").innerHTML = html;
  $("result").hidden = false;
}

function showError(e) {
  $("result").hidden = true;
  const box = $("error");
  box.hidden = false;
  box.innerHTML = `<b>계산 실패${PATCH ? "" : " (우회 꺼짐)"}</b><br>${String(e && e.stack || e)}`;
}

function readForm() {
  const g = $("g").value;
  const cal = $("cal").value;
  const h = $("h").value.trim() === "" ? "-" : $("h").value.trim();
  const argv = [$("y").value, $("mo").value, $("d").value, h, $("mi").value || "0", g, "/rules/rules.json"];
  if (cal === "음력") argv.push("음력");
  return argv;
}

async function calculate() {
  $("error").hidden = true;
  try {
    log("wasm 불러오는 중…");
    await ensureLoaded();
    log("계산 중…");
    const tRun0 = performance.now();
    const chart = await runSaju(readForm());
    const tRun1 = performance.now();
    render(chart);
    const wire = (timings.wasmBytes/1024/1024).toFixed(1);
    const first = timings.firstDone ? "" : ` · 최초 전체 ${((tRun1 - timings.t0)/1000).toFixed(2)}s`;
    log(`완료 — 전송+압축해제 ${((timings.tFetch-timings.t0)/1000).toFixed(2)}s · 컴파일 ${((timings.tCompile-timings.tFetch)/1000).toFixed(2)}s · 계산 ${(tRun1-tRun0).toFixed(0)}ms (wasm ${wire}MB 해제, gzip 약 18MB 전송)${first}`);
    timings.firstDone = true;
  } catch (e) {
    showError(e);
    log("오류");
  }
}

$("go").addEventListener("click", calculate);

// 자동 실행(헤드리스 스크린샷용). ?auto=1&y=&mo=&d=&h=&mi=&g=&cal=
if (params.get("auto") === "1") {
  const set = (id, key, def) => { const v = params.get(key); $(id).value = v != null ? v : def; };
  set("y","y","2003"); set("mo","mo","2"); set("d","d","22");
  set("h","h","13"); set("mi","mi","13");
  if (params.get("g")) $("g").value = params.get("g");
  if (params.get("cal")) $("cal").value = params.get("cal");
  addEventListener("load", calculate);
}

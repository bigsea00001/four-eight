// 1년 이용권 — 구매 · 결제 뒤 코드 받기 · 코드 입력.
// 사주 계산(app.js)과 따로 둔다. 이 파일이 서버와 주고받는 것은 이용권 찾기표와 코드뿐이다.
//
//   POST /api/pass/checkout → { checkout_url, claim }   결제창 주소와 찾기표
//   GET  /api/pass/claim?token= → pending | ready(code, expires_at) | unknown
//   POST /api/pass/verify { code } → { valid, expires_at }
//
// 찾기표는 결제창으로 떠나기 «전»에 저장한다. BTCPay 가 돌려보내는 주소(?claim=)에만 기대면
// 결제 뒤 창을 닫은 사람은 코드를 받을 길이 없다.

const API = "/api/pass";
const K_CLAIMS = "fe_pass_claims", K_CODE = "fe_pass_code", K_EXP = "fe_pass_exp";
const POLL_MS = 30000;
// 결제 확인을 기다리는 화면은 이 시간까지만 띄운다(결제창 만료 15분 + 블록 확인).
// 그 뒤로도 찾기표는 지우지 않고 열 때마다 조용히 확인한다 — 늦게 확인되는 결제가 있다.
const WAIT_SCREEN_MS = 2 * 60 * 60 * 1000;
const KEEP_MS = 7 * 24 * 60 * 60 * 1000;

const params = new URLSearchParams(location.search);
// 결제 서버가 준비되기 전까지 구매 단추는 ?pass=1 에서만 보인다. 준비되면 true 로 바꾼다.
const BUY_OPEN = params.get("pass") === "1";

// localStorage 는 사생활 보호 창에서 막힐 수 있다 — 막혀도 화면은 돌아야 한다.
const store = {
  get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); return true; } catch (e) { return false; } },
  del(k) { try { localStorage.removeItem(k); } catch (e) { /* 저장만 못 할 뿐 */ } },
};

// 찾기표는 «목록»이다. 칸 하나에 두면 다시 결제할 때 먼저 낸 결제의 찾기표를 덮어쓴다.
// 저장이 막힌 창에서는 이 페이지가 열려 있는 동안만 메모리에 둔다.
let memClaims = null;
function claims() {
  if (memClaims) return memClaims;
  try { return JSON.parse(store.get(K_CLAIMS) || "[]").filter(c => c && c.t); } catch (e) { return []; }
}
function saveClaims(list) {
  const now = Date.now();
  const kept = list.filter(c => now - c.at < KEEP_MS).slice(-5);
  if (store.set(K_CLAIMS, JSON.stringify(kept))) memClaims = null; else memClaims = kept;
  return !memClaims;
}
function addClaim(t) {
  const list = claims().filter(c => c.t !== t);
  list.push({ t, at: Date.now() });
  return saveClaims(list);
}
function dropClaim(t) { saveClaims(claims().filter(c => c.t !== t)); }
const waitingClaims = () => claims().filter(c => !c.dismissed && Date.now() - c.at < WAIT_SCREEN_MS);

const box = document.getElementById("pass");
const link = document.getElementById("passlink");
let pollTimer = null;

const ymd = (iso) => {
  const d = new Date(iso);
  return isNaN(d) ? String(iso || "") : `${d.getFullYear()}년 ${d.getMonth() + 1}월 ${d.getDate()}일`;
};

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

// ── 화면 ────────────────────────────────────────────────────────────────

function renderOwned(code, exp, fresh) {
  box.replaceChildren();
  const b = el("div", "block pass-card");
  b.append(el("div", "btitle", "1년 이용권"));
  b.append(el("div", "pass-exp", `${ymd(exp)}까지 쓸 수 있습니다.`));

  const row = el("div", "pass-code-row");
  const c = el("code", "pass-code", code);
  const copy = el("button", "pass-btn-ghost", "복사");
  copy.addEventListener("click", async () => {
    try { await navigator.clipboard.writeText(code); copy.textContent = "복사됨"; }
    catch (e) { copy.textContent = "길게 눌러 복사"; }
  });
  row.append(c, copy);
  b.append(row);

  const keep = el("div", fresh ? "pass-keep strong" : "pass-keep",
    "이 코드가 이용권입니다. 다른 기기나 브라우저에서는 이 코드를 넣으면 됩니다. " +
    "잃어버리면 다시 찾을 수 없으니 따로 적어 두세요.");
  b.append(keep);
  box.append(b);
}

function renderPending() {
  box.replaceChildren();
  const b = el("div", "block pass-card");
  b.append(el("div", "btitle", "결제를 확인하고 있습니다"));
  b.append(el("div", "sec-b",
    "비트코인 결제는 확인까지 보통 10분에서 1시간쯤 걸립니다. " +
    "이 페이지를 닫았다가 다시 열어도, 확인이 끝나면 여기에 코드가 나옵니다."));
  const s = el("div", "fine pass-status", "");
  s.id = "pass-status";
  b.append(s);
  const back = el("button", "pass-btn-ghost pass-back", "결제하지 않았다면 처음으로");
  back.addEventListener("click", () => {
    // 찾기표는 남긴다 — 결제가 늦게 확인돼도 다음에 열 때 코드가 나온다.
    saveClaims(claims().map(c => ({ ...c, dismissed: true })));
    stopPolling();
    renderShop();
  });
  b.append(back);
  box.append(b);
}

function renderShop(message) {
  box.replaceChildren();
  const b = el("div", "block pass-card");
  if (BUY_OPEN) {
    b.append(el("div", "btitle", "1년 이용권 · 9,900원"));
    b.append(el("div", "sec-b", "AI 점술가 상담을 1년 동안 쓸 수 있습니다. 결제는 비트코인으로 합니다."));
    const buy = el("button", "pass-btn", "비트코인으로 결제하기");
    buy.addEventListener("click", () => startCheckout(buy));
    b.append(buy);
  } else {
    b.append(el("div", "btitle", "1년 이용권"));
  }

  const form = el("div", "pass-enter");
  form.append(el("div", "lab", "코드가 있으면 넣어 주세요"));
  const row = el("div", "pass-code-row");
  const input = el("input", "pass-input");
  input.placeholder = "이용권 코드";
  input.autocomplete = "off";
  input.spellcheck = false;
  const ok = el("button", "pass-btn-ghost", "확인");
  const submit = () => enterCode(input.value.trim(), ok);
  ok.addEventListener("click", submit);
  input.addEventListener("keydown", (e) => { if (e.key === "Enter") submit(); });
  row.append(input, ok);
  form.append(row);
  b.append(form);

  const msg = el("div", "fine pass-msg", message || "");
  msg.id = "pass-msg";
  b.append(msg);
  box.append(b);
}

const say = (id, text) => { const e = document.getElementById(id); if (e) e.textContent = text; };

// ── 동작 ────────────────────────────────────────────────────────────────

async function startCheckout(btn) {
  btn.disabled = true;
  say("pass-msg", "결제창을 여는 중…");
  try {
    const r = await fetch(`${API}/checkout`, { method: "POST" });
    const d = await r.json().catch(() => ({}));
    if (!r.ok || !d.checkout_url || !d.claim) throw new Error(String(r.status));
    addClaim(d.claim);                     // 떠나기 전에 먼저 적는다
    location.href = d.checkout_url;
  } catch (e) {
    btn.disabled = false;
    say("pass-msg", "결제 서버에 연결하지 못했습니다. 잠시 뒤 다시 시도해 주세요.");
  }
}

async function enterCode(code, btn) {
  if (!code) return;
  btn.disabled = true;
  try {
    const r = await fetch(`${API}/verify`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ code }),
    });
    const d = await r.json();
    if (d.valid) {
      if (!store.set(K_CODE, code) || !store.set(K_EXP, d.expires_at)) memCode = { code, exp: d.expires_at };
      renderOwned(code, d.expires_at, false);
      link.textContent = "이용권";
    } else {
      say("pass-msg", "맞지 않거나 기간이 끝난 코드입니다. 다시 확인해 주세요.");
    }
  } catch (e) {
    say("pass-msg", "확인하지 못했습니다. 잠시 뒤 다시 시도해 주세요.");
  } finally {
    btn.disabled = false;
  }
}

// 찾기표를 전부 확인한다. 지우는 것은 서버가 «모른다»고 분명히 답한 것뿐이다 —
// 연결이 끊기거나 서버가 오류를 내면 그대로 두고 다음에 다시 묻는다.
async function checkClaims() {
  let trouble = false;
  for (const c of claims()) {
    let r, d;
    try {
      r = await fetch(`${API}/claim?token=${encodeURIComponent(c.t)}`);
      d = r.ok ? await r.json() : null;
    } catch (e) { d = null; }
    if (!d) { trouble = true; continue; }
    if (d.status === "ready") {
      dropClaim(c.t);
      if (!store.set(K_CODE, d.code) || !store.set(K_EXP, d.expires_at)) memCode = { code: d.code, exp: d.expires_at };
      stopPolling();
      renderOwned(d.code, d.expires_at, true);
      link.textContent = "이용권";
      open(true);
      return;
    }
    if (d.status === "unknown") dropClaim(c.t);
  }
  if (waitingClaims().length) {
    say("pass-status", trouble ? "연결이 잠시 끊겼습니다. 30초 뒤 다시 확인합니다." : `마지막 확인 ${new Date().toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit" })}`);
  } else if (pollTimer) {
    stopPolling();
    draw();
  }
}

function startPolling() {
  if (pollTimer) return;
  pollTimer = setInterval(checkClaims, POLL_MS);
  checkClaims();
}
function stopPolling() { clearInterval(pollTimer); pollTimer = null; }

function open(on) {
  box.hidden = !on;
  link.setAttribute("aria-expanded", String(on));
}

// 확인을 기다리는 결제가 있으면 코드가 있어도 그것이 먼저다 — 연장 결제의 새 코드를 받아야 한다.
function draw() {
  if (waitingClaims().length) { renderPending(); return startPolling(); }
  const code = ownedCode();
  if (code) return renderOwned(code.code, code.exp, false);
  renderShop();
}

let memCode = null;
function ownedCode() {
  const code = store.get(K_CODE);
  return code ? { code, exp: store.get(K_EXP) } : memCode;
}

// ── 시작 ────────────────────────────────────────────────────────────────

// BTCPay 가 돌려보낸 주소(?claim=찾기표). 저장되면 주소창에서 지운다 — 주소를 남에게 보내도 코드가 새지 않게.
// 저장이 막힌 창이면 지우지 않는다. 그 주소가 찾기표의 마지막 사본이다.
const returned = params.get("claim");
if (returned && addClaim(returned)) {
  params.delete("claim");
  const q = params.toString();
  history.replaceState(null, "", location.pathname + (q ? "?" + q : "") + location.hash);
}

const owned = !!ownedCode(), pending = claims().length > 0, waiting = waitingClaims().length > 0;
if (BUY_OPEN || owned || pending) {
  link.hidden = false;
  link.textContent = owned ? "이용권" : "1년 이용권";
  link.addEventListener("click", (e) => { e.preventDefault(); if (box.hidden) draw(); open(box.hidden); });
  draw();
  open(!!returned || waiting);
  // 기다리는 화면이 끝난 찾기표도 열 때마다 한 번 조용히 묻는다 — 늦게 확인된 결제를 위해.
  if (pending && !waiting) checkClaims();
}

// 다른 탭에서 코드를 받으면 이 탭도 따라 바꾼다.
addEventListener("storage", (e) => {
  if (e.key === K_CODE || e.key === K_CLAIMS) { stopPolling(); if (!box.hidden) draw(); link.textContent = ownedCode() ? "이용권" : link.textContent; }
});

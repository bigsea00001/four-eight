// 1년 이용권 — 구매 · 결제 뒤 코드 받기 · 코드 입력.
// 사주 계산(app.js)과 따로 둔다. 이 파일이 서버와 주고받는 것은 이용권 찾기표·코드와 방문 계측 이름뿐이다.
//
//   POST /api/pass/checkout   → { checkout_url, claim }   비트코인 결제창 주소와 찾기표
//   POST /api/pass/bank-order → { order_no, claim, amount_krw, bank, expires_at }   무통장입금 계좌 안내
//   GET  /api/pass/claim?token= → pending | ready(code, expires_at) | expired | unknown
//   POST /api/pass/verify { code } → { valid, expires_at }
//   POST /api/pass/event { e } → 방문 계측 한 건(쿠키·IP 저장 없음, sendBeacon 로 조용히 보낸다)
//
// 찾기표는 결제창으로 떠나기 «전»에(비트코인) 또는 주문을 만들자마자(무통장입금) 저장한다.
// BTCPay 가 돌려보내는 주소(?claim=)에만 기대면 결제 뒤 창을 닫은 사람은 코드를 받을 길이 없다.
// 무통장입금은 계좌·주문번호를 찾기표 항목에 «같이» 저장한다 — 새로 열어도 그 안내가 다시 보이게.

const API = "/api/pass";
const K_CLAIMS = "fe_pass_claims", K_CODE = "fe_pass_code", K_EXP = "fe_pass_exp", K_RCPT = "fe_pass_receipt";
const POLL_MS = 30000;
// 결제 확인을 기다리는 화면은 이 시간까지만 띄운다(결제창 만료 15분 + 블록 확인).
// 그 뒤로도 찾기표는 지우지 않고 열 때마다 조용히 확인한다 — 늦게 확인되는 결제가 있다.
const WAIT_SCREEN_MS = 2 * 60 * 60 * 1000;
const KEEP_MS = 7 * 24 * 60 * 60 * 1000;

const params = new URLSearchParams(location.search);
const BUY_OPEN = true;                                   // 2026-09-24 공개(대표 지시 「모두 공개해」)
// 비트코인은 노드 동기화가 끝나야 결제창이 만들어진다. 끝나면 true 로 바꾼다. ?pass=1 은 미리보기(시험)용.
const BTC_READY = false;
const BTC_OPEN = BTC_READY || params.get("pass") === "1";

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
function addClaim(t, extra) {
  const list = claims().filter(c => c.t !== t);
  list.push({ t, at: Date.now(), ...(extra || {}) });
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

// 방문 계측 — 이름만 보낸다. 쿠키·IP 는 이 코드가 다루지 않는다(서버도 저장하지 않는다).
// 실패해도 조용히 넘어간다 — 계측이 화면 동작을 막으면 안 된다.
function sendEvent(e) {
  if (params.get("debug") === "1" || location.hostname === "localhost") return;
  try { navigator.sendBeacon("/api/pass/event", new Blob([JSON.stringify({ e })], { type: "application/json" })); }
  catch (err) { /* 조용히 무시 */ }
}

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

  // 구매 확인서(전자상거래법 제13조 — 계약 내용을 적은 전자 문서). 결제해서 받은 코드에만 있다.
  const rc = receipt(code);
  if (rc) {
    b.append(el("div", "pass-rcpt", `결제 번호 ${rc.invoice_id} · ${Number(rc.amount_krw).toLocaleString("ko-KR")}원 · 결제 확인 ${ymd(rc.settled_at)}`));
    const save = el("button", "pass-btn-ghost pass-save", "구매 확인서 저장");
    save.addEventListener("click", () => saveReceipt(code, exp, rc));
    b.append(save);
  }

  const keep = el("div", fresh ? "pass-keep strong" : "pass-keep",
    "이 코드가 이용권입니다. 다른 기기나 브라우저에서는 이 코드를 넣으면 됩니다. " +
    "따로 적어 두세요. 잃어버리셨다면 결제에 쓴 비트코인 거래 번호로 다시 찾아 드립니다.");
  b.append(keep);

  // 선물 카드 — 코드가 그대로 이용권이므로, 선물하면 이 기기와 코드를 나눠 쓰게 된다는 것을 먼저 알린다.
  // 🔴 .pass-save 는 "구매 확인서 저장" 전용 셀렉터다(있으면 결제한 코드라는 뜻) — 시험이 그것으로 구매 여부를
  // 가린다. 선물 카드는 결제 여부와 무관하게 항상 보이므로 클래스를 빌리지 않고 인라인 스타일로 같은 모양만 낸다.
  b.append(el("div", "fine",
    "이 코드를 선물하면 받는 분과 함께 쓰게 됩니다 — 이 기기의 이용권도 같은 코드이기 때문입니다. " +
    "각자 따로 쓰려면 새로 하나 더 구매해 주세요."));
  const gift = el("button", "pass-btn-ghost pass-gift", "선물 카드로 저장");
  gift.style.marginTop = ".45rem";
  gift.style.fontSize = ".8rem";
  gift.style.padding = ".3rem .7rem";
  gift.addEventListener("click", () => saveGiftCard(code, exp, gift));
  b.append(gift);

  box.append(b);
}

function copyRow(text, buttonLabel) {
  const row = el("div", "pass-code-row");
  row.append(el("code", "pass-code", text));
  const btn = el("button", "pass-btn-ghost", buttonLabel || "복사");
  btn.addEventListener("click", async () => {
    try { await navigator.clipboard.writeText(text); btn.textContent = "복사됨"; }
    catch (e) { btn.textContent = "길게 눌러 복사"; }
  });
  row.append(btn);
  return row;
}

function renderPending() {
  box.replaceChildren();
  const bankClaim = waitingClaims().find(c => c.bank);
  const b = el("div", "block pass-card");
  if (bankClaim) {
    b.append(el("div", "btitle", "아래 계좌로 9,900원을 보내 주세요"));
    // 한 줄에 몰면 좁은 화면에서 「(예금주」 가운데서 끊긴다 — 항목마다 한 줄, 복사는 계좌번호·입금자명만.
    const dl = el("dl", "pass-bank");
    const row = (label, value, copyVal, strong) => {
      const dt = el("dt", "", label), dd = el("dd", strong ? "strong" : "", value);
      if (copyVal) {
        const btn = el("button", "pass-btn-ghost pass-copy", "복사");
        btn.addEventListener("click", async () => {
          try { await navigator.clipboard.writeText(copyVal); btn.textContent = "복사됨"; }
          catch (e) { btn.textContent = "길게 눌러 복사"; }
        });
        dd.append(btn);
      }
      dl.append(dt, dd);
    };
    row("은행", bankClaim.bank.name);
    row("계좌번호", bankClaim.bank.account, bankClaim.bank.account.replace(/[^0-9]/g, ""));
    row("예금주", bankClaim.bank.holder);
    row("금액", "9,900원");
    row("입금자명", bankClaim.order_no, bankClaim.order_no, true);
    b.append(dl);
    b.append(el("div", "sec-b",
      "입금자명을 주문번호로 적어 주셔야 누가 보낸 돈인지 알 수 있습니다. " +
      "입금을 확인하면 이 화면에 코드가 나옵니다 — 영업일 기준 하루 안에 확인합니다. " +
      "3일 안에 입금이 없으면 주문이 취소됩니다."));
    const cash = el("div", "fine");
    const contact = el("a", "", "문의처"); contact.href = "terms.html"; contact.target = "_blank";
    cash.append("현금영수증이 필요하시면 입금 뒤 주문번호와 발급받을 번호를 ", contact, "로 알려 주세요.");
    b.append(cash);
  } else {
    b.append(el("div", "btitle", "결제를 확인하고 있습니다"));
    b.append(el("div", "sec-b",
      "비트코인 결제는 확인까지 보통 10분에서 1시간쯤 걸립니다. " +
      "이 페이지를 닫았다가 다시 열어도, 확인이 끝나면 여기에 코드가 나옵니다."));
  }
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
    b.append(el("div", "sec-b", "AI 점술가 상담을 1년 동안 쓸 수 있습니다."));
    const buyRow = el("div", "pass-buy-row");
    const buyBtc = el("button", "pass-btn pass-btn-btc", "비트코인으로 결제");
    buyBtc.addEventListener("click", () => startCheckout(buyBtc));
    const buyBank = el("button", "pass-btn pass-btn-bank", "계좌이체로 결제");
    buyBank.addEventListener("click", () => startBankCheckout(buyBank));
    if (BTC_OPEN) buyRow.append(buyBtc);
    buyRow.append(buyBank);
    b.append(buyRow);
    // 결제 «전»에 보여야 하는 것 — 약관·환불 규정(전자상거래법 표시 사항). 링크는 새 탭으로 연다(상자가 닫히지 않게).
    const agree = el("div", "pass-agree");
    const a1 = el("a", "", "이용약관"); a1.href = "terms.html"; a1.target = "_blank";
    const a2 = el("a", "", "환불 규정"); a2.href = "refund.html"; a2.target = "_blank";
    agree.append("결제하면 ", a1, "과 ", a2, "에 동의한 것으로 봅니다. 결제가 확인되고 7일 안에는 이유를 묻지 않고 전액 환불해 드립니다. 하루 10건 · 한 달 100건까지 질문할 수 있습니다. 14세 미만은 이용할 수 없습니다.");
    b.append(agree);
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

function receipt(code) {
  try { const r = JSON.parse(store.get(K_RCPT) || "null"); return r && r.code === code ? r : null; } catch (e) { return null; }
}

// 판매자 정보는 공개 정보만 싣는다. 이메일은 여기서 조립한다 — 이 파일 원문에 @ 주소를 두지 않는다.
function saveReceipt(code, exp, rc) {
  const mail = ["contact", "vrof.co.kr"].join("@");
  const lines = [
    "구매 확인서 — FourEight 사주(fe.eet.kr) 1년 이용권", "",
    "상품        AI 점술가 1년 이용권 (하루 10건 · 한 달 100건)",
    `금액        ${Number(rc.amount_krw).toLocaleString("ko-KR")}원 (부가가치세 포함) · 비트코인 결제`,
    `결제 번호   ${rc.invoice_id}`,
    `결제 확인   ${rc.settled_at}`,
    `이용 기간   ${ymd(rc.settled_at)} ~ ${ymd(exp)}`,
    `이용권 코드 ${code}`, "",
    "환불        결제 확인 후 7일 안에는 이유를 묻지 않고 전액 환불합니다.",
    "            https://fe.eet.kr/refund.html",
    "약관        https://fe.eet.kr/terms.html", "",
    "판매자      주식회사 브이로프 · 사업자등록번호 433-88-02526",
    "            통신판매업 신고번호 제2024-서울은평-0124호",
    "            서울특별시 은평구 은평로13길 11-6, 303호",
    `            070-8246-9001 · ${mail}`,
  ];
  const blob = new Blob([lines.join("\n") + "\n"], { type: "text/plain;charset=utf-8" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `fe-eet-kr-구매확인서-${rc.invoice_id}.txt`;
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

// ── 선물 카드 ───────────────────────────────────────────────────────────
// 코드가 곧 이용권이므로, 이 카드에는 코드와 만료일만 싣는다.
// 🔴 결제 번호·금액·구매자 정보는 절대 넣지 않는다 — 이 카드는 남에게 건네질 수 있다.

const GIFT_W = 1080, GIFT_H = 1350;

function loadImageSafe(src) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null); // 이미지 없이도 카드는 만들어진다
    img.src = src;
  });
}

// 한글은 띄어쓰기 단위로만 끊는다(word-break:keep-all 과 같은 생각).
function wrapCentered(ctx, text, cx, y, maxWidth, lineHeight) {
  const words = text.split(" ");
  const lines = [];
  let line = "";
  for (const w of words) {
    const test = line ? line + " " + w : w;
    if (line && ctx.measureText(test).width > maxWidth) { lines.push(line); line = w; }
    else line = test;
  }
  if (line) lines.push(line);
  lines.forEach((l, i) => ctx.fillText(l, cx, y + i * lineHeight));
  return y + lines.length * lineHeight;
}

async function buildGiftCanvas(code, exp) {
  const canvas = document.createElement("canvas");
  canvas.width = GIFT_W; canvas.height = GIFT_H;
  const ctx = canvas.getContext("2d");
  const cx = GIFT_W / 2;

  const PAPER = "#FAF7F0", INK = "#2A251F", INK_SOFT = "#6B6154", INK_FAINT = "#9A9083",
    CINNABAR = "#B43A2E", SURFACE = "#FFFFFF", LINE = "#E2D9C9";

  ctx.fillStyle = PAPER;
  ctx.fillRect(0, 0, GIFT_W, GIFT_H);

  // 위쪽 한지 이미지 — 세로가 훨씬 긴 원본이라 카드 상단 띠 높이만큼만 잘라 보인다.
  const BANNER_H = 620;
  const hero = await loadImageSafe("assets/hero-tall.webp");
  if (hero) {
    ctx.save();
    ctx.beginPath(); ctx.rect(0, 0, GIFT_W, BANNER_H); ctx.clip();
    const h = GIFT_W * (hero.height / hero.width);
    ctx.drawImage(hero, 0, 0, GIFT_W, h);
    ctx.restore();
    const fade = ctx.createLinearGradient(0, BANNER_H - 180, 0, BANNER_H);
    fade.addColorStop(0, "rgba(250,247,240,0)");
    fade.addColorStop(1, PAPER);
    ctx.fillStyle = fade;
    ctx.fillRect(0, BANNER_H - 180, GIFT_W, 180);
  }

  // 글꼴이 실려 있어야 그릴 때 바로 반영된다 — 실패해도 대체 글꼴로 그려진다.
  try {
    await document.fonts.load('700 56px "Noto Serif KR"');
    await document.fonts.load('700 30px "Noto Serif KR"');
  } catch (e) { /* 대체 글꼴로 진행 */ }

  ctx.textAlign = "center";

  ctx.fillStyle = CINNABAR;
  ctx.font = '700 84px "Noto Serif KR", "AppleMyungjo", "Nanum Myeongjo", serif';
  ctx.fillText("四八", cx, 700);

  ctx.fillStyle = INK;
  ctx.font = '700 42px "Noto Serif KR", "AppleMyungjo", "Nanum Myeongjo", serif';
  ctx.fillText("FourEight 사주 · 1년 이용권 선물", cx, 768);

  // 코드 상자
  const boxW = 900, boxH = 130, boxY = 830;
  ctx.fillStyle = SURFACE;
  ctx.strokeStyle = LINE; ctx.lineWidth = 2;
  roundRect(ctx, cx - boxW / 2, boxY, boxW, boxH, 16);
  ctx.fill(); ctx.stroke();
  ctx.fillStyle = INK;
  ctx.font = '700 58px ui-monospace, "SFMono-Regular", Menlo, monospace';
  ctx.fillText(code, cx, boxY + boxH / 2 + 20);

  // 쓰는 법
  ctx.fillStyle = INK_SOFT;
  ctx.font = '30px -apple-system, "Pretendard", "Apple SD Gothic Neo", sans-serif';
  wrapCentered(ctx, "fe.eet.kr 에서 위쪽 「이용권」을 눌러 이 코드를 넣으면 AI 점술가 상담을 1년 동안 쓸 수 있습니다.",
    cx, 1040, 860, 44);

  // 만료일
  ctx.fillStyle = INK_FAINT;
  ctx.font = '28px -apple-system, "Pretendard", sans-serif';
  ctx.fillText(`${ymd(exp)}까지 씁니다`, cx, 1230);

  ctx.font = '600 24px -apple-system, "Pretendard", sans-serif';
  ctx.fillStyle = CINNABAR;
  ctx.fillText("fe.eet.kr", cx, 1290);

  return canvas;
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

async function saveGiftCard(code, exp, btn) {
  const original = btn.textContent;
  btn.disabled = true;
  btn.textContent = "카드 만드는 중…";
  try {
    const canvas = await buildGiftCanvas(code, exp);
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
    if (!blob) throw new Error("no-blob");
    const file = new File([blob], `fe-eet-kr-선물카드-${code}.png`, { type: "image/png" });

    // 휴대폰이면 공유 시트를 먼저 시도한다 — 메시지·카카오톡으로 바로 건넬 수 있다.
    if (navigator.share && navigator.canShare && navigator.canShare({ files: [file] })) {
      try {
        await navigator.share({ files: [file], title: "FourEight 사주 1년 이용권 선물" });
        return;
      } catch (e) {
        if (e && e.name === "AbortError") return; // 사용자가 공유를 취소한 것 — 대신 저장하지 않는다
        // 공유가 지원된다고 했는데 실패했으면 저장으로 대신한다
      }
    }
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = file.name;
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  } catch (e) {
    btn.textContent = "만들지 못했습니다";
    setTimeout(() => { btn.textContent = original; btn.disabled = false; }, 2000);
    return;
  }
  btn.textContent = original;
  btn.disabled = false;
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
    sendEvent("checkout_btc");
    location.href = d.checkout_url;
  } catch (e) {
    btn.disabled = false;
    say("pass-msg", "결제 서버에 연결하지 못했습니다. 잠시 뒤 다시 시도해 주세요.");
  }
}

async function startBankCheckout(btn) {
  btn.disabled = true;
  say("pass-msg", "주문을 만드는 중…");
  try {
    const r = await fetch(`${API}/bank-order`, { method: "POST" });
    if (r.status === 503) {
      btn.hidden = true;
      say("pass-msg", "지금은 계좌이체를 쓸 수 없습니다. 비트코인으로 결제해 주세요.");
      return;
    }
    const d = await r.json().catch(() => ({}));
    if (!r.ok || !d.claim || !d.order_no || !d.bank) throw new Error(String(r.status));
    addClaim(d.claim, { order_no: d.order_no, amount_krw: d.amount_krw, bank: d.bank, expires_at: d.expires_at });
    sendEvent("checkout_bank");
    stopPolling();
    draw();
  } catch (e) {
    btn.disabled = false;
    say("pass-msg", "주문을 만들지 못했습니다. 잠시 뒤 다시 시도해 주세요.");
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
      sendEvent("code_ok");
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
  let trouble = false, expired = false;
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
      if (d.invoice_id) store.set(K_RCPT, JSON.stringify({ code: d.code, invoice_id: d.invoice_id, amount_krw: d.amount_krw, settled_at: d.settled_at }));
      stopPolling();
      renderOwned(d.code, d.expires_at, true);
      link.textContent = "이용권";
      open(true);
      return;
    }
    if (d.status === "unknown") dropClaim(c.t);
    if (d.status === "expired") { dropClaim(c.t); expired = true; }
  }
  // 만료는(2시간짜리 활성 폴링 창을 지나 3일 뒤에나 나오는 것이 보통이다) 발견하면 즉시 알린다 —
  // ready 가 그러듯, 조용한 배경 확인이었어도 상자를 열어 보여 준다.
  if (expired) {
    stopPolling();
    const owned = ownedCode();
    if (owned) renderOwned(owned.code, owned.exp, false);
    else renderShop("입금 기한이 지나 주문이 취소되었습니다. 입금하셨다면 주문번호와 입금한 날을 문의처로 알려 주세요.");
    link.textContent = ownedCode() ? "이용권" : "1년 이용권";
    open(true);
    return;
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

sendEvent("view");

const owned = !!ownedCode(), pending = claims().length > 0, waiting = waitingClaims().length > 0;
link.addEventListener("click", (e) => {
  e.preventDefault();
  const willOpen = box.hidden;
  if (box.hidden) draw();
  open(box.hidden);
  if (willOpen) sendEvent("pass_open");
});
if (BUY_OPEN || owned || pending) {
  link.hidden = false;
  link.textContent = owned ? "이용권" : "1년 이용권";
  draw();
  open(!!returned || waiting);
  // 기다리는 화면이 끝난 찾기표도 열 때마다 한 번 조용히 묻는다 — 늦게 확인된 결제를 위해.
  if (pending && !waiting) checkClaims();
}

// AI 점술가가 「이용권이 필요하다」고 답하면 상자를 열어 위로 올린다(app.js 가 보낸다).
addEventListener("fe-pass:need", () => {
  link.hidden = false;
  draw();
  open(true);
  box.scrollIntoView({ behavior: "smooth", block: "start" });
});

// 다른 탭에서 코드를 받으면 이 탭도 따라 바꾼다.
addEventListener("storage", (e) => {
  if (e.key === K_CODE || e.key === K_CLAIMS) { stopPolling(); if (!box.hidden) draw(); link.textContent = ownedCode() ? "이용권" : link.textContent; }
});

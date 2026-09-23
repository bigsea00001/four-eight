// 사업자 정보를 이미지로 뽑는다 — 봇이 상호·등록번호·주소·이메일을 글자로 긁어가지 못하게.
// vrof.co.kr scripts/bizinfo/generate.mjs 와 같은 방식이다(2026-08-08 대표 지시).
//
//   NODE_PATH=~/browser-ctl/node_modules node tools/bizinfo/generate.js
//   → web/assets/bizinfo-light.webp · bizinfo-dark.webp · web/assets/bizinfo.json(폭·높이)
//
// 값은 bizinfo.json 한 곳에만 둔다. 이 폴더는 배포되지 않는다(deploy.sh 는 web/ 만 올린다).
// 폭 344 — 390 화면에서 여백을 빼고 1:1 로 놓이는 폭(vrof 와 같은 이유: 이미지는 줄면 글자가 뭉개진다).
const { chromium } = require("playwright-core");
const fs = require("fs"), path = require("path"), { execFileSync } = require("child_process");
const HERE = __dirname, WEB = path.join(HERE, "..", "..", "web");
const { rows } = JSON.parse(fs.readFileSync(path.join(HERE, "bizinfo.json"), "utf8"));
const WIDTH = 344, SCALE = 2;
// fe.eet.kr index.html 의 색 토큰 그대로 — 라벨 --ink-soft, 값 --ink.
const THEME = { light: { lab: "#6B6154", val: "#2A251F" }, dark: { lab: "#ABA294", val: "#E8E1D6" } };

(async () => {
  const br = await chromium.launch({ executablePath: process.env.CHROME });
  let height = 0;
  for (const theme of ["light", "dark"]) {
    const p = await (await br.newContext({ deviceScaleFactor: SCALE, viewport: { width: WIDTH, height: 600 } })).newPage();
    const t = THEME[theme];
    await p.setContent(`<!doctype html><html lang="ko"><head><meta charset="utf-8"><style>
      html,body{margin:0;background:transparent}
      dl{margin:0;width:${WIDTH}px;padding:8px;box-sizing:border-box;display:grid;gap:.55rem;
         font:13px/1.5 -apple-system,"Pretendard","Apple SD Gothic Neo","Noto Sans CJK KR",sans-serif;word-break:keep-all}
      dl>div{display:grid;gap:.1rem} dt{font-size:12px;color:${t.lab}} dd{margin:0;color:${t.val}}
      .num{font-family:ui-monospace,Menlo,"DejaVu Sans Mono",monospace}
    </style></head><body><dl id="shot"></dl></body></html>`);
    await p.evaluate((rows) => {
      const shot = document.getElementById("shot");
      for (const [k, v, mono] of rows) {
        const d = document.createElement("div"), dt = document.createElement("dt"), dd = document.createElement("dd");
        dt.textContent = k; dd.textContent = v; if (mono) dd.className = "num";
        d.append(dt, dd); shot.append(d);
      }
    }, rows);
    await p.evaluate(() => document.fonts.ready);
    const el = await p.$("#shot");
    height = Math.ceil((await el.boundingBox()).height);
    const png = path.join(WEB, "assets", `bizinfo-${theme}.png`);
    await el.screenshot({ path: png, omitBackground: true });
    const webp = png.replace(/\.png$/, ".webp");
    execFileSync("python3", ["-c", `from PIL import Image; Image.open(${JSON.stringify(png)}).save(${JSON.stringify(webp)}, "WEBP", lossless=True, quality=100)`]);
    fs.rmSync(png);
    console.log(`  bizinfo-${theme}.webp  ${fs.statSync(webp).size.toLocaleString()} B`);
  }
  fs.writeFileSync(path.join(WEB, "assets", "bizinfo.json"), JSON.stringify({ width: WIDTH, height }) + "\n");
  console.log(`  ${rows.length}행 · ${WIDTH}×${height} · ${SCALE}배`);
  await br.close();
})();

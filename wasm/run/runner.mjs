// wasm을 "브라우저가 하는 방식 그대로" 돌려 보는 실행기입니다.
//
// 왜 node:wasi가 아니라 @bjorn3/browser_wasi_shim인가 — node의 내장 WASI는
// 진짜 파일시스템과 OS를 그대로 열어 줍니다. 그걸로 성공해도 브라우저에서
// 된다는 증거가 못 됩니다. 이 shim은 브라우저용으로 만들어진 순수 JS 구현이고
// 파일시스템도 메모리 위에만 있습니다. 여기서 되면 브라우저에서도 됩니다.
import { WASI, File, Directory, OpenFile, ConsoleStdout, PreopenDirectory }
  from "@bjorn3/browser_wasi_shim";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, basename } from "node:path";

// 호스트 디렉터리를 메모리 파일시스템으로 옮깁니다. 브라우저에서는 이 자리에
// fetch()로 받은 바이트가 들어갑니다 — 서버로 나가는 것은 규칙 파일이지
// 생년월일이 아닙니다.
function loadDir(hostPath) {
  const entries = new Map();
  for (const name of readdirSync(hostPath)) {
    const p = join(hostPath, name);
    // tzdata 안에는 끊어진 심볼릭 링크(localtime)가 있습니다. 못 읽는 것은 건너뜁니다.
    try {
      entries.set(name, statSync(p).isDirectory()
        ? loadDir(p)
        : new File(readFileSync(p)));
    } catch { /* 읽을 수 없는 항목은 없는 것으로 둔다 */ }
  }
  return new Directory(entries);
}

const [wasmPath, resourcesPath, ...args] = process.argv.slice(2);

const root = new Map();
// resourcesPath는 "호스트경로@가상경로" 꼴을 받습니다. Bundle.module이 링크 당시의
// 절대 경로를 기억하고 있어서, 그 자리에 그대로 놓아 봐야 원인이 확인됩니다.
if (resourcesPath) {
  const [hostDir, vfsPath] = resourcesPath.split("@");
  const dir = loadDir(hostDir);
  const parts = (vfsPath ?? "/" + basename(hostDir)).split("/").filter(Boolean);
  let cur = root;
  for (const part of parts.slice(0, -1)) {
    if (!cur.has(part)) cur.set(part, new Directory(new Map()));
    cur = cur.get(part).contents;
  }
  cur.set(parts[parts.length - 1], dir);
}
// tzdata는 싣지 않습니다. 확인해 보니 wasm의 Foundation은 시간대 자료를
// 바이너리 안에 이미 들고 있습니다 — 1961년 UTC+8:30도, 1988년 서머타임도
// 파일시스템 없이 그대로 나옵니다.

const fds = [
  new OpenFile(new File([])),
  ConsoleStdout.lineBuffered((m) => console.log(m)),
  ConsoleStdout.lineBuffered((m) => console.error("[stderr] " + m)),
  new PreopenDirectory("/", root),
];

const wasi = new WASI(["SajuProof", ...args], [], fds, { debug: false });

// @bjorn3/browser_wasi_shim 0.4.2 버그 우회 — 이 한 줄에 한나절이 갈 수 있습니다.
//
// `args_sizes_get`은 인자 버퍼 크기를 JS 문자열 길이(UTF-16 단위)로 세는데
// `args_get`은 UTF-8로 씁니다. "남"은 1 대 3이라 wasm 쪽 버퍼 밖으로 넘겨 씁니다.
// 그 자리에서 죽지 않고 힙만 망가뜨리므로, 한참 뒤 엉뚱한 곳에서
// `memory access out of bounds`로 죽습니다. 인자에 한글이 몇 글자 있느냐와
// 다른 인자들의 길이에 따라 죽기도 하고 멀쩡하기도 해서, 날짜 탓처럼 보입니다.
// 사주 앱은 인자가 한국어라 이 버그를 정면으로 밟습니다.
const utf8 = new TextEncoder();
wasi.wasiImport.args_sizes_get = (argcPtr, argvBufSizePtr) => {
  const view = new DataView(wasi.inst.exports.memory.buffer);
  view.setUint32(argcPtr, wasi.args.length, true);
  const bytes = wasi.args.reduce((n, a) => n + utf8.encode(a).length + 1, 0);
  view.setUint32(argvBufSizePtr, bytes, true);
  return 0;
};
const module = await WebAssembly.compile(readFileSync(wasmPath));

console.error("[imports] " + JSON.stringify(
  [...new Set(WebAssembly.Module.imports(module).map((i) => i.module))]));

const instance = await WebAssembly.instantiate(module, {
  wasi_snapshot_preview1: wasi.wasiImport,
});
try {
  wasi.start(instance);
} catch (e) {
  console.error("[trap] " + e);
  process.exit(1);
}

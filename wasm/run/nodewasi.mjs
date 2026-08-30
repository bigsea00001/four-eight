// 대조군: node 내장 WASI(진짜 파일시스템). browser_wasi_shim과 결과가 갈리면
// 문제는 wasm이 아니라 shim 쪽입니다.
import { WASI } from "node:wasi";
import { readFileSync } from "node:fs";
const [wasmPath, preopen, ...args] = process.argv.slice(2);
const wasi = new WASI({
  version: "preview1",
  args: ["SajuProof", ...args],
  env: {},
  preopens: { "/rules": preopen },
});
const m = await WebAssembly.compile(readFileSync(wasmPath));
const i = await WebAssembly.instantiate(m, wasi.getImportObject());
try { wasi.start(i); } catch (e) { console.error("[trap] " + e); process.exit(1); }

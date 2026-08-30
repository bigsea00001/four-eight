#!/usr/bin/env python3
# 127.0.0.1 에만 붙는 정적 서버입니다. 80·443 은 잡지 않습니다.
# .wasm 요청에는 미리 만들어 둔 .wasm.gz 를 gzip 인코딩으로 돌려줍니다 —
# 브라우저가 실제로 받는 양(약 18MB)을 재현하기 위해서입니다.
import http.server, socketserver, os, sys

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8137
DIR = os.path.dirname(os.path.abspath(__file__))

class H(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *a, **k):
        super().__init__(*a, directory=DIR, **k)
    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()
    def do_GET(self):
        path = self.path.split("?", 1)[0]
        if path.endswith("SajuProof.wasm"):
            gz = os.path.join(DIR, "SajuProof.wasm.gz")
            accepts_gz = "gzip" in self.headers.get("Accept-Encoding", "")
            if accepts_gz and os.path.exists(gz):
                data = open(gz, "rb").read()
                self.send_response(200)
                self.send_header("Content-Type", "application/wasm")
                self.send_header("Content-Encoding", "gzip")
                self.send_header("Content-Length", str(len(data)))
                self.send_header("Cache-Control", "no-store")
                self.end_headers()
                self.wfile.write(data)
                return
        return super().do_GET()

class TCP(socketserver.ThreadingTCPServer):
    allow_reuse_address = True

with TCP(("127.0.0.1", PORT), H) as httpd:
    print(f"serving {DIR} on http://127.0.0.1:{PORT}", flush=True)
    httpd.serve_forever()

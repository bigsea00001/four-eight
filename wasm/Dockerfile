# SajuKit을 WebAssembly로 빌드하기 위한 도커 이미지입니다.
#
# 왜 도커인가 — 이 서버에는 Swift를 설치할 권한이 없고, 설치할 이유도 없습니다.
# 툴체인은 빌드에만 필요하고 결과물(.wasm)은 그것과 무관하게 브라우저가 실행합니다.
#
# 왜 서드파티 SwiftWasm이 아니라 공식 swift 이미지인가 — Swift 6.2부터 WebAssembly가
# 공식 Swift SDK로 배포됩니다. 별도 툴체인을 쓸 이유가 없어졌습니다.
FROM swift:6.3.3-noble

# 호스트 사용자(uid 1001)와 같은 uid로 만듭니다. 마운트한 저장소에 root 소유
# 파일을 남기지 않기 위해서입니다.
RUN useradd -u 1001 -m builder

# SDK를 이미지에 미리 넣습니다. --rm 컨테이너는 매번 HOME이 사라지므로
# 실행 때마다 72MB를 다시 받는 일을 피합니다.
#
# 원격 URL로 바로 설치하면 swift가 --checksum을 요구하는데, swift.org가 이 번들의
# sha256을 공표하지 않습니다(PGP 서명만 올려 둡니다). 그래서 직접 받아 아래 값과
# 대조한 뒤 로컬 경로로 설치합니다. 아래 sha256은 2026-08-30에 받은 파일에서
# 계산한 값입니다 — swift.org가 공표한 값이 아니므로, 배포본이 바뀌면 여기서 멈춥니다.
ARG SDK_URL=https://download.swift.org/swift-6.3.3-release/wasm-sdk/swift-6.3.3-RELEASE/swift-6.3.3-RELEASE_wasm.artifactbundle.tar.gz
ARG SDK_SHA256=cabfa08b73bb8ac783927ecd15fa386e99d0c139c5f232445067bcf58379cae7
# swift 이미지에는 curl이 없습니다(curl-config만 있습니다).
RUN apt-get update \
 && apt-get install -y --no-install-recommends curl \
 && curl -fsSL -o /tmp/wasm-sdk.tar.gz "$SDK_URL" \
 && echo "$SDK_SHA256  /tmp/wasm-sdk.tar.gz" | sha256sum -c - \
 && rm -rf /var/lib/apt/lists/*

USER builder
RUN swift sdk install /tmp/wasm-sdk.tar.gz && swift sdk list

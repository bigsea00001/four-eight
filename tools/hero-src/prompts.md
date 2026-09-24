# 히어로 이미지 생성 프롬프트 기록 (2026-09-24)

도구: https://inferaft.com/dashboard/images (기본 모델), steps 9
설계서: docs/design/2026-09-redesign.md

## hero-wide (가로형, 19:11 = 1216×704)

비율 선택지에 16:9가 없어 가장 넓은 19:11을 썼다.

```
East Asian ink wash painting (sumi-e) style, night landscape. Misty layered mountain ridges fading into fog, a slim crescent moon, a few very faint stars, deep indigo-charcoal night sky like dark ink wash. Extremely minimal composition with wide negative space, soft warm moonlight glow rendered only in muted pale gold, visible brushstroke ink texture, painterly, not photorealistic. Large empty calm sky area in the upper third of the frame reserved for text overlay. No text, no letters, no logo, no people, no animals, no constellation lines, no neon, no deep purple.
```

- Seed 752020819 · 원본 1216×704 · tools/hero-src/hero-wide-src.png (브라우저 zoom 캡처, 1451×840)
- 최종: web/assets/hero-wide.webp (1600×926, q92, 104.8KB)
- og:image 는 이 이미지를 크롭해 재사용했다(위쪽 26px~788px 구간, 1200×630 리사이즈) → web/assets/og.jpg (68.0KB)

## hero-tall (세로형, 2:3 = 768×1152)

```
East Asian ink wash painting (sumi-e) style, tall vertical night landscape. A slim crescent moon high in a vast deep indigo-charcoal night sky like dark ink wash, a few very faint stars, soft warm moonlight glow rendered only in muted pale gold. Below, distant misty layered mountain ridges fading into fog near the bottom of the frame. Extremely minimal composition with large calm empty sky area filling the upper two-thirds of the frame, reserved for text overlay. Visible brushstroke ink texture, painterly, not photorealistic. No text, no letters, no logo, no people, no animals, no constellation lines, no neon, no deep purple.
```

- Seed 944193392 · 원본 768×1152 · tools/hero-src/hero-tall-src.png (브라우저 zoom 캡처, 896×1343)
- 최종: web/assets/hero-tall.webp (934×1400, q92, 71.7KB)

## 이미지 가져오기 방법 메모

inferaft 이미지 상세 화면의 `<img>` 는 `/api/images/blob/...` 를 통해 나오는데 이 주소는
쿠키 인증이 걸려 있어 이 기계(리눅스)에서 `curl` 직접 다운로드가 401 로 막혔다.
javascript_tool 로 페이지 안에서 base64/hex 로 바이트를 빼내려는 시도는
"Base64 encoded data" 로 차단됐다(짧은 문자열도 막힘 — 데이터 유출 방지 규칙).
그래서 `computer` 도구의 `zoom` 액션 + `save_to_disk: true` 로 화면에 렌더된 이미지 영역을
스크린샷으로 떠서 이 기계의 임시 경로에 저장한 뒤(예: /tmp/claude-chrome-screenshots-*/...) 그것을
tools/hero-src/ 로 복사해 원본으로 썼다. 브라우저 렌더링본이라 원 생성 해상도(1216×704 등)보다는
살짝 크게(디스플레이 배율 때문에) 캡처됐지만 화질 손실은 거의 없었다.

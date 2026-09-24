# fe.eet.kr 화면 개편 설계서 (2026-09-24)

회의: qoder Qwen3.8-Flash · pi glm-5.3-flash · pi deepseek-v4-flash 2라운드 (`~/.claude/회의/fe-디자인-20260924_104823`).
대표 요구: 「세련되고 깔끔하고 신비로운」, 2026년 9월 운세·사주 흐름 반영.

## 방향 — 먹과 한지 골격 + 첫 화면 한 곳의 밤 풍경
- 골격: 한지 미색 바탕, 먹빛 글자, 주사(#B43A2E) 포인트, 명조 제목. **OS 밝음/어두움 두 벌 유지**(어두운 쪽은 지금의 따뜻한 차콜).
- 신비: **첫 화면 히어로 한 곳**에만 밤 풍경 이미지(운무 낀 산·초승달·옅은 별, 먹빛 남색). 트렌드 조사의 「검정 + 절제된 금」은 이 이미지 안에서만.
- 식상한 것 피하기(조사 8절): 반짝이는 별 애니메이션, 과한 별 장식, 진보라+금, 네온.
- 움직임: 히어로의 아주 느린 운무 흐름 정도. `prefers-reduced-motion` 이면 멈춘다.

## 지킬 제약 (회의에서 나온 것 — 어기면 되돌린다)
1. **오행 색 값 보존** — `--wood --fire --earth --metal --water` 라이트·다크 값 그대로(CLAUDE.md §13 검증값). 금은 금색이 아니라 `#8898EC`. **금빛 장식선을 명식 데이터 근처에 쓰지 않는다.**
2. OS 두 모드 유지. 강제 다크 금지. 사업자 정보 `picture` 스왑이 이 전제다.
3. 0.66~0.74rem 글자·표 뒤에 이미지·질감을 깔지 않는다. 가능하면 최소 글자를 0.75rem 로 올린다.
4. 이미지는 가볍게 — 히어로 webp 합계 250KB 이하, 히어로 말고는 lazy. 계산 엔진 18MB 가 이미 있다.
5. `#loading #status #error #result` 에 `aria-live`(polite, 오류는 assertive).
6. 하드코딩 색을 토큰으로 — `.chotline background:#fff6f5`, 모달 오버레이 등.
7. **app.js·pass.js 가 쓰는 id·class 를 바꾸지 않는다** (go y mo d h mi g cal loading loadmsg status error result pass passlink, .tab .panel .ctopic #cq #csend #cbox .cm-ok .pass-* 등).
8. 시험 통과: 헤드리스 `run.js` 50 · `legal.js` 33 (scratchpad passtest).

## 할 일
- 첫 화면: 히어로(이미지 + 명조 제목 한 줄 + 짧은 설명) → 입력 카드 하나로 정돈(라벨·칸 정렬, 모바일 2열).
- 개발용 기록 줄(`#status` 의 전송·컴파일 시간)은 `?debug=1` 일 때만. 평소엔 「계산 완료」 수준.
- 결과: 탭을 차분하게(밑줄형 유지 가능), 풀이 문단은 여백·소제목으로 숨 쉬게, 카드 그림자 대신 얇은 선.
- 글꼴: 제목 Noto Serif KR(Google Fonts, 필요한 굵기만), 본문 Pretendard 또는 시스템 고딕.
- 하단: 약관 링크 + 사업자 정보 이미지 — 데스크톱은 두 칸, 무게를 덜어 준다(이미지 폭은 줄이지 않는다 — 글자가 뭉개진다).
- 약관 세 페이지(legal.css)도 같은 글꼴·토큰.
- og:image 1200×630 한 장.

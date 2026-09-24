// PostHog 방문 분석 — 공식 웹 스니펫(https://posthog.com/docs/libraries/js, 2026-09-24 확인).
// 설정은 hill.pe.kr·eet.kr 과 같다(프로젝트 604287, identified_only, 녹화 켬, maskAllInputs).
// 토큰은 공개 클라이언트 키다(페이지 소스에 드러나는 값).
// 이 파일은 페이지가 직접 부르지 않는다 — consent.js 가 불러온다(index · 2027 · privacy · terms · refund).
//   · EU·EEA·영국·스위스 방문자: 동의한 뒤에만 불러오고, opt_out_capturing_by_default 로 시작해
//     loaded 에서 opt_in_capturing() · startSessionRecording() 한다. 동의를 거두면 consent.js 가 끈다.
//   · 그 밖의 방문자: 곧바로 불러온다. 국가 판별은 consent.js 머리 주석(hill.pe.kr/api/geo)에 있다.
//
// 🔴 생년월일시와 그 계산 결과는 녹화·자동수집에서 가린다 — class="ph-no-capture"
//    (https://posthog.com/docs/session-replay/privacy). 붙인 자리(index.html):
//    입력 칸 묶음 세 개(.fgroup) · 이용권 상자(#pass — 코드·찾기표·확인서) · 결과(#result — 명식·풀이·AI 상담 대화).
//    이런 글자가 나오는 새 요소를 만들면 그 요소(또는 부모)에도 붙인다.
//    개인정보처리방침(privacy.html 1항 사 · 4항 · 6항)이 이 가림과 주소 값 지우기를 적고 있다 — 바꾸면 방침도 같이 본다.
!function(t,e){var o,n,p,r;e.__SV||(window.posthog=e,e._i=[],e.init=function(i,s,a){function g(t,e){var o=e.split(".");2==o.length&&(t=t[o[0]],e=o[1]),t[e]=function(){t.push([e].concat(Array.prototype.slice.call(arguments,0)))}}(p=t.createElement("script")).type="text/javascript",p.crossOrigin="anonymous",p.async=!0,p.src=s.api_host.replace(".i.posthog.com","-assets.i.posthog.com")+"/static/array.js",(r=t.getElementsByTagName("script")[0]).parentNode.insertBefore(p,r);var u=e;for(void 0!==a?u=e[a]=[]:a="posthog",u.people=u.people||[],Object.defineProperty(u,"toString",{configurable:!0,enumerable:!0,writable:!0,value:function(t){var e="posthog";return"posthog"!==a&&(e+="."+a),t||(e+=" (stub)"),e}}),Object.defineProperty(u.people,"toString",{configurable:!0,enumerable:!0,writable:!0,value:function(){return u.toString(1)+".people (stub)"}}),o="init capture register register_once register_for_session unregister unregister_for_session getFeatureFlag getFeatureFlagResult isFeatureEnabled reloadFeatureFlags updateEarlyAccessFeatureEnrollment getEarlyAccessFeatures on onFeatureFlags onSessionId getSurveys getActiveMatchingSurveys renderSurvey canRenderSurvey getNextSurveyStep identify setPersonProperties group resetGroups setPersonPropertiesForFlags resetPersonPropertiesForFlags setGroupPropertiesForFlags resetGroupPropertiesForFlags reset get_distinct_id getGroups get_session_id get_session_replay_url alias set_config startSessionRecording stopSessionRecording sessionRecordingStarted captureException loadToolbar get_property getSessionProperty createPersonProfile opt_in_capturing opt_out_capturing has_opted_in_capturing has_opted_out_capturing clear_opt_in_out_capturing debug".split(" "),n=0;n<o.length;n++)g(u,o[n]);e._i.push([i,s,a])},e.__SV=1)}(document,window.posthog||[]);
(function () {
    // 주소창의 이 값들은 PostHog 로 보내지 않는다(페이지 주소·직전 주소·첫 주소 모두에서 지운다).
    //   claim            — 결제 뒤 BTCPay 가 돌려보내는 찾기표(pass.js 가 저장 뒤 주소에서 지우지만, 그 전에 잡힐 수 있다)
    //   auto·y·mo·d·h·mi·g·cal — 자동 실행용 생년월일시(app.js 맨 끝)
    // 방법은 PostHog 문서의 before_send URL 가림 예시를 따랐다(https://posthog.com/docs/libraries/js/features, 2026-09-24 확인).
    var DROP = ['claim', 'auto', 'y', 'mo', 'd', 'h', 'mi', 'g', 'cal'];
    function clean(v) {
        if (typeof v !== 'string' || v.indexOf('?') === -1) return v;
        try {
            var u = new URL(v, location.origin);
            var hit = false;
            DROP.forEach(function (k) { if (u.searchParams.has(k)) { u.searchParams.delete(k); hit = true; } });
            return hit ? u.toString() : v;
        } catch (e) { return v; }
    }
    function cleanProps(o) {
        if (!o || typeof o !== 'object') return;
        Object.keys(o).forEach(function (k) {
            if (/url|referrer|href/i.test(k)) o[k] = clean(o[k]);
        });
    }
    var hc = window.hillConsent;
    var config = {
        api_host: 'https://us.i.posthog.com',
        defaults: '2026-05-30',
        person_profiles: 'identified_only',
        session_recording: {
            maskAllInputs: true, // 입력칸 전부 가림(생년월일시·성별·달력·상담 입력)
        },
        before_send: function (event) {
            if (!event) return event;
            cleanProps(event.properties);
            cleanProps(event.$set);
            cleanProps(event.$set_once);
            return event;
        },
    };
    if (hc && hc.isRequired()) {
        config.opt_out_capturing_by_default = true;
        config.loaded = function (ph) { hc.onPosthogLoaded(ph); };
    }
    posthog.init('phc_pB3UZxBy5FJsmrKjeGH6AeDjNfesQgJFS35gVeSZk7MH', config);
})();

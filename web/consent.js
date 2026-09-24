// 분석 도구 동의 — EU·EEA·영국·스위스 방문자에게만 묻는다.
// [consent]
//
// 정본은 hill(pdf 저장소 js/consent.js)이다. fe.eet.kr 에서 바꾼 것:
//   머리 주석 · 국가 주소(아래 GEO_URL) · 도구 ID(비움) · posthog.js 경로 · 방침 링크(privacy.html) · STRINGS.
// 이 파일이 PostHog 를 켜는 유일한 자리다. 페이지마다 <script src="consent.js" data-tools="posthog" defer> 로 부른다
//   (index · 2027 · privacy · terms · refund). fe.eet.kr 에는 GA4·Clarity 가 없다 — 그래서 두 ID 는 비워 둔다.
//
// 흐름
//   1) 국가: fe.eet.kr 은 nginx(14.39)라 Vercel 국가 헤더가 없다. hill.pe.kr 의 /api/geo 를 부른다
//      (CORS 로 https://fe.eet.kr 만 허용, 응답 {country}). 실패·오류·3초 초과면 대상 국가로 친다(묻는 쪽이 안전하다).
//      🔴 hill 쪽 /api/geo 나 그 CORS 허용 목록을 바꾸면 이 사이트의 판별이 «전원 배너»로 떨어진다. 같이 본다.
//   2) 대상 국가가 아니면 → 곧바로 켠다.
//   3) 대상 국가면 → 동의 전에는 posthog.js 를 아예 부르지 않는다(요청 0건).
//      posthog.js 가 opt_out_capturing_by_default 로 시작해 동의 시 opt_in_capturing() 한다.
//   4) 선택은 localStorage(hill_consent)에 6개월 둔다. 각 페이지 하단 [data-consent-reopen] 자리의 「쿠키 설정」으로 바꾼다.
//
// 문구는 STRINGS 의 consent.* 키로 둔다. 페이지 언어(<html lang>)를 따르고 없는 언어는 영어다.
(function () {
    'use strict';

    var TAG = '[consent]';
    var GA_ID = ''; // fe.eet.kr 에는 GA4 없음
    var CLARITY_ID = ''; // fe.eet.kr 에는 Clarity 없음
    var GEO_URL = 'https://hill.pe.kr/api/geo'; // 응답 {country}. CORS 허용 출처 https://fe.eet.kr
    var STORE_KEY = 'hill_consent';
    var GEO_KEY = 'hill_geo';
    var MAX_AGE_MS = 183 * 24 * 60 * 60 * 1000; // 6개월
    var GEO_TIMEOUT_MS = 3000;

    // EU 27 + EEA(IS, LI, NO) + GB + CH
    var REGION = [
        'AT', 'BE', 'BG', 'HR', 'CY', 'CZ', 'DK', 'EE', 'FI', 'FR', 'DE', 'GR', 'HU', 'IE',
        'IT', 'LV', 'LT', 'LU', 'MT', 'NL', 'PL', 'PT', 'RO', 'SK', 'SI', 'ES', 'SE',
        'IS', 'LI', 'NO', 'GB', 'CH'
    ];

    // 🔴 아래 STRINGS 는 손으로 고치지 않는다. 문안 정본(38_multi_site_privacy.txt B-②)에서 스크립트로 떼어 붙인다.
    // @@STRINGS-START
    var STRINGS = {
        "ko": {
            "consent.title": "분석 쿠키",
            "consent.body": "허용하시면 서비스 개선을 위해 PostHog로 방문 기록을 모으고 화면 이용 과정을 녹화합니다(생년월일시 입력칸, 이용권, 계산 결과와 상담 대화는 가림). 사주 계산은 어느 쪽을 고르셔도 그대로 쓰실 수 있고, 선택은 페이지 아래 「쿠키 설정」에서 언제든 바꿀 수 있습니다.",
            "consent.accept": "모두 허용",
            "consent.reject": "모두 거부",
            "consent.policy": "개인정보처리방침",
            "consent.reopen": "쿠키 설정"
        },
        "en": {
            "consent.title": "Analytics cookies",
            "consent.body": "With your consent, we use PostHog to understand how the service is used and improve it, including recordings of how pages are used, with the birth date and time fields, passes, chart results and consultation messages masked. Chart calculation works the same whichever you choose, and you can change your choice at any time under “Cookie settings” at the bottom of the page.",
            "consent.accept": "Accept all",
            "consent.reject": "Reject all",
            "consent.policy": "Privacy policy",
            "consent.reopen": "Cookie settings"
        }
    };
    // @@STRINGS-END

    var script = document.currentScript;
    var tools = String((script && script.getAttribute('data-tools')) || '')
        .split(',').map(function (s) { return s.trim(); }).filter(Boolean);
    var has = function (name) { return tools.indexOf(name) !== -1; };

    var state = { required: null, choice: null, loaded: false };

    // ── 저장 ─────────────────────────────────────────────
    function readChoice() {
        try {
            var raw = localStorage.getItem(STORE_KEY);
            if (!raw) return null;
            var v = JSON.parse(raw);
            if (!v || (v.choice !== 'granted' && v.choice !== 'denied')) return null;
            if (!(Date.now() - v.at < MAX_AGE_MS)) { localStorage.removeItem(STORE_KEY); return null; }
            return v.choice;
        } catch (e) { return null; }
    }
    function writeChoice(choice) {
        try { localStorage.setItem(STORE_KEY, JSON.stringify({ choice: choice, at: Date.now() })); }
        catch (e) { console.warn(TAG, '선택을 저장하지 못했다', e); }
    }

    // ── 국가 ─────────────────────────────────────────────
    function getCountry() {
        try {
            var cached = sessionStorage.getItem(GEO_KEY);
            if (cached) return Promise.resolve(cached === '-' ? '' : cached);
        } catch (e) { /* 무시 */ }
        var timer;
        var timeout = new Promise(function (resolve) { timer = setTimeout(function () { resolve(''); }, GEO_TIMEOUT_MS); });
        var req = fetch(GEO_URL, { cache: 'no-store', mode: 'cors', credentials: 'omit' })
            .then(function (r) { return r.ok ? r.json() : {}; })
            .then(function (j) {
                var cc = (j && typeof j.country === 'string') ? j.country.toUpperCase() : '';
                // 판별에 성공했을 때만 캐시한다 — 실패는 다음 페이지에서 다시 묻는다.
                if (cc) { try { sessionStorage.setItem(GEO_KEY, cc); } catch (e) { /* 무시 */ } }
                return cc;
            })
            .catch(function (e) { console.warn(TAG, '국가 판별 실패', e); return ''; });
        return Promise.race([req, timeout]).then(function (cc) { clearTimeout(timer); return cc; });
    }

    // ── 도구 불러오기 ────────────────────────────────────
    function addScript(src, attrs) {
        var s = document.createElement('script');
        s.async = true;
        s.src = src;
        if (attrs) Object.keys(attrs).forEach(function (k) { s.setAttribute(k, attrs[k]); });
        (document.head || document.documentElement).appendChild(s);
    }

    if (has('ga')) {
        window.dataLayer = window.dataLayer || [];
        window.gtag = window.gtag || function () { window.dataLayer.push(arguments); };
    }
    if (has('clarity')) {
        window.clarity = window.clarity || function () { (window.clarity.q = window.clarity.q || []).push(arguments); };
    }

    function loadTools() {
        if (state.loaded) return;
        state.loaded = true;
        if (has('ga')) {
            window.gtag('js', new Date());
            window.gtag('config', GA_ID);
            addScript('https://www.googletagmanager.com/gtag/js?id=' + GA_ID);
        }
        if (has('clarity')) addScript('https://www.clarity.ms/tag/' + CLARITY_ID);
        if (has('posthog')) addScript('/posthog.js');
    }

    // ── 동의 신호 ────────────────────────────────────────
    function grant() {
        if (has('ga')) { window['ga-disable-' + GA_ID] = false; window.gtag('consent', 'update', { analytics_storage: 'granted' }); }
        loadTools();
        if (has('clarity')) window.clarity('consentv2', { ad_Storage: 'denied', analytics_Storage: 'granted' });
        // PostHog 는 불러올 때 posthog.js 의 loaded 콜백이 opt-in 한다. 이미 불러와 있으면 여기서 한다.
        if (has('posthog') && window.posthog && window.posthog.__loaded) optInPosthog(window.posthog);
    }
    function revoke() {
        if (!state.loaded) return; // 불러온 적이 없으면 보낼 것도 없다
        if (has('ga')) {
            window.gtag('consent', 'update', { analytics_storage: 'denied' });
            // denied 만으로는 쿠키 없는 신호가 계속 나간다 — GA 공식 끄개로 이 페이지의 전송을 멈춘다.
            window['ga-disable-' + GA_ID] = true;
        }
        if (has('clarity')) {
            window.clarity('consentv2', { ad_Storage: 'denied', analytics_Storage: 'denied' });
            window.clarity('consent', false); // 쿠키를 지우고 추적을 멈춘다
        }
        if (has('posthog') && window.posthog) {
            try { window.posthog.stopSessionRecording(); window.posthog.opt_out_capturing(); }
            catch (e) { console.warn(TAG, 'PostHog 거부 처리 실패', e); }
        }
    }
    function optInPosthog(ph) {
        try {
            if (!ph.has_opted_in_capturing()) ph.opt_in_capturing();
            ph.startSessionRecording();
        } catch (e) { console.warn(TAG, 'PostHog 동의 처리 실패', e); }
    }

    function choose(choice) {
        state.choice = choice;
        writeChoice(choice);
        hideBanner();
        if (choice === 'granted') grant(); else revoke();
    }

    // ── 배너 ─────────────────────────────────────────────
    function pageLang() {
        var lang = String(document.documentElement.lang || 'en').toLowerCase().split('-')[0];
        return STRINGS[lang] ? lang : 'en';
    }
    function t(key) {
        var lang = pageLang();
        return (STRINGS[lang] && STRINGS[lang][key]) || (STRINGS.en && STRINGS.en[key]) || key;
    }
    // 앱·법률 페이지의 언어 전환은 <html lang> 을 바꾼다 — 그때 배너와 링크 글자를 다시 그린다.
    function watchLang() {
        if (!window.MutationObserver) return;
        new MutationObserver(function () {
            if (document.getElementById('hill-consent')) showBanner();
            Array.prototype.forEach.call(document.querySelectorAll('.hill-consent-reopen'), function (b) {
                b.textContent = t('consent.reopen');
            });
        }).observe(document.documentElement, { attributes: true, attributeFilter: ['lang'] });
    }

    var CSS =
        '#hill-consent{position:fixed;left:0;right:0;bottom:0;z-index:2147483000;' +
        'background:rgba(15,23,42,.97);color:#e2e8f0;border-top:1px solid rgba(148,163,184,.35);' +
        'box-shadow:0 -6px 24px rgba(0,0,0,.35);font:14px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif;}' +
        '#hill-consent .hc-in{max-width:1080px;margin:0 auto;padding:12px 16px;display:flex;gap:16px;align-items:center;flex-wrap:wrap;}' +
        '#hill-consent .hc-txt{flex:1 1 420px;min-width:0;}' +
        '#hill-consent .hc-txt strong{display:block;margin-bottom:2px;color:#fff;}' +
        '#hill-consent .hc-txt p{margin:0;}' +
        '#hill-consent a{color:#93c5fd;text-decoration:underline;}' +
        '#hill-consent .hc-btns{display:flex;gap:8px;flex:0 0 auto;}' +
        '#hill-consent button{min-width:120px;padding:9px 16px;border-radius:8px;font:600 14px/1.2 inherit;cursor:pointer;' +
        'border:1px solid #cbd5e1;background:#f8fafc;color:#0f172a;}' +
        '#hill-consent button:focus-visible{outline:3px solid #60a5fa;outline-offset:2px;}' +
        '@media (max-width:560px){#hill-consent .hc-btns{width:100%;}#hill-consent button{flex:1;}}' +
        '.hill-consent-reopen{cursor:pointer;}';

    function ensureCss() {
        if (document.getElementById('hill-consent-css')) return;
        var st = document.createElement('style');
        st.id = 'hill-consent-css';
        st.textContent = CSS;
        document.head.appendChild(st);
    }

    function showBanner() {
        ensureCss();
        var old = document.getElementById('hill-consent');
        if (old) old.remove();

        var box = document.createElement('div');
        box.id = 'hill-consent';
        box.setAttribute('role', 'dialog');
        box.setAttribute('aria-live', 'polite');
        box.setAttribute('aria-labelledby', 'hill-consent-title');
        box.setAttribute('lang', pageLang());
        box.setAttribute('dir', pageLang() === 'fa' ? 'rtl' : 'ltr');

        var inner = document.createElement('div'); inner.className = 'hc-in';
        var txt = document.createElement('div'); txt.className = 'hc-txt';
        var title = document.createElement('strong'); title.id = 'hill-consent-title'; title.textContent = t('consent.title');
        var body = document.createElement('p'); body.textContent = t('consent.body') + ' ';
        var link = document.createElement('a'); link.href = '/privacy.html'; link.textContent = t('consent.policy');
        body.appendChild(link);
        txt.appendChild(title); txt.appendChild(body);

        // 두 버튼은 같은 모양·같은 무게로 둔다.
        var btns = document.createElement('div'); btns.className = 'hc-btns';
        var reject = document.createElement('button'); reject.type = 'button'; reject.setAttribute('data-consent', 'reject');
        reject.textContent = t('consent.reject');
        reject.addEventListener('click', function () { choose('denied'); });
        var accept = document.createElement('button'); accept.type = 'button'; accept.setAttribute('data-consent', 'accept');
        accept.textContent = t('consent.accept');
        accept.addEventListener('click', function () { choose('granted'); });
        btns.appendChild(reject); btns.appendChild(accept);

        inner.appendChild(txt); inner.appendChild(btns);
        box.appendChild(inner);
        document.body.appendChild(box);
    }
    function hideBanner() {
        var el = document.getElementById('hill-consent');
        if (el) el.remove();
    }

    // 하단 다시 열기 링크 — 페이지의 [data-consent-reopen] 자리에 넣는다. 대상 국가에서만 보인다.
    function mountReopen() {
        ensureCss();
        var slots = document.querySelectorAll('[data-consent-reopen]');
        Array.prototype.forEach.call(slots, function (slot) {
            if (slot.querySelector('.hill-consent-reopen')) return;
            // 링크 모양은 페이지의 a 스타일을 그대로 따르게 a 로 만든다(앱 하단 막대에선 status-link).
            var b = document.createElement('a');
            b.href = '#';
            b.setAttribute('role', 'button');
            b.className = 'hill-consent-reopen status-link'; // status-link 는 앱 하단 막대의 링크 모양(법률 페이지엔 없음)
            b.textContent = t('consent.reopen');
            b.addEventListener('click', function (e) { e.preventDefault(); showBanner(); });
            slot.appendChild(b);
            slot.hidden = false;
            slot.style.display = 'contents'; // 앱 하단 막대(flex)에 링크처럼 줄 서게
        });
    }

    function whenBody(fn) {
        if (document.body && document.readyState !== 'loading') fn();
        else document.addEventListener('DOMContentLoaded', fn);
    }

    // ── 시작 ─────────────────────────────────────────────
    window.hillConsent = {
        isRequired: function () { return state.required === true; },
        isGranted: function () { return state.choice === 'granted'; },
        onPosthogLoaded: function (ph) { if (state.required && state.choice === 'granted') optInPosthog(ph); },
        open: function () { whenBody(showBanner); }
    };

    getCountry().then(function (cc) {
        state.required = !cc || REGION.indexOf(cc) !== -1;
        if (!state.required) { loadTools(); return; } // 대상 국가가 아니면 지금까지와 같다

        if (has('ga')) {
            window.gtag('consent', 'default', {
                ad_storage: 'denied', ad_user_data: 'denied', ad_personalization: 'denied', analytics_storage: 'denied'
            });
        }
        state.choice = readChoice();
        if (state.choice === 'granted') grant();
        whenBody(function () {
            watchLang();
            mountReopen();
            if (!state.choice) showBanner();
        });
    });
})();

import { initializeApp } from "https://www.gstatic.com/firebasejs/12.14.0/firebase-app.js";
import { getDatabase, ref, child, set, update, increment, remove, onValue, push, onDisconnect } from "https://www.gstatic.com/firebasejs/12.14.0/firebase-database.js";

import { menu } from "./menu.js";

const firebaseConfig = {
    apiKey: "AIzaSyDVgtCsFzrPOqRWBqoncZrsZsRdCn7wTWo",
    authDomain: "combetram.firebaseapp.com",
    databaseURL: "https://combetram-default-rtdb.asia-southeast1.firebasedatabase.app",
    projectId: "combetram",
    storageBucket: "combetram.firebasestorage.app",
    messagingSenderId: "727819537743",
    appId: "1:727819537743:web:36078910a5b351866f893a"
};

const app = initializeApp(firebaseConfig);
const database = getDatabase(app);
const dbRef = ref(database, 'phobup_v1_data');

// Kích thước từng ô bàn: 1-5 nhỏ, 6-8 ngang (large), 9-10 dọc (vertical)
const TABLE_SIZE_CLASS = { 1: 'small', 2: 'small', 3: 'small', 4: 'small', 5: 'small', 6: 'large', 7: 'large', 8: 'large', 9: 'vertical', 10: 'vertical' };

let currentBillLang = 'vi';
let currentTab = null;
let data = { orders: {}, locked: {}, times: {} };
let firstLoad = true;
let billWasShown = false;

// ─── FIX #2: Menu lookup Map O(1) thay vì find() O(n) trong mỗi vòng lặp ───
const ALL_ITEMS = menu.flatMap(g => g.items);
const ITEM_MAP = new Map(ALL_ITEMS.map(i => [i.id, i]));

// ─── FIX #9: Lazy-load dict theo ngôn ngữ ───
let dictCache = { vi: { flag: "🇻🇳", total: "TỔNG", items: {} } };
let dictLoadPromise = null;

async function getLangData(lang) {
    if (dictCache[lang]) return dictCache[lang];
    if (!dictLoadPromise) {
        dictLoadPromise = import('./dict.js').then(m => {
            dictCache = m.dict;
        }).catch(() => {});
    }
    await dictLoadPromise;
    return dictCache[lang] || dictCache['vi'];
}

// CACHE THỜI TIẾT
let weatherCache = { status: 'cloudy', temp: 31, windSpeed: 14.0, windDir: 135 };

const SVG_ICONS = {
    sunny:              '<span class="w-icon"><span class="wi-spin">☀️</span></span>',
    partlyCloudy:       '<span class="w-icon"><span class="wi-sway">⛅</span></span>',
    cloudy:             '<span class="w-icon"><span class="wi-sway">☁️</span></span>',
    rainy:              '<span class="w-icon"><span class="wi-drop">🌧️</span></span>',
    storm:              '<span class="w-icon"><span class="wi-flash">⛈️</span></span>',
    night_fullmoon:     '<span class="w-icon"><span class="wi-pulse">🌕</span></span>',
    night_crescent:     '<span class="w-icon"><span class="wi-pulse">🌙</span></span>',
    night_nomoon:       '<span class="w-icon"><span class="wi-pulse">🌑</span></span>',
    night_partlyCloudy: '<span class="w-icon"><span class="wi-sway">🌤️</span></span>',
    windNone:           '<span class="w-icon">〰️</span>',
    windSlow:           '<span class="w-icon"><span class="wi-blow">💨</span></span>',
    windFast:           '<span class="w-icon"><span class="wi-blow2">💨</span></span>',
    windStorm:          '<span class="w-icon"><span class="wi-blow3">🌀</span></span>',
};

function renderWeather(status, temp, windSpeed, windDir) {
    let finalStatus = status;
    const hour = new Date().getHours();
    if (hour >= 18 || hour < 6) {
        const dayOfMonth = new Date().getDate();
        let moonType;
        if (dayOfMonth % 3 === 0) moonType = 'night_fullmoon';
        else if (dayOfMonth % 3 === 1) moonType = 'night_crescent';
        else moonType = 'night_nomoon';
        if (status === 'sunny') finalStatus = moonType;
        else if (status === 'partlyCloudy') finalStatus = 'night_partlyCloudy';
    }
    document.getElementById('w-icon-container').innerHTML = SVG_ICONS[finalStatus] || SVG_ICONS.sunny;
    document.getElementById('w-temp').innerText = `${temp.toFixed(1)}°C`;
    const hub = document.getElementById('weather-hub');
    let windIcon = SVG_ICONS.windNone;
    hub.className = '';
    if (windSpeed > 5 && windSpeed <= 19) { windIcon = SVG_ICONS.windSlow; }
    else if (windSpeed >= 20 && windSpeed <= 39) { windIcon = SVG_ICONS.windFast; hub.classList.add('wind-warning'); }
    else if (windSpeed >= 40) { windIcon = SVG_ICONS.windStorm; hub.classList.add('wind-danger'); }
    document.getElementById('w-wind-icon-container').innerHTML = windIcon;
    document.getElementById('w-wind-speed').innerText = `${windSpeed.toFixed(1)} km/h`;
    document.getElementById('w-arrow').style.transform = `rotate(${windDir}deg)`;
}

async function fetchRealtimeWeather() {
    try {
        const lat = 16.0544, lon = 108.2022;
        const response = await fetch(`https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current=temperature_2m,weather_code,wind_speed_10m,wind_direction_10m`);
        if (!response.ok) return;
        const resData = await response.json();
        const current = resData.current;
        let status = 'sunny';
        const code = current.weather_code;
        if (code === 0) status = 'sunny';
        else if (code === 1 || code === 2) status = 'partlyCloudy';
        else if (code === 3 || code === 45 || code === 48) status = 'cloudy';
        else if ((code >= 51 && code <= 67) || (code >= 80 && code <= 82)) status = 'rainy';
        else if ((code >= 71 && code <= 77) || code === 85 || code === 86) status = 'cloudy';
        else if (code >= 95) status = 'storm';
        weatherCache = { status, temp: current.temperature_2m, windSpeed: current.wind_speed_10m, windDir: current.wind_direction_10m };
        renderWeather(weatherCache.status, weatherCache.temp, weatherCache.windSpeed, weatherCache.windDir);
    } catch (err) {
        console.error("Lỗi gọi API thời tiết:", err);
        renderWeather(weatherCache.status, weatherCache.temp, weatherCache.windSpeed, weatherCache.windDir);
    }
}

function simulateWeatherFluctuation() {
    const tempOffset = (Math.random() - 0.5) * 0.4;
    const windSpeedOffset = (Math.random() - 0.5) * 0.6;
    const windDirOffset = Math.floor((Math.random() - 0.5) * 4);
    renderWeather(weatherCache.status, Math.max(10, Math.min(45, weatherCache.temp + tempOffset)), Math.max(0, Math.min(120, weatherCache.windSpeed + windSpeedOffset)), (weatherCache.windDir + windDirOffset + 360) % 360);
}

fetchRealtimeWeather();
setInterval(fetchRealtimeWeather, 600000);
setInterval(simulateWeatherFluctuation, 5000);



// ─── FIX #4: Ticker noise — dừng khi tab bị ẩn ───
let tickerIntervalId = null;
function startTickerInterval() {
    if (tickerIntervalId) return;
    tickerIntervalId = setInterval(() => {
        if (realGoldPrice !== null) {
            const noise = (Math.random() - 0.5) * 3;
            const newVal = realGoldPrice + noise;
            renderTicker('gold-ticker', newVal, displayedGoldPrice, 1);
            displayedGoldPrice = newVal;
        }
        if (realOilPrice !== null) {
            const noise = (Math.random() - 0.5) * 0.3;
            const newVal = realOilPrice + noise;
            renderTicker('oil-ticker', newVal, displayedOilPrice, 2);
            displayedOilPrice = newVal;
        }
    }, 800);
}
function stopTickerInterval() {
    clearInterval(tickerIntervalId);
    tickerIntervalId = null;
}
document.addEventListener('visibilitychange', () => {
    document.hidden ? stopTickerInterval() : startTickerInterval();
});
startTickerInterval();

// ĐỒNG HỒ LẬT
function updateCardValue(cardId, targetVal) {
    const card = document.getElementById(cardId);
    if (!card) return;
    const topHalf = card.querySelector('.card-top');
    const bottomHalf = card.querySelector('.card-bottom');
    const wing = card.querySelector('.card-flip-wing');
    const wingBack = card.querySelector('.card-flip-wing-back');
    if (topHalf.innerText === targetVal) return;
    wing.innerText = topHalf.innerText;
    wingBack.innerText = targetVal;
    card.classList.add('animate');
    setTimeout(() => { topHalf.innerText = targetVal; }, 160);
    setTimeout(() => { bottomHalf.innerText = targetVal; wing.innerText = targetVal; card.classList.remove('animate'); }, 340);
}

function runClock() {
    const d = new Date();
    const hStr = String(d.getHours()).padStart(2, '0');
    const mStr = String(d.getMinutes()).padStart(2, '0');
    const sStr = String(d.getSeconds()).padStart(2, '0');
    updateCardValue('c-h1', hStr[0]); updateCardValue('c-h2', hStr[1]);
    updateCardValue('c-m1', mStr[0]); updateCardValue('c-m2', mStr[1]);
    updateCardValue('c-s1', sStr[0]); updateCardValue('c-s2', sStr[1]);
}

const currentInit = new Date();
const ih = String(currentInit.getHours()).padStart(2, '0'), im = String(currentInit.getMinutes()).padStart(2, '0'), is = String(currentInit.getSeconds()).padStart(2, '0');
['h1','h2','m1','m2','s1','s2'].forEach((k, idx) => {
    let v = (idx < 2) ? ih[idx] : (idx < 4 ? im[idx-2] : is[idx-4]);
    const c = document.getElementById('c-' + k);
    if(c) c.querySelectorAll('.card-half, .card-flip-wing, .card-flip-wing-back').forEach(el => el.innerText = v);
});
setInterval(runClock, 1000);

// HAPTIC
function triggerHaptic(type) {
    if (window.navigator && window.navigator.vibrate) window.navigator.vibrate([18, 25, 18]);
}

// ─── FIX #5: animateNumber với cancel flag để tránh race condition ───
const animatingFlags = {};
function animateNumber(elementId, newValue) {
    const el = document.getElementById(elementId);
    if (!el) return;
    const startValue = parseInt(el.innerText.replace(/\D/g, '')) || 0;
    if (startValue === newValue) return;
    const diff = newValue - startValue;
    const duration = 750, startTime = performance.now();
    const token = Symbol();
    animatingFlags[elementId] = token;

    function easeCountMoney(t) {
        if (t < 0.7) { const p = t / 0.7; return (1 - Math.pow(1 - p, 3)) * 0.92; }
        const p = (t - 0.7) / 0.3;
        return 0.92 + (1 - Math.pow(1 - p, 2)) * 0.08;
    }
    function update(currentTime) {
        if (animatingFlags[elementId] !== token) return; // bị cancel
        const elapsed = currentTime - startTime;
        const progress = Math.min(elapsed / duration, 1);
        const eased = easeCountMoney(progress);
        let val = startValue + diff * eased;
        if (progress > 0.85) { const step = 1000; val = Math.round(val / step) * step; }
        val = Math.round(val);
        val = diff >= 0 ? Math.min(val, newValue) : Math.max(val, newValue);
        el.innerText = val.toLocaleString();
        if (progress < 1) requestAnimationFrame(update);
        else { el.innerText = newValue.toLocaleString(); delete animatingFlags[elementId]; }
    }
    requestAnimationFrame(update);
}

// PRESENCE
// ─── FIX #12: Tách presence/cursors/focus ra khỏi cây combetram_v6_data ───
// Trước đây 3 node này nằm chung cây với orders/locked/times, nên onValue(dbRef)
// (listener đơn hàng) bị refire MỖI LẦN có người di chuột (broadcast cursor 200ms/lần),
// kéo theo JSON.stringify(orders) deep-compare + refresh() toàn bộ dù đơn hàng không đổi.
// Giải pháp: đặt presence/cursors/focus ở path riêng (combetram_v6_rt), tách biệt hoàn toàn
// khỏi path dữ liệu đơn hàng (combetram_v6_data) — listener đơn hàng giờ chỉ fire khi
// orders/locked/times thật sự thay đổi.
const RT_ROOT = 'phobup_v1_rt';
const USER_COLORS = ['#e53935', '#1e88e5', '#43a047', '#fb8c00', '#8e24aa', '#00acc1', '#d81b60', '#6d4c41', '#3949ab', '#c0ca33'];
const myColor = USER_COLORS[Math.floor(Math.random() * USER_COLORS.length)];
const onlineRef = ref(database, '.info/connected');
const presenceListRef = ref(database, `${RT_ROOT}/presence`);
const myPresenceRef = push(presenceListRef);
const myPresenceId = myPresenceRef.key;
const cursorsRef = ref(database, `${RT_ROOT}/cursors`);
const myCursorRef = child(cursorsRef, myPresenceId);
const focusRef = ref(database, `${RT_ROOT}/focus`);
const myFocusRef = child(focusRef, myPresenceId);

// ─── FIX #12: Listener riêng cho số người online, không còn ăn ké listener đơn hàng ───
onValue(presenceListRef, (snap) => {
    const presenceCount = Object.keys(snap.val() || {}).length;
    const el = document.getElementById('online-val');
    if (el) el.innerText = presenceCount || 1;
});

onValue(onlineRef, (snap) => {
    if (snap.val() === true) {
        onDisconnect(myPresenceRef).remove();
        onDisconnect(myCursorRef).remove();
        onDisconnect(myFocusRef).remove();
        set(myPresenceRef, { color: myColor, ts: Date.now() })
            .then(() => console.log('[presence] ghi presence thành công'))
            .catch(e => console.error('[presence] LỖI GHI PRESENCE:', e.message));
        console.log('[presence] đã kết nối, id =', myPresenceId, 'color =', myColor);
    } else {
        console.log('[presence] mất kết nối tới Firebase');
    }
});

// ─── FIX #10: Object pool cho cursor trail ───
const TRAIL_POOL_SIZE = 20;
const trailPool = [];
for (let i = 0; i < TRAIL_POOL_SIZE; i++) {
    const el = document.createElement('div');
    el.className = 'cursor-trail';
    el.style.display = 'none';
    document.body.appendChild(el);
    trailPool.push(el);
}
let trailPoolIdx = 0;

function spawnTrail(x, y, color) {
    const trail = trailPool[trailPoolIdx % TRAIL_POOL_SIZE];
    trailPoolIdx++;
    trail.style.left = x + 'px';
    trail.style.top = y + 'px';
    trail.style.background = color || '#999';
    trail.style.display = '';
    trail.style.animation = 'none';
    void trail.offsetWidth; // reflow để restart animation
    trail.style.animation = '';
    setTimeout(() => { trail.style.display = 'none'; }, 500);
}

// CURSOR ĐỒNG NGHIỆP
const remoteCursorEls = {};
const lastCursorPos = {};

function positionCursorOnTable(id, el, tableNum, offsetIndex, color) {
    const card = document.getElementById('tab-' + tableNum);
    if (!card) { el.classList.remove('visible'); return; }
    const rect = card.getBoundingClientRect();
    const x = rect.left + 12 + (offsetIndex * 16);
    const y = rect.top + 12;
    const prev = lastCursorPos[id];
    if (prev && (Math.abs(prev.x - x) > 6 || Math.abs(prev.y - y) > 6)) {
        const steps = 4;
        for (let s = 1; s <= steps; s++) {
            const t = s / (steps + 1);
            setTimeout(() => spawnTrail(prev.x + (x - prev.x) * t, prev.y + (y - prev.y) * t, color), s * 28);
        }
    }
    lastCursorPos[id] = { x, y };
    el.style.left = x + 'px'; el.style.top = y + 'px';
    el.classList.add('visible');
}

function renderRemoteCursors(snapVal) {
    const entries = Object.entries(snapVal || {}).filter(([id, c]) => id !== myPresenceId && c && c.table);
    Object.keys(remoteCursorEls).forEach(id => {
        if (!entries.find(([eid]) => eid === id)) { remoteCursorEls[id].remove(); delete remoteCursorEls[id]; delete lastCursorPos[id]; }
    });
    const countPerTable = {}, tableViewerColor = {};
    entries.forEach(([id, c]) => {
        const idx = countPerTable[c.table] || 0;
        countPerTable[c.table] = idx + 1;
        if (!tableViewerColor[c.table]) tableViewerColor[c.table] = c.color || '#999';
        let el = remoteCursorEls[id];
        if (!el) { el = document.createElement('div'); el.className = 'remote-cursor'; document.body.appendChild(el); remoteCursorEls[id] = el; }
        el.style.background = c.color || '#999';
        positionCursorOnTable(id, el, c.table, idx, c.color);
    });
    for (let t = 1; t <= 10; t++) {
        const card = document.getElementById('tab-' + t);
        if (!card) continue;
        if (tableViewerColor[t]) { card.classList.add('has-viewer'); card.style.setProperty('--viewer-color', tableViewerColor[t]); }
        else { card.classList.remove('has-viewer'); card.style.removeProperty('--viewer-color'); }
    }
}

let lastCursorSnap = null;
onValue(cursorsRef, (snap) => { lastCursorSnap = snap.val(); renderRemoteCursors(lastCursorSnap); });

let cursorRenderTicking = false;
function scheduleRenderRemoteCursors() {
    if (cursorRenderTicking) return;
    cursorRenderTicking = true;
    requestAnimationFrame(() => { renderRemoteCursors(lastCursorSnap); cursorRenderTicking = false; });
}
window.addEventListener('resize', scheduleRenderRemoteCursors);
window.addEventListener('scroll', scheduleRenderRemoteCursors, { passive: true });

// ─── FIX #7: Throttle cursor broadcast 200ms ───
let lastCursorBroadcastTs = 0;
function broadcastCursor(tableNum) {
    const now = Date.now();
    if (tableNum && now - lastCursorBroadcastTs < 200) return;
    lastCursorBroadcastTs = now;
    if (tableNum) set(myCursorRef, { table: tableNum, color: myColor, ts: now });
    else remove(myCursorRef);
    broadcastFocus(null);
}

// CLICK-TO-FOCUS
let lastFocusBroadcast = 0, focusClearTimer = null;
function broadcastFocus(itemId) {
    if (itemId === null) { clearTimeout(focusClearTimer); remove(myFocusRef); return; }
    const now = Date.now();
    if (now - lastFocusBroadcast > 120) { lastFocusBroadcast = now; set(myFocusRef, { table: currentTab, itemId, color: myColor, ts: now }); }
    clearTimeout(focusClearTimer);
    focusClearTimer = setTimeout(() => remove(myFocusRef), 1500);
}

const remoteFocusRows = {};
function renderRemoteFocus(snapVal) {
    const entries = Object.entries(snapVal || {}).filter(([id, f]) => id !== myPresenceId && f);
    Object.keys(remoteFocusRows).forEach(id => {
        const stillActive = entries.find(([eid, f]) => eid === id && f.table === currentTab);
        if (!stillActive) {
            const prev = remoteFocusRows[id];
            if (prev.rowEl) { prev.rowEl.classList.remove('remote-focus'); prev.rowEl.style.removeProperty('--focus-color'); }
            if (prev.tagEl) prev.tagEl.remove();
            delete remoteFocusRows[id];
        }
    });
    if (!currentTab) return;
    entries.forEach(([id, f]) => {
        if (f.table !== currentTab) return;
        const row = document.getElementById('row-' + f.itemId);
        if (!row) return;
        const prev = remoteFocusRows[id];
        if (prev && prev.rowEl && prev.rowEl !== row) { prev.rowEl.classList.remove('remote-focus'); prev.rowEl.style.removeProperty('--focus-color'); if (prev.tagEl) prev.tagEl.remove(); }
        row.classList.add('remote-focus');
        row.style.setProperty('--focus-color', f.color || '#999');
        let tag = (prev && prev.rowEl === row) ? prev.tagEl : null;
        if (!tag) { tag = document.createElement('span'); tag.className = 'remote-focus-tag'; tag.innerText = '✏️'; row.appendChild(tag); requestAnimationFrame(() => tag.classList.add('visible')); }
        tag.style.background = f.color || '#999';
        remoteFocusRows[id] = { rowEl: row, tagEl: tag };
    });
}

let lastFocusSnap = null;
onValue(focusRef, (snap) => { lastFocusSnap = snap.val(); renderRemoteFocus(lastFocusSnap); });

// MENU — FIX #6: dùng array join thay concatenation
function renderMenu() {
    const parts = [];
    menu.forEach(g => {
        parts.push(`<div class="category-title">${g.cat}</div>`);
        g.items.forEach(i => {
            parts.push(`<div class="menu-item" id="row-${i.id}">
                <div class="item-info"><b>${i.name}</b><small>${i.price.toLocaleString()}đ</small></div>
                <div class="controls">
                    <button class="btn-qty btn-sub" data-item-id="${i.id}">-</button>
                    <span class="qty-num" id="q-${i.id}">0</span>
                    <button class="btn-qty btn-add" data-item-id="${i.id}">+</button>
                </div>
            </div>`);
        });
    });
    document.getElementById('menu-list').innerHTML = parts.join('');
}
renderMenu();

document.getElementById('menu-list').addEventListener('click', (e) => {
    const btn = e.target.closest('.btn-qty'); if (!btn) return;
    const itemId = parseInt(btn.dataset.itemId);
    change(itemId, btn.classList.contains('btn-add') ? 1 : -1);
});

// ─── FIX #12: dbRef giờ chỉ chứa orders/locked/times — không còn bị presence/cursor "ăn ké" ───
onValue(dbRef, snap => {
    const val = snap.val();
    if (val) {
        if (!firstLoad && JSON.stringify(val.orders) !== JSON.stringify(data.orders)) document.getElementById('tingSound').play().catch(() => {});
        data = val; if (!data.orders) data.orders = {}; if (!data.times) data.times = {};
        refresh(); firstLoad = false;
    }
});

function selectTable(n) {
    triggerHaptic('nav');
    const wasOpenForSameTable = (currentTab === n);
    currentTab = wasOpenForSameTable ? null : n; currentBillLang = 'vi';
    billWasShown = false;
    broadcastCursor(currentTab);
    renderRemoteFocus(lastFocusSnap);
    const section = document.getElementById('order-section');
    if (currentTab) {
        let title = "BÀN " + n;
        document.getElementById('table-title').innerText = title;
        section.style.display = 'block';
        requestAnimationFrame(() => requestAnimationFrame(() => section.classList.add('section-visible')));
        refresh();
        const isLockedTable = (data.locked && data.locked[n]) || false;
        if (isLockedTable) setTimeout(() => { document.querySelector('.bill-box')?.scrollIntoView({ behavior: 'smooth', block: 'start' }); }, 350);
    } else {
        section.classList.remove('section-visible');
        document.getElementById('scroll-to-checkout')?.classList.add('hidden');
        setTimeout(() => { if (!currentTab) section.style.display = 'none'; }, 320);
        refresh();
    }
}

// ─── FIX #1: Debounce Firebase write 250ms ───
const pendingUpdates = {};
const debounceTimers = {};

function change(id, delta) {
    if (!currentTab || (data.locked && data.locked[currentTab])) return;
    triggerHaptic(delta > 0 ? 'add' : 'sub');
    broadcastFocus(id);

    const order = data.orders[currentTab] || {};
    const currentQty = (pendingUpdates[currentTab]?.[id] ?? order[id]) || 0;
    if (delta < 0 && currentQty <= 0) return;

    // Cập nhật UI ngay lập tức (optimistic update)
    const newQty = Math.max(0, currentQty + delta);
    if (!pendingUpdates[currentTab]) pendingUpdates[currentTab] = {};
    pendingUpdates[currentTab][id] = newQty;

    const qSpan = document.getElementById(`q-${id}`);
    const row = document.getElementById(`row-${id}`);
    if (qSpan) {
        qSpan.innerText = newQty;
        row.className = 'menu-item';
        if (newQty >= 5) row.classList.add('qty-5'); else if (newQty > 0) row.classList.add('qty-' + newQty);
        qSpan.classList.remove('bump');
        requestAnimationFrame(() => qSpan.classList.add('bump'));
    }
    flashRow(id, delta);

    // Debounce ghi Firebase
    const key = `${currentTab}_${id}`;
    clearTimeout(debounceTimers[key]);
    debounceTimers[key] = setTimeout(() => {
        const tab = currentTab;
        const finalQty = pendingUpdates[tab]?.[id];
        if (finalQty === undefined) return;
        if (Object.keys(data.orders[tab] || {}).length === 0 && delta > 0) {
            set(child(dbRef, `times/${tab}`), Date.now());
        }
        update(child(dbRef, `orders/${tab}`), { [id]: finalQty });
        delete pendingUpdates[tab][id];
    }, 250);
}

function flashRow(id, delta) {
    const row = document.getElementById(`row-${id}`), tabBtn = document.getElementById(`tab-${currentTab}`), qSpan = document.getElementById(`q-${id}`), cls = delta > 0 ? 'flash-add' : 'flash-sub';
    if (row) row.classList.add(cls); if (tabBtn) tabBtn.classList.add(cls);
    setTimeout(() => { if (row) row.classList.remove(cls); if (tabBtn) tabBtn.classList.remove(cls); }, 400);
}

function changeBillLang(l) { triggerHaptic('nav'); currentBillLang = l; refresh(); document.querySelector('.bill-box')?.scrollIntoView({ behavior: 'smooth', block: 'start' }); }

// ─── FIX #3: Bỏ setInterval(refresh, 30000) — Firebase onValue() đã đủ ───
// ─── FIX #2: Dùng ITEM_MAP O(1) thay vì all.find() O(n) ───
function refresh() {
    let anyGuest = false; const now = Date.now();
    let activeTablesCount = 0;

    if (currentTab) {
        const isLock = (data.locked && data.locked[currentTab]) || false;
        document.getElementById('menu-area').style.display = isLock ? 'none' : 'block';
        const billArea = document.getElementById('bill-area');
        billArea.style.display = isLock ? 'block' : 'none';
        if (isLock && !billWasShown) {
            billArea.classList.remove('printing-out');
            requestAnimationFrame(() => requestAnimationFrame(() => billArea.classList.add('printing-out')));
            billWasShown = true;
        } else if (!isLock) { billWasShown = false; billArea.classList.remove('printing-out'); }
        const scrollBtn = document.getElementById('scroll-to-checkout');
        if (scrollBtn) scrollBtn.classList.toggle('hidden', isLock);

        ALL_ITEMS.forEach(i => {
            const q = Math.max(0, (data.orders[currentTab] && data.orders[currentTab][i.id]) || 0);
            const row = document.getElementById(`row-${i.id}`), qSpan = document.getElementById(`q-${i.id}`);
            if (row && qSpan && qSpan.innerText !== String(q)) {
                qSpan.innerText = q; row.className = 'menu-item';
                if (q >= 5) row.classList.add('qty-5'); else if (q > 0) row.classList.add('qty-' + q);
                qSpan.classList.remove('bump'); requestAnimationFrame(() => qSpan.classList.add('bump'));
            }
        });

        if (isLock) {
            renderBillAsync(currentTab);
        }
    }

    for (let i = 1; i <= 10; i++) {
        let s = 0, o = data.orders[i] || {};
        // ─── FIX #2: dùng ITEM_MAP thay vì find() ───
        for (let id in o) {
            const itm = ITEM_MAP.get(Number(id)); // FIX #11: === thay == qua Number()
            if (itm && o[id] > 0) s += itm.price * o[id];
        }
        const sTabLocked = (data.locked && data.locked[i]) || false;
        if (s > 0 || sTabLocked) { anyGuest = true; activeTablesCount++; }
        const sumEl = document.getElementById(`sum-${i}`);
        if (sumEl) { sumEl.classList.remove('skeleton'); if (parseInt(sumEl.innerText.replace(/\D/g, '')) !== s) animateNumber(`sum-${i}`, s); }
        const timeSpan = document.getElementById(`time-${i}`);
        if (timeSpan) {
            timeSpan.classList.remove('skeleton');
            let txt = ""; if (s > 0 && data.times && data.times[i]) { const diff = Math.floor((now - data.times[i]) / 60000); txt = diff > 0 ? "⏱ " + diff + " phút" : "⏱ Mới vào"; }
            if (timeSpan.innerText !== txt) timeSpan.innerText = txt;
        }
const btn = document.getElementById(`tab-${i}`);
if (btn) {
    // FIX: giữ lại class kích thước (small/large/vertical) — trước đây bị ghi đè
    // mất mỗi lần refresh() chạy (VD: mỗi lần bấm chọn bàn), khiến toàn bộ ô bàn
    // co lại về kích thước mặc định trông như "co cụm".
    const sizeClass = TABLE_SIZE_CLASS[i] || '';
    let targetClassName = "table-card" + (sizeClass ? " " + sizeClass : "");

    if (i === currentTab)
        targetClassName += " active";

    if (sTabLocked)
        targetClassName += " is-locked";
    else if (s > 0)
        targetClassName += " has-guest";

    if (btn.classList.contains('has-viewer'))
        targetClassName += " has-viewer";

    if (btn.className !== targetClassName)
        btn.className = targetClassName;
}
    }

    const crowdEl = document.getElementById('crowd-status');
    const crowdTxt = document.getElementById('crowd-text');
    const crowdIcon = document.getElementById('crowd-icon');
    if (crowdEl && crowdTxt && crowdIcon) {
        if (activeTablesCount <= 3) { crowdEl.className = 'status-badge status-empty'; crowdTxt.innerText = 'Vắng khách'; crowdIcon.innerText = '🟢'; }
        else if (activeTablesCount <= 6) { crowdEl.className = 'status-badge status-normal'; crowdTxt.innerText = 'Bình thường'; crowdIcon.innerText = '🟡'; }
        else { crowdEl.className = 'status-badge status-crowded'; crowdTxt.innerText = 'ĐÔNG KHÁCH'; crowdIcon.innerText = '🚨'; }
    }

    document.getElementById('reset-area').style.display = anyGuest ? 'none' : 'block';
}

// ─── FIX #9: Async bill render với lazy-load dict ───
async function renderBillAsync(tab) {
    const langData = await getLangData(currentBillLang);
    // Kiểm tra tab vẫn còn active sau khi await
    if (currentTab !== tab) return;

    let h = "", t = 0, my = data.orders[tab] || {};
    document.getElementById('txt-total-label').innerText = langData.total;
    document.getElementById('txt-lang-flag').innerText = langData.flag;
    let idx = 0;
    for (let id in my) {
        const itm = ITEM_MAP.get(Number(id)); // FIX #11
        if (itm && my[id] > 0) {
            let p = itm.price * my[id]; t += p;
            let nameShow = (currentBillLang !== 'vi' && langData.items && langData.items[itm.name]) ? langData.items[itm.name] : itm.name;
            h += `<div class="bill-row" style="animation-delay: ${idx * 0.08}s">
                    <span class="item-name">${nameShow}</span>
                    <span class="item-qty">x${my[id]}</span>
                    <div class="divider"></div>
                    <span class="item-price">${p.toLocaleString()}đ</span>
                  </div>`; idx++;
        }
    }
    document.getElementById('bill-list').innerHTML = h || "Trống";
    const bTotal = document.getElementById('bill-total'), tBox = document.getElementById('total-container');
    if (parseInt(bTotal.innerText.replace(/\D/g, '')) !== t) { animateNumber('bill-total', t); tBox.classList.add('total-pop'); setTimeout(() => tBox.classList.remove('total-pop'), 400); }
}

function setLock(v) {
    triggerHaptic(v ? 'lock' : 'nav');
    set(child(dbRef, `locked/${currentTab}`), v);
    if (!v) currentBillLang = 'vi';
    if (v) setTimeout(() => { document.querySelector('.bill-box')?.scrollIntoView({ behavior: 'smooth', block: 'start' }); }, 100);
}

function doPay() {
    if (confirm("Xác nhận thanh toán?")) {
        triggerHaptic('success'); remove(child(dbRef, `orders/${currentTab}`)); remove(child(dbRef, `locked/${currentTab}`)); remove(child(dbRef, `times/${currentTab}`)); selectTable(null);
    }
}

function doReset() {
    if (prompt("Mật khẩu xóa dữ liệu:") === "123") {
        remove(child(dbRef, 'orders')); remove(child(dbRef, 'locked')); remove(child(dbRef, 'times')); location.reload();
    }
}

// RIPPLE
document.addEventListener('click', (e) => {
    const btn = e.target.closest('.btn-action'); if (!btn) return;
    const rect = btn.getBoundingClientRect();
    const ripple = document.createElement('span');
    const size = Math.max(rect.width, rect.height) * 1.2;
    ripple.className = 'ripple';
    ripple.style.width = ripple.style.height = size + 'px';
    ripple.style.left = (e.clientX - rect.left - size / 2) + 'px';
    ripple.style.top = (e.clientY - rect.top - size / 2) + 'px';
    btn.appendChild(ripple);
    setTimeout(() => ripple.remove(), 600);
});

// DARK MODE
function applyDarkMode(isDark) {
    document.body.classList.toggle('dark-mode', isDark);
    const btn = document.getElementById('dark-toggle');
    if (btn) btn.innerText = isDark ? '☀️' : '🌙';
}
function toggleDarkMode() {
    triggerHaptic('nav');
    const isDark = !document.body.classList.contains('dark-mode');
    applyDarkMode(isDark);
    try {localStorage.setItem('phobup_dark_mode', isDark ? 'on' : 'off'); } catch (e) {}
}
function initDarkMode() {
    let saved = null;
    try {saved = localStorage.getItem('phobup_dark_mode'); } catch (e) {}
    if (saved === 'on') { applyDarkMode(true); return; }
    if (saved === 'off') { applyDarkMode(false); return; }
    applyDarkMode(false);
}
initDarkMode();

function scrollToCheckout() {
    triggerHaptic('nav');
    document.getElementById('btn-checkout')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

window.selectTable = selectTable; window.setLock = setLock; window.doPay = doPay; window.doReset = doReset; window.changeBillLang = changeBillLang; window.toggleDarkMode = toggleDarkMode; window.scrollToCheckout = scrollToCheckout;
// ─── FIX #3: setInterval(refresh, 30000) đã bị xóa — Firebase onValue() lo ───

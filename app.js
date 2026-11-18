/* Калькулятор: мои карты, борд и шанс победы. Карты соперника не вводятся —
   считаем против случайной руки (все 1326 комбинации). */
(function (root) {
  'use strict';
  const E = root.E;
  const { $, cardEl, fmt, plural, openSheet, closeSheet } = root.UI;

  const LS_KEY = 'eq.settings.v1';
  // Должно совпадать с VERSION в sw.js — иначе телефон останется на старой копии.
  const APP_VERSION = '1.2.0';

  // «случайная рука»: все комбинации из двух карт, кроме уже известных движок отбросит сам
  const ANY_HAND = [];
  for (let a = 0; a < 52; a++) for (let b = a + 1; b < 52; b++) ANY_HAND.push({ a, b, w: 1 });

  const state = {
    hero: [null, null],
    board: [null, null, null, null, null],
    trials: 50000,
    pot: 100,
    bet: 50,
    bb: 2,
  };

  const settings = Object.assign(
    { level: 2, sessionLen: 10, trials: 50000 },
    JSON.parse(localStorage.getItem(LS_KEY) || '{}')
  );
  state.trials = settings.trials;

  function saveSettings() {
    localStorage.setItem(LS_KEY, JSON.stringify(settings));
    state.trials = settings.trials;
  }

  /* ─────────── карты ─────────── */
  function renderCards() {
    const hero = $('heroSlots');
    hero.innerHTML = '';
    state.hero.forEach((c, i) => {
      const el = cardEl(c);
      el.addEventListener('click', () => openPicker('hero', i));
      hero.appendChild(el);
    });

    const board = $('boardSlots');
    board.innerHTML = '';
    state.board.forEach((c, i) => {
      const el = cardEl(c);
      el.addEventListener('click', () => openPicker('board', i));
      board.appendChild(el);
    });
    const n = state.board.filter((c) => c !== null).length;
    $('boardHint').textContent = n + ' ' + plural(n, ['карта', 'карты', 'карт']);
  }

  function usedCards() {
    const used = new Set();
    for (const c of state.hero) if (c !== null) used.add(c);
    for (const c of state.board) if (c !== null) used.add(c);
    return used;
  }

  function openPicker(group, idx) {
    const used = usedCards();
    const cur = group === 'board' ? state.board[idx] : state.hero[idx];

    openSheet('Выбери карту', (body) => {
      const grid = document.createElement('div');
      grid.className = 'pickgrid';
      // строка на масть (♠ ♥ ♦ ♣), внутри — от туза до двойки: карту ищут
      // «сначала масть, потом старшинство», а не по общему списку
      for (const s of [3, 2, 1, 0]) {
        for (let r = 12; r >= 0; r--) {
          const card = r * 4 + s;
          const el = document.createElement('button');
          el.className = 'pcard ' + (s === 1 || s === 2 ? 'red' : 'black')
            + (used.has(card) && card !== cur ? ' used' : '');
          el.innerHTML = `<span class="rk">${E.RANKS[r]}</span><span class="st">${root.UI.SUIT_CH[s]}</span>`;
          el.addEventListener('click', () => {
            if (used.has(card) && card !== cur) return;   // занятая карта — не трогаем
            setCard(group, idx, card);
            closeSheet();
          });
          grid.appendChild(el);
        }
      }
      body.appendChild(grid);

      const actions = document.createElement('div');
      actions.className = 'picker-actions';
      const clear = document.createElement('button');
      clear.className = 'btn ghost';
      clear.style.flex = '1';
      clear.textContent = 'Убрать карту';
      clear.addEventListener('click', () => { setCard(group, idx, null); closeSheet(); });
      actions.appendChild(clear);
      body.appendChild(actions);
    });
  }

  function setCard(group, idx, card) {
    if (group === 'hero') state.hero[idx] = card;
    else state.board[idx] = card;
    renderCards();
    scheduleCalc(20);
  }

  /* ─────────── пересчёт ─────────── */
  let calcTimer = null;
  let calcToken = 0;

  function scheduleCalc(delay) {
    clearTimeout(calcTimer);
    calcTimer = setTimeout(recalc, delay || 60);
  }

  function handClassLabel(cards) {
    const a = cards[0], b = cards[1];
    const r1 = a >> 2, r2 = b >> 2;
    if (r1 === r2) return E.RANKS[r1] + E.RANKS[r2];
    const hi = Math.max(r1, r2), lo = Math.min(r1, r2);
    return E.RANKS[hi] + E.RANKS[lo] + ((a & 3) === (b & 3) ? 's' : 'o');
  }

  function clearResult(msg) {
    currentEquity = null;
    $('eqValue').textContent = '—';
    $('sWin').textContent = $('sTie').textContent = $('sLose').textContent = '—';
    $('barWin').style.width = $('barTie').style.width = $('barLose').style.width = '0%';
    $('madeHand').textContent = msg || 'выбери свои карты';
    $('metaRange').textContent = '—';
    $('metaTrials').textContent = '—';
    const v = $('verdict');
    v.className = 'verdict';
    v.textContent = '—';
    $('progressBar').style.width = '0%';
  }

  async function recalc() {
    const token = ++calcToken;
    const hero = state.hero.filter((c) => c !== null);
    if (hero.length < 2) { clearResult('выбери две карты, чтобы начать'); return; }

    const board = state.board.filter((c) => c !== null);

    $('progressBar').style.width = '0%';
    const res = await E.estimateAsync(
      { hero, board, range: ANY_HAND, trials: state.trials, opponents: 1 },
      (p) => { if (token === calcToken) $('progressBar').style.width = (p * 100).toFixed(1) + '%'; },
      () => token !== calcToken
    );
    if (token !== calcToken) return;
    $('progressBar').style.width = '0%';
    if (!res) { clearResult('не удалось раздать: проверь карты'); return; }

    const eq = res.equity;
    $('eqValue').textContent = fmt(eq * 100, 1);
    $('sWin').textContent = fmt(res.win * 100, 1) + '%';
    $('sTie').textContent = fmt(res.tie * 100, 1) + '%';
    $('sLose').textContent = fmt(res.lose * 100, 1) + '%';
    $('barWin').style.width = (res.win * 100) + '%';
    $('barTie').style.width = (res.tie * 100) + '%';
    $('barLose').style.width = (res.lose * 100) + '%';

    $('madeHand').textContent = board.length >= 3
      ? 'сейчас: ' + E.describe(hero.concat(board))
      : (board.length === 0 ? 'префлоп: ' + handClassLabel(hero) : 'на борде ' + board.length + ' ' + plural(board.length, ['карта', 'карты', 'карт']));

    $('metaRange').textContent = `случайная рука · ${res.combos} комб.`;
    $('metaTrials').textContent = `${fmt(res.trials, 0)} раздач · ${fmt(res.ms, 0)} мс`;

    updateOdds(eq);
  }

  let currentEquity = null;

  function updateOdds(eq) {
    if (eq !== null && eq !== undefined) currentEquity = eq;
    const pot = Math.max(0, Number($('potIn').value) || 0);
    const bet = Math.max(0, Number($('betIn').value) || 0);
    const bb = Math.max(0.01, Number($('bbIn').value) || 1);

    const v = $('verdict');

    if (currentEquity === null || currentEquity === undefined) {
      v.className = 'verdict';
      v.textContent = '—';
      return;
    }
    if (bet <= 0) {
      v.className = 'verdict';
      v.textContent = `нужно эквити для колла: задай ставку (банк ${fmt(pot, 0)})`;
      return;
    }

    const need = bet / (pot + bet);
    const ev = currentEquity * (pot + bet) - bet;
    const margin = (currentEquity - need) * 100;

    if (margin >= 0) {
      v.className = 'verdict good';
      v.textContent = `КОЛЛ: +EV. Запас ${fmt(margin, 1)} п.п. → ${ev >= 0 ? '+' : ''}${fmt(ev, 1)} фишек (+${fmt(ev / bb, 1)} бб)`;
    } else {
      v.className = 'verdict bad';
      v.textContent = `ФОЛД: не хватает ${fmt(-margin, 1)} п.п. (EV ${fmt(ev, 1)} фишек, ${fmt(ev / bb, 1)} бб)`;
    }
  }

  /* ─────────── вкладки и настройки ─────────── */
  let activeTab = 'train';

  function setTab(tab) {
    activeTab = tab;
    $('screenTrain').classList.toggle('hidden', tab !== 'train');
    $('screenCalc').classList.toggle('hidden', tab !== 'calc');
    $('title').textContent = tab === 'train' ? 'Тренировка' : 'Калькулятор';
    document.querySelectorAll('.tabbar button').forEach((b) => {
      b.classList.toggle('on', b.dataset.tab === tab);
    });
    document.querySelector('.content').scrollTop = 0;
    if (tab === 'calc') scheduleCalc(80);
    if (root.Trainer) root.Trainer.onShow();
  }

  function settingsSheet() {
    openSheet('Настройки', (body) => {
      body.appendChild(row('Сложность', '1 — флоп · 2 — флоп/терн · 3 — все улицы',
        [1, 2, 3], settings.level, (v) => { settings.level = v; saveSettings(); }));

      body.appendChild(row('Спотов в серии', 'сколько задач в одной тренировке',
        [5, 10, 20], settings.sessionLen, (v) => { settings.sessionLen = v; saveSettings(); }));

      body.appendChild(row('Точность', 'раздач Монте-Карло на расчёт',
        [20000, 50000, 200000], settings.trials, (v) => { settings.trials = v; saveSettings(); scheduleCalc(10); },
        { 20000: 'быстро', 50000: 'обычно', 200000: 'точно' }));

      const stats = JSON.parse(localStorage.getItem('eq.stats.v1') || '{}');
      const last = stats.total
        ? `${stats.correct || 0} из ${stats.total} верных, лучшая серия ${stats.bestStreak || 0}`
        : 'пока пусто';
      const info = document.createElement('div');
      info.className = 'setrow';
      info.innerHTML = `<div><div class="name">Статистика</div><div class="desc">${last}</div></div>`;
      const reset = document.createElement('button');
      reset.className = 'btn ghost';
      reset.style.minHeight = '40px';
      reset.textContent = 'Сброс';
      reset.addEventListener('click', () => {
        localStorage.removeItem('eq.stats.v1');
        closeSheet();
        root.Trainer && root.Trainer.refreshHeader();
      });
      info.appendChild(reset);
      body.appendChild(info);

      body.appendChild(offlineRow());

      const about = document.createElement('div');
      about.className = 'setrow';
      about.innerHTML = `<div><div class="name">Версия</div><div class="desc">всё на телефоне, интернет не нужен</div></div><span class="hint">${APP_VERSION}</span>`;
      body.appendChild(about);
    });
  }

  /* ─────────── офлайн-копия ─────────── */
  async function cacheStatus() {
    if (location.protocol === 'file:') {
      return { ok: false, reason: 'открыто как файл: кэш не нужен, работает и так' };
    }
    if (typeof caches === 'undefined') {
      return { ok: false, reason: 'браузер не дал доступ к кэшу — нужен https или localhost' };
    }
    const keys = await caches.keys();
    const key = keys.filter((k) => k.indexOf('ekviti-') === 0).sort().pop();
    if (!key) return { ok: false, reason: 'ещё не сохранено: нужен один запуск с интернетом' };
    const cache = await caches.open(key);
    const reqs = await cache.keys();
    return { ok: true, count: reqs.length, key };
  }

  async function refreshApp() {
    closeSheet();
    try {
      const reg = root.EQ_SW
        || (navigator.serviceWorker && await navigator.serviceWorker.getRegistration());
      if (reg) await reg.update();
    } catch (e) { /* нет сети — просто перезагрузимся из кэша */ }
    location.reload();
  }

  function offlineRow() {
    const el = document.createElement('div');
    el.className = 'setrow';
    el.innerHTML = '<div><div class="name">Офлайн-копия</div>'
      + '<div class="desc">проверяю…</div></div>';
    const btn = document.createElement('button');
    btn.className = 'btn ghost';
    btn.style.minHeight = '40px';
    btn.textContent = 'Обновить';
    btn.addEventListener('click', refreshApp);
    el.appendChild(btn);

    cacheStatus().then((st) => {
      const desc = el.querySelector('.desc');
      if (!desc) return;
      desc.textContent = st.ok
        ? `сохранено ${st.count} ${plural(st.count, ['файл', 'файла', 'файлов'])} · версия ${APP_VERSION} · сеть не нужна`
        : st.reason;
    }).catch(() => {
      const desc = el.querySelector('.desc');
      if (desc) desc.textContent = 'не удалось проверить кэш';
    });
    return el;
  }

  function row(name, desc, values, current, onPick, labels) {
    const el = document.createElement('div');
    el.className = 'setrow';
    const left = document.createElement('div');
    left.innerHTML = `<div class="name">${name}</div><div class="desc">${desc}</div>`;
    const seg = document.createElement('div');
    seg.className = 'seg';
    values.forEach((v) => {
      const b = document.createElement('button');
      b.textContent = (labels && labels[v]) || String(v);
      if (v === current) b.className = 'on';
      b.addEventListener('click', () => {
        seg.querySelectorAll('button').forEach((x) => x.classList.remove('on'));
        b.classList.add('on');
        onPick(v);
      });
      seg.appendChild(b);
    });
    el.appendChild(left);
    el.appendChild(seg);
    return el;
  }

  /* ─────────── старт ─────────── */
  function init() {
    renderCards();

    document.querySelectorAll('.tabbar button').forEach((b) => {
      b.addEventListener('click', () => setTab(b.dataset.tab));
    });
    $('btnHeroClear').addEventListener('click', () => {
      state.hero = [null, null];
      renderCards();
      scheduleCalc(20);
    });
    ['potIn', 'betIn', 'bbIn'].forEach((id) => {
      $(id).addEventListener('input', () => updateOdds(null));
    });
    $('btnSettings').addEventListener('click', settingsSheet);
    $('sheetClose').addEventListener('click', closeSheet);
    $('sheetBack').addEventListener('click', closeSheet);
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeSheet(); });

    setTab('train');
    clearResult('выбери свои карты');
  }

  root.App = {
    state, settings, saveSettings, setTab, recalc, scheduleCalc, init, updateOdds,
    handClassLabel, ANY_HAND, clearResult, setCard, renderCards,
    version: APP_VERSION, cacheStatus, refreshApp,
    get tab() { return activeTab; },
  };

  document.addEventListener('DOMContentLoaded', init);
})(typeof globalThis !== 'undefined' ? globalThis : this);

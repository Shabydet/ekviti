/* Тренировка: серия спотов, ответ, разбор, статистика.
   Соперник не задаётся — эквити считается против случайной руки. */
(function (root) {
  'use strict';
  const E = root.E;
  const { $, cardEl, fmt, plural, pct } = root.UI;

  const STATS_KEY = 'eq.stats.v1';

  const S = {
    session: null,   // { len, i, correct, score, streak, best, kind }
    spot: null,
    truth: null,     // { equity, need, ev, margin }
    answered: false,
    token: 0,
  };

  function loadStats() {
    return Object.assign(
      { total: 0, correct: 0, bestStreak: 0, sessions: 0 },
      JSON.parse(localStorage.getItem(STATS_KEY) || '{}')
    );
  }

  function saveStats(st) {
    localStorage.setItem(STATS_KEY, JSON.stringify(st));
  }

  /* ─────────── отрисовка спота ─────────── */
  function cardsRow(label, cards) {
    const row = document.createElement('div');
    row.className = 'spot-row';
    const lb = document.createElement('div');
    lb.className = 'label';
    lb.textContent = label;
    const box = document.createElement('div');
    box.className = 'cards';
    for (const c of cards) box.appendChild(cardEl(c, { small: true }));
    if (!cards.length) {
      const dash = document.createElement('span');
      dash.className = 'hint';
      dash.textContent = '—';
      box.appendChild(dash);
    }
    row.appendChild(lb);
    row.appendChild(box);
    return row;
  }

  function renderSpot(spot) {
    const box = $('spotCards');
    box.innerHTML = '';
    box.appendChild(cardsRow('Ты', spot.hero));
    box.appendChild(cardsRow('Борд', spot.board));

    const facts = $('spotFacts');
    facts.innerHTML = '';
    const add = (html) => {
      const d = document.createElement('span');
      d.className = 'fact';
      d.innerHTML = html;
      facts.appendChild(d);
    };
    add(`банк <b>${fmt(spot.pot, 0)}</b>`);
    add(`ставка <b>${fmt(spot.bet, 0)}</b>`);
  }

  /* ─────────── правда о споте ─────────── */
  function computeTruth(spot, token) {
    return E.estimateAsync(
      {
        hero: spot.hero, board: spot.board, range: root.App.ANY_HAND,
        trials: root.App.settings.trials, opponents: 1,
      },
      null,
      () => token !== S.token
    );
  }

  /* ─────────── новый спот ─────────── */
  async function nextSpot(attempt) {
    const tryNo = attempt || 0;
    const token = ++S.token;
    S.answered = false;
    $('reveal').classList.add('hidden');
    $('btnNext').classList.add('hidden');
    $('summary').classList.add('hidden');
    $('spotCard').classList.remove('hidden');
    $('question').classList.remove('hidden');
    $('answers').classList.remove('hidden');

    const spot = root.Drill.createSpot({ level: root.App.settings.level });
    const truth = await computeTruth(spot, token);
    if (token !== S.token) return;

    if (!truth) {                       // теоретически невозможно, но пусть не падает
      if (tryNo < 6) return nextSpot(tryNo + 1);
      return;
    }

    const eq = truth.equity;
    // слишком очевидные руки (почти наверняка выигрыш/проигрыш) в тренировке не нужны
    if ((eq < 0.12 || eq > 0.85) && tryNo < 8) return nextSpot(tryNo + 1);

    // ставку подбираем так, чтобы колл был на грани: нужно эквити = eq ± 3..10 п.п.
    const off = (0.03 + Math.random() * 0.07) * (Math.random() < 0.5 ? -1 : 1);
    let need = Math.min(0.78, Math.max(0.12, eq + off));
    let bet = Math.max(5, Math.round((spot.pot * need) / (1 - need) / 5) * 5);
    need = bet / (spot.pot + bet);
    spot.bet = bet;

    const ev = eq * (spot.pot + bet) - bet;
    S.spot = spot;
    S.truth = { equity: eq, need, ev, margin: eq - need };

    renderSpot(spot);
    renderAnswers(S.session.kind);
    paintHeader();
  }

  function renderAnswers(kind) {
    const box = $('answers');
    box.innerHTML = '';
    box.className = 'answers' + (kind === 'callfold' ? ' two' : '');
    $('question').textContent = kind === 'callfold'
      ? 'Ставка соперника. Колл или фолд?'
      : 'Сколько эквити у твоей руки?';

    if (kind === 'callfold') {
      const mk = (label, value) => {
        const b = document.createElement('button');
        b.className = 'btn';
        b.textContent = label;
        b.dataset.answer = value;
        b.addEventListener('click', () => answer(value));
        return b;
      };
      box.appendChild(mk('Колл', 'call'));
      box.appendChild(mk('Фолд', 'fold'));
      return;
    }

    // четыре варианта процентов, один из них — истина с точностью до округления
    const t = S.truth.equity * 100;
    for (const v of uniqueOpts([t, t + 9, t - 9, t + 18], t)) {
      const b = document.createElement('button');
      b.className = 'btn';
      b.textContent = fmt(v, 1) + '%';
      b.dataset.answer = String(v);
      b.addEventListener('click', () => answer(v));
      box.appendChild(b);
    }
  }

  function uniqueOpts(list, truth) {
    const out = [];
    for (let v of list) {
      v = Math.min(96, Math.max(4, Math.round(v * 10) / 10));
      if (out.every((x) => Math.abs(x - v) >= 4)) out.push(v);
    }
    while (out.length < 4) {
      out.push(Math.min(96, Math.round((truth + out.length * 7) * 10) / 10));
    }
    if (!out.some((v) => Math.abs(v - truth) <= 0.6)) out[out.length - 1] = Math.round(truth * 10) / 10;
    return out.sort(() => Math.random() - 0.5);
  }

  /* ─────────── ответ ─────────── */
  function answer(value) {
    if (S.answered || !S.truth) return;
    S.answered = true;

    const kind = S.session.kind;
    const truth = S.truth;
    const buttons = Array.from($('answers').querySelectorAll('button'));
    const chosen = buttons.find((b) => b.dataset.answer === String(value));

    let correct = false;
    let chosenLabel = '';

    if (kind === 'callfold') {
      const right = truth.margin >= 0 ? 'call' : 'fold';
      correct = value === right;
      chosenLabel = value === 'call' ? 'колл' : 'фолд';
      buttons.forEach((b) => {
        b.disabled = true;
        if (b.dataset.answer === right) b.classList.add('correct');
        else if (b === chosen) b.classList.add('wrong');
      });
    } else {
      const truthPct = truth.equity * 100;
      correct = Math.abs(Number(value) - truthPct) <= 0.6;
      chosenLabel = fmt(Number(value), 1) + '%';
      buttons.forEach((b) => {
        b.disabled = true;
        if (Math.abs(Number(b.dataset.answer) - truthPct) <= 0.6) b.classList.add('correct');
        else if (b === chosen) b.classList.add('wrong');
      });
    }

    S.session.i++;
    if (correct) {
      S.session.correct++;
      S.session.score++;
      S.session.streak++;
      S.session.best = Math.max(S.session.best, S.session.streak);
    } else {
      S.session.streak = 0;
    }

    const st = loadStats();
    st.total++;
    if (correct) st.correct++;
    st.bestStreak = Math.max(st.bestStreak, S.session.best);
    saveStats(st);

    paintHeader();
    showReveal(kind, correct, chosenLabel);
  }

  function showReveal(kind, correct, chosenLabel) {
    const t = S.truth;
    const box = $('reveal');
    box.innerHTML = '';
    box.classList.remove('hidden');

    const big = document.createElement('div');
    big.className = 'big ' + (correct ? 'good' : 'bad');
    big.textContent = (correct ? 'Верно · ' : 'Мимо · ') + pct(t.equity);
    box.appendChild(big);

    const row = (name, value) => {
      const d = document.createElement('div');
      d.className = 'row';
      d.innerHTML = `<span>${name}</span><b>${value}</b>`;
      box.appendChild(d);
    };
    row('шанс победы', pct(t.equity));
    row('к коллу нужно', pct(t.need));
    row('EV колла', `${t.ev >= 0 ? '+' : ''}${fmt(t.ev, 1)} фишек (${t.ev >= 0 ? '+' : ''}${fmt(t.ev / S.spot.bb, 1)} бб)`);
    if (kind === 'equity') row('твой ответ', chosenLabel);

    const why = document.createElement('div');
    why.className = 'why';
    const diff = (t.equity - t.need) * 100;
    if (kind === 'callfold') {
      why.textContent = t.margin >= 0
        ? `Шанс победы ${pct(t.equity)} против нужных ${pct(t.need)} — запас ${fmt(diff, 1)} п.п., колл прибыльный.`
        : `Шанс победы ${pct(t.equity)} против нужных ${pct(t.need)} — не хватает ${fmt(-diff, 1)} п.п., колл убыточный.`;
    } else {
      why.textContent = `Ставка ${fmt(S.spot.bet, 0)} в банк ${fmt(S.spot.pot, 0)} требует ${pct(t.need)}; у руки ${pct(t.equity)} — ${t.margin >= 0 ? 'колл проходит' : 'колл не проходит'}.`;
    }
    box.appendChild(why);

    $('btnNext').classList.remove('hidden');
    $('btnNext').textContent = S.session.i >= S.session.len ? 'Итоги серии' : 'Дальше';
  }

  function paintHeader() {
    const s = S.session;
    if (!s) return;
    $('tProgress').textContent = `${s.i}/${s.len}`;
    $('tScore').textContent = String(s.score);
    $('tStreak').textContent = String(s.streak);
  }

  function refreshHeader() {
    paintHeader();
  }

  /* ─────────── серия ─────────── */
  function startSession(kind) {
    S.session = {
      len: root.App.settings.sessionLen,
      i: 0, correct: 0, score: 0, streak: 0, best: 0,
      kind: kind || (Math.random() < 0.5 ? 'callfold' : 'equity'),
    };
    const st = loadStats();
    st.sessions = (st.sessions || 0) + 1;
    saveStats(st);
    paintHeader();
    nextSpot();
  }

  function showSummary() {
    const s = S.session;
    $('spotCard').classList.add('hidden');
    $('question').classList.add('hidden');
    $('answers').classList.add('hidden');
    $('reveal').classList.add('hidden');
    $('btnNext').classList.add('hidden');

    const acc = s.len ? Math.round((s.correct / s.len) * 100) : 0;
    const box = $('summary');
    box.classList.remove('hidden');
    box.innerHTML = `
      <h2>${acc >= 80 ? 'Хорошая серия' : acc >= 50 ? 'Нормально' : 'Есть над чем работать'}</h2>
      <div class="sub">${s.correct} из ${s.len} верно · лучшая серия ${s.best}</div>
      <div class="grid">
        <div class="cell"><b>${acc}%</b><span>точность</span></div>
        <div class="cell"><b>${s.score}</b><span>очков</span></div>
      </div>`;

    const again = document.createElement('button');
    again.className = 'btn primary wide';
    again.textContent = 'Ещё серию';
    again.addEventListener('click', () => startSession());
    box.appendChild(again);

    const other = document.createElement('button');
    other.className = 'btn ghost wide';
    other.textContent = s.kind === 'callfold' ? 'Потренировать оценку шанса' : 'Потренировать решения';
    other.addEventListener('click', () => startSession(s.kind === 'callfold' ? 'equity' : 'callfold'));
    box.appendChild(other);

    const st = loadStats();
    const total = document.createElement('div');
    total.className = 'why';
    total.style.textAlign = 'center';
    total.style.marginTop = '10px';
    total.textContent = `всего: ${st.correct} из ${st.total} верных, лучшая серия ${st.bestStreak}`;
    box.appendChild(total);
  }

  function onNext() {
    if (!S.session) return;
    if (S.session.i >= S.session.len) { showSummary(); return; }
    nextSpot();
  }

  function onShow() {
    if (!S.session) startSession();
    else if (S.session.i >= S.session.len) showSummary();
  }

  document.addEventListener('DOMContentLoaded', () => {
    $('btnNext').addEventListener('click', onNext);
    onShow();           // сессия уже могла стартовать из App.init → setTab
  });

  root.Trainer = { startSession, onShow, refreshHeader, get session() { return S.session; } };
})(typeof globalThis !== 'undefined' ? globalThis : this);

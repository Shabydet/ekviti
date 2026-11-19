/* Камера: навели iPhone на экран ноутбука, сняли кадр, приложение находит карты,
   читает ранг и масть и отдаёт их в калькулятор. Всё локально: кадр никуда не
   уходит, работает и без сети.

   Конвейер кадра:
     1) CardDetect.findCards — поиск прямоугольников карт (детектор, порт с Python);
     2) readCard — подбор вырезки и распознавание знака (CardOCR);
     3) дедупликация по подписи: одна карта не может лежать в кадре дважды;
     4) раскладка «рука / борд» по тому, как карты стоят на экране. */
(function (root) {
  'use strict';
  const $ = root.UI.$;

  // доля уверенности: сумма сходств ранга и масти, после которой дальше не ищем
  const GOOD_SCORE = 1.75;
  const CARD_ASPECT = 0.70;        // стандартная пропорция игральной карты
  const ROW_GAP = 0.6;             // разрыв по вертикали, отделяющий ряд карт

  const st = {
    stream: null,
    mode: 'live',        // live | preview
    shot: null,          // HTMLCanvasElement со снимком
    cards: [],           // что нашёл детектор (рамки)
    found: [],           // распознавание: {card, id, needConfirm, reason, x, y, w, h}
    sure: [],            // уверенно прочитанные карты
    unsure: [],          // рамки, похожие на карту, но прочитанные под вопросом
    layout: { hero: [], board: [] },
    recognized: [],      // id карт (0..51) — уходят в калькулятор
    applied: false,
    ms: 0,
  };

  function showMsg(text, kind) {
    const el = $('camMsg');
    el.textContent = text || '';
    el.className = 'cam-msg' + (text ? ' shown' : '') + (kind === 'bad' ? ' bad' : '');
  }

  function camSupported() {
    return !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia);
  }

  function errText(e) {
    const name = (e && e.name) || '';
    if (name === 'NotAllowedError' || name === 'SecurityError') {
      return 'нет доступа к камере. Настройки → Safari → Камера → «Спросить» или «Разрешить»';
    }
    if (name === 'NotFoundError' || name === 'OverconstrainedError') return 'камера не найдена';
    if (name === 'NotReadableError') return 'камеру занял другой процесс — закрой его и попробуй снова';
    return 'камера не открылась: ' + (e && e.message ? e.message : 'неизвестная причина');
  }

  function setMode(mode) {
    st.mode = mode;
    const live = mode === 'live';
    $('camVideo').classList.toggle('hidden', !live);
    $('camShot').classList.toggle('hidden', live);
    $('camOverlay').classList.toggle('hidden', live);
    $('camShutter').classList.toggle('hidden', !live);
    $('camRetake').classList.toggle('hidden', live);
    $('camApply').classList.toggle('hidden', live);
    $('camHint').textContent = live
      ? 'наведи камеру на экран с игрой'
      : 'проверь, что карты определились';
    if (live) showMsg('');
  }

  async function open() {
    if (!camSupported()) {
      showMsg('этот браузер не умеет открывать камеру', 'bad');
      $('cam').classList.remove('hidden');
      return;
    }
    $('cam').classList.remove('hidden');
    document.body.classList.add('locked');
    showMsg('включаю камеру…');
    try {
      st.stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: {
          facingMode: { ideal: 'environment' },
          width: { ideal: 1920 },
          height: { ideal: 1440 },
        },
      });
      const v = $('camVideo');
      v.srcObject = st.stream;
      try { await v.play(); } catch (e) { /* iOS иногда требует повторного касания */ }
      setMode('live');
      showMsg('');
    } catch (e) {
      showMsg(errText(e), 'bad');
    }
  }

  function stopStream() {
    if (st.stream) {
      st.stream.getTracks().forEach((t) => { try { t.stop(); } catch (e) {} });
      st.stream = null;
    }
    const v = $('camVideo');
    v.srcObject = null;
  }

  function close() {
    stopStream();
    $('cam').classList.add('hidden');
    document.body.classList.remove('locked');
    st.shot = null;
    st.cards = [];
    st.found = [];
    st.sure = [];
    st.unsure = [];
    st.layout = { hero: [], board: [] };
    st.recognized = [];
    st.applied = false;
    showMsg('');
    setMode('live');
  }

  /** Снимок кадра: рисуем в canvas в полном разрешении видео. */
  function capture() {
    const v = $('camVideo');
    const w = v.videoWidth || 1280;
    const h = v.videoHeight || 960;
    const c = $('camShot');
    c.width = w;
    c.height = h;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(v, 0, 0, w, h);
    return c;
  }

  /** Пиксели кадра: и детектор, и распознавание работают с одним ImageData. */
  function frameData(canvas) {
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    return ctx.getImageData(0, 0, canvas.width, canvas.height);
  }

  /** Прямоугольный кроп из ImageData (без обращения к canvas). */
  function cropRect(img, x, y, w, h) {
    const sw = img.width, sh = img.height;
    x = Math.max(0, Math.round(x));
    y = Math.max(0, Math.round(y));
    w = Math.min(sw - x, Math.round(w));
    h = Math.min(sh - y, Math.round(h));
    const out = new Uint8ClampedArray(w * h * 4);
    for (let row = 0; row < h; row++) {
      const src = ((y + row) * sw + x) * 4;
      out.set(img.data.subarray(src, src + w * 4), row * w * 4);
    }
    return { data: out, width: w, height: h };
  }

  function lerp(a, b, t) { return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]; }

  /** Нижняя часть quad: рамка иногда захватывает светлую полосу над картой. */
  function subQuad(quad, v0) {
    const tl = quad[0], tr = quad[1], br = quad[2], bl = quad[3];
    return [lerp(tl, bl, v0), lerp(tr, br, v0), br, bl];
  }

  /** Поворот quad вокруг его центра: телефон в руке почти всегда слегка наклонён. */
  function rotQuad(quad, deg) {
    let cx = 0, cy = 0;
    for (let i = 0; i < 4; i++) { cx += quad[i][0]; cy += quad[i][1]; }
    cx /= 4;
    cy /= 4;
    const a = (deg * Math.PI) / 180, c = Math.cos(a), s = Math.sin(a);
    return quad.map((p) => {
      const dx = p[0] - cx, dy = p[1] - cy;
      return [cx + dx * c - dy * s, cy + dx * s + dy * c];
    });
  }

  /** Карта OCR -> id движка (r*4 + s). null, если карта не из колоды. */
  function cardId(rank, suit) {
    const R = root.E.RANKS;
    const S = root.UI.SUIT_CH;
    const r = R.indexOf(rank);
    const s = S.indexOf(suit);
    return (r >= 0 && s >= 0) ? r * 4 + s : null;
  }

  /**
   * Читает одну найденную рамку: перебирает варианты вырезки и берёт лучший.
   * Рамка детектора бывает сдвинутой или со «шляпой» сверху, поэтому вариантов
   * несколько; на уверенном результате перебор прекращается.
   */
  function readCard(img, c) {
    const aspect = c.w / c.h;
    const tries = [];
    const ow = Math.round(c.w * 1.6);

    /** Выпрямление quad (целиком или нижней части) в кадр нужной высоты. */
    const warpTry = (quad, v0) => tries.push(() => root.CardOCR.warp(
      img, v0 ? subQuad(quad, v0) : quad, ow, Math.round(c.h * (1 - v0) * 1.6)));

    tries.push(() => cropRect(img, c.x, c.y, c.w, c.h));
    if (c.quad) {
      warpTry(c.quad, 0);
      [0.12, 0.20, 0.28].forEach((v0) => warpTry(c.quad, v0));
    }
    if (aspect < CARD_ASPECT - 0.04) {
      const hh = c.w / CARD_ASPECT;
      tries.push(() => cropRect(img, c.x, c.y, c.w, hh));
      tries.push(() => cropRect(img, c.x, c.y + (c.h - hh) / 2, c.w, hh));
      tries.push(() => cropRect(img, c.x, c.y + c.h - hh, c.w, hh));
    } else if (aspect > CARD_ASPECT + 0.04) {
      const ww = c.h * CARD_ASPECT;
      tries.push(() => cropRect(img, c.x, c.y, ww, c.h));
      tries.push(() => cropRect(img, c.x + (c.w - ww) / 2, c.y, ww, c.h));
    }
    // наклон кадра: пробуем повернуть карту на пару градусов в обе стороны
    if (c.quad) {
      [-2, 2, -4, 4].forEach((deg) => {
        const q = rotQuad(c.quad, deg);
        warpTry(q, 0);
        warpTry(q, 0.20);
      });
    }

    let best = null;
    for (let i = 0; i < tries.length; i++) {
      let res;
      try { res = root.CardOCR.recognize(tries[i]()); } catch (e) { continue; }
      const score = res.rankScore + res.suitScore;
      if (!best || score > best.score) best = { res, score, how: i };
      if (!res.needConfirm && score >= GOOD_SCORE) break;
    }
    if (!best) return null;

    const res = best.res;
    const id = cardId(res.rank, res.suit);
    return {
      x: c.x, y: c.y, w: c.w, h: c.h,
      quad: c.quad || null,
      id,
      card: id === null ? '?' : res.card,
      needConfirm: id === null ? true : res.needConfirm,
      reason: id === null ? 'не карта из колоды' : (res.reason || ''),
      score: best.score,
    };
  }

  /** Поиск рамок карт на снимке (только детектор, без распознавания). */
  function findCards(canvas) {
    const img = frameData(canvas);
    return root.CardDetect.findCards(img);
  }

  /** Полный разбор кадра: рамки + чтение знаков + дедупликация по подписи. */
  function scan(canvas) {
    const img = frameData(canvas);
    const boxes = root.CardDetect.findCards(img);
    const all = [];
    for (let i = 0; i < boxes.length; i++) {
      const c = readCard(img, boxes[i]);
      if (c) all.push(c);
    }

    // одна и та же карта не может встретиться в кадре дважды — оставляем лучшую
    const byLabel = new Map();
    for (let i = 0; i < all.length; i++) {
      const c = all[i];
      if (c.needConfirm || c.id === null) continue;
      const prev = byLabel.get(c.card);
      if (!prev || c.score > prev.score) byLabel.set(c.card, c);
    }
    const sure = orderCards([...byLabel.values()]);
    // рамки вокруг аватаров и фишек тоже «похожи на бумагу» — оставляем только те,
    // что по размеру и месту годятся в карты рядом с уверенными
    const rows = cardRows(sure);
    const unsure = all.filter((c) => c.needConfirm && looksLikeCard(c, rows));
    return { boxes, all, sure, unsure };
  }

  /** Ряды прочитанных карт с типичной шириной — опора для отсева чужих рамок. */
  function cardRows(sure) {
    return rowsOf(sure).map((r) => {
      const ws = r.list.map((c) => c.w).sort((a, b) => a - b);
      return { y: r.y, h: r.h, w: ws[ws.length >> 1] };
    });
  }

  /** Похожа ли нечитанная рамка на карту, а не на элемент интерфейса. */
  function looksLikeCard(c, rows) {
    const aspect = c.w / c.h;
    if (aspect < 0.56 || aspect > 0.86) return false;
    if (!rows.length) return true;
    return rows.some((r) => c.w >= r.w * 0.6 && c.w <= r.w * 1.6
      && c.h >= r.h * 0.6 && c.h <= r.h * 1.6
      && Math.abs(c.y - r.y) < r.h);
  }

  /** Порядок карт: сверху вниз по рядам, внутри ряда — слева направо, как на экране. */
  function orderCards(list) {
    const byY = list.slice().sort((a, b) => (a.y - b.y) || (a.x - b.x));
    const out = [];
    for (const row of rowsOf(byY)) {
      row.list.sort((a, b) => a.x - b.x);
      for (const c of row.list) out.push(c);
    }
    return out;
  }

  /** Группирует карты по рядам: на экране борд и рука стоят отдельными рядами. */
  function rowsOf(list) {
    const out = [];
    for (let i = 0; i < list.length; i++) {
      const c = list[i];
      const last = out[out.length - 1];
      if (last && c.y - last.y < last.h * ROW_GAP) {
        last.list.push(c);
        if (c.h > last.h) last.h = c.h;
      } else {
        out.push({ y: c.y, h: c.h, list: [c] });
      }
    }
    return out;
  }

  /**
   * Раскладка «рука / борд». В кадре рука всегда ниже борда и это ровно две
   * карты; если ряд один, то две карты — рука, три и больше — борд.
   */
  function layoutOf(sure) {
    const ids = sure.map((c) => c.id);
    if (!ids.length) return { hero: [], board: [] };
    if (ids.length <= 2) return { hero: ids, board: [] };

    const rows = rowsOf(sure);
    const lowest = rows[rows.length - 1];
    if (rows.length >= 2 && lowest.list.length === 2) {
      const hand = lowest.list.map((c) => c.id);
      const board = sure.filter((c) => hand.indexOf(c.id) === -1).map((c) => c.id);
      return { hero: hand, board: board };
    }
    return { hero: [], board: ids };
  }

  function drawOverlay(canvas, cards) {
    const ov = $('camOverlay');
    // оверлей точно накрывает canvas: переводим координаты кадра в экранные
    const r = canvas.getBoundingClientRect();
    ov.style.left = r.left + 'px';
    ov.style.top = r.top + 'px';
    ov.style.width = r.width + 'px';
    ov.style.height = r.height + 'px';
    ov.innerHTML = '';
    if (!cards.length) {
      ov.classList.add('hidden');
      return;
    }
    const kx = r.width / canvas.width;
    const ky = r.height / canvas.height;
    cards.forEach((c, i) => {
      const d = document.createElement('div');
      d.className = 'cam-box'
        + (c.id === null || c.id === undefined ? ' bad' : '')
        + (c.needConfirm ? ' unsure' : '');
      d.style.left = (c.x * kx) + 'px';
      d.style.top = (c.y * ky) + 'px';
      d.style.width = (c.w * kx) + 'px';
      d.style.height = (c.h * ky) + 'px';
      const span = document.createElement('span');
      span.textContent = c.card && c.card !== '?' ? c.card : String(i + 1);
      d.appendChild(span);
      ov.appendChild(d);
    });
    ov.classList.remove('hidden');
  }

  function shoot() {
    if (st.mode !== 'live') return;
    const canvas = capture();
    st.shot = canvas;
    setMode('preview');
    showMsg('ищу карты…');
    // даём браузеру перерисовать подсказку, иначе экран замрёт на время разбора
    setTimeout(() => {
      try {
        run(canvas);
      } catch (e) {
        showMsg('не смогла разобрать кадр: ' + (e && e.message ? e.message : e), 'bad');
      }
    }, 30);
  }

  function run(canvas) {
    const t0 = performance.now();
    const res = scan(canvas);
    st.ms = Math.round(performance.now() - t0);
    st.cards = res.boxes;
    st.found = res.all;
    st.sure = res.sure;
    st.unsure = res.unsure;
    st.recognized = res.sure.map((c) => c.id);
    st.layout = layoutOf(res.sure);
    drawOverlay(canvas, res.sure.concat(res.unsure));
    $('camApply').disabled = st.recognized.length === 0;

    const n = res.sure.length;
    const unsure = res.unsure.length;
    if (!res.all.length) {
      showMsg('карт не видно: ближе к экрану и без блика', 'bad');
      return;
    }
    if (!n) {
      showMsg('вижу ' + res.all.length + ', но ни одна не читается — снимай ровнее', 'bad');
      return;
    }
    const names = res.sure.map((c) => c.card).join(' ');
    showMsg(names + (unsure ? ' · ' + unsure + ' под вопросом' : '') + ' · ' + st.ms + ' мс');
  }

  function retake() {
    setMode('live');
    st.shot = null;
    st.cards = [];
    st.found = [];
    st.sure = [];
    st.unsure = [];
    st.layout = { hero: [], board: [] };
    st.recognized = [];
    $('camOverlay').classList.add('hidden');
  }

  function apply() {
    if (!st.recognized.length) {
      showMsg('карты не распознаны — попробуй снять ближе', 'bad');
      return;
    }
    if (root.App && root.App.applyScan) {
      const ok = root.App.applyScan(st.recognized, st.layout);
      if (ok === false) { showMsg('эти карты уже стоят в калькуляторе', 'bad'); return; }
    }
    noteAfterApply();
    st.applied = true;
    close();
  }

  /** Честно говорим, что осталось непрочитанным: молча терять карты нельзя. */
  function noteAfterApply() {
    if (!root.App || !root.App.setScanNote) return;
    const n = st.recognized.length;
    const unsure = st.unsure.length;
    const parts = [];
    if (n) parts.push('прочитала ' + n + ' ' + root.UI.plural(n, ['карту', 'карты', 'карт']));
    if (unsure) {
      parts.push(unsure + ' ' + root.UI.plural(unsure, ['карта осталась', 'карты остались', 'карт осталось'])
        + ' под вопросом — добавь вручную');
    }
    if (!n) parts.push('карты вижу, но не читаю — снимай ровнее и ближе');
    root.App.setScanNote(parts.join(' · '));
  }

  function init() {
    $('btnScan').addEventListener('click', open);
    $('camClose').addEventListener('click', close);
    $('camShutter').addEventListener('click', shoot);
    $('camRetake').addEventListener('click', retake);
    $('camApply').addEventListener('click', apply);
  }

  root.Scanner = {
    open, close, shoot, retake, apply, init,
    capture, findCards, scan, readCard, layoutOf,
    state: st,
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);

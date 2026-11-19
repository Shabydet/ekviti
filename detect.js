/*!
 * detect.js — поиск игральных карт на кадре стола.
 *
 * Самостоятельный модуль, без зависимостей: чистый JS + типизированные массивы.
 * Порт poker/ios/dev/tools/cards_detect.py (641 строка) с сохранением поведения:
 * те же константы, тот же порядок шагов, те же фильтры и score.
 *
 * API:
 *   globalThis.CardDetect.findCards(imageData) -> [ {x, y, w, h, quad, score, ...} ]
 *     imageData = {data: Uint8ClampedArray|Uint8Array (RGBA), width, height}
 *     x, y, w, h — в координатах ПЕРЕДАННОГО изображения;
 *     quad — [[x,y] x4] по часовой: TL, TR, BR, BL (тоже в координатах входа);
 *     score — 0..1, как в Python.
 *
 * Пайплайн (как в Python):
 *   1) уменьшение кадра до 1600 px по длинной стороне точной реализацией
 *      Pillow LANCZOS (Resample.c) и размытие точной реализацией
 *      GaussianBlur(radius=1) (BoxBlur.c: 3 прохода box-фильтра с дробным
 *      радиусом) — бит-в-бит как PIL, это нужно для совпадения масок;
 *   2) «бумага»: ярче локального фона (box 161) на PEAK_MIN, почти без
 *      насыщенности, выше адаптивного порога-перцентиля; два прохода порога;
 *   3) заливка замкнутых дырок (символы) в маске бумаги;
 *   4) «толстая бумага» k=11 как якорь;
 *   5) подрезка якоря по протяжённости, рекурсивное разделение по узким
 *      провалам профиля (2 уровня); если блок заметно шире одной карты, а
 *      провала нет — разрез ищется по геометрии (splitPair): берём то
 *      положение шва, где ОБЕ половины проходят все фильтры сами;
 *   6) фильтры: площадь, пропорции, доля бумаги, чернила, углы, контраст;
 *   7) score и дедупликация по IoU.
 *
 * Замер (кадр 1920x2560 RGBA, только findCards, после разогрева JIT):
 *   Node 24.21 / V8 13.6 (тот же движок, что в Chrome):
 *     медиана 242 мс, мин 237, макс 299 (15 прогонов; холодный первый ~330 мс);
 *     разрез слипшейся пары (splitPair) стоит 0-2 мс — в пределах шума замеров;
 *   Chrome 157 headless, кадр 1920x2560, нарисованный на canvas:
 *     медиана 244 мс, макс 279, первый холодный вызов 344 мс (DONE 5/5).
 *   Бюджет 400 мс выполняется с запасом; самый дорогой этап — LANCZOS (~145 мс),
 *   дальше blur ~35 мс, две маски/склейка ~90 мс. Редкие паузы GC дают
 *   выбросы до ~360 мс на отдельных прогонах.
 *   Замеры: dev/tools/detect_parity.mjs --bench 15, dev/detect-test.html.
 */
(function (root) {
  'use strict';

  // --- параметры: 1:1 с cards_detect.py ------------------------------------
  var MAX_SIDE = 1600;
  var BLUR_RADIUS = 1.0;        // GaussianBlur(radius=1) в PIL ≈ σ=1
  var BG_K = 161;
  var PEAK_MIN = 14.0;
  var MAX_SAT = 95.0;
  var THR_PCT_LOW = 86.0;
  var THR_PCT_HIGH = 93.0;
  var THR_MIN = 110.0;
  var THR_MAX = 205.0;

  var CARD_ASPECT = 0.70;
  var MIN_AREA_FRAC = 0.00030;
  var MAX_AREA_FRAC = 0.120;
  var ASPECT_MIN = 0.40;
  var ASPECT_MAX = 1.08;
  var TRIM_REL = 0.75;
  var VALLEY_REL = 0.68;
  var VALLEY_MAX_W = 0.25;
  var SPLIT_DEPTH = 2;
  // слипшаяся пара карт вплотную: 2 x 0.70 = 1.4 плюс запас на наклон и перспективу
  var PAIR_MAX_ASPECT = 2.30;
  var PAIR_CUT_MIN = 0.28;   // где (в долях ширины блока) может проходить шов
  var PAIR_CUT_MAX = 0.72;
  var SEAM_MAX_FILL = 0.85;  // доля «бумаги» в столбце шва (внутри карты — 1.0)
  var SEAM_WIN = 5;          // окно поиска «восстановления» бумаги по бокам шва
  var SEAM_RECOVER = 0.10;   // насколько бумага должна восстановиться сбоку
  var FILL_MIN = 0.42;
  var INK_MIN = 0.008;
  var INK_MAX = 0.55;
  var MAX_DARK = 0.45;
  var CONTRAST_MIN = 0.12;
  var RED_OK = 0.12;
  var CORNER_MIN = 0.40;
  var MIN_SCORE = 0.55;
  // согласованность размера: рамка уже самой крупной в кадре во столько раз —
  // это не карта, а мелкий элемент интерфейса
  var MIN_REL_W = 0.45;

  // --- мелкие утилиты -------------------------------------------------------

  function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }

  // Python round(): половина — к чётному. Координаты/размеры считаются так же.
  function pyRound(v) {
    var f = Math.floor(v);
    var d = v - f;
    if (d > 0.5) return f + 1;
    if (d < 0.5) return f;
    return (f & 1) ? f + 1 : f;
  }

  function round1(v) { return Math.round(v * 10) / 10; }
  function round4(v) { return Math.round(v * 10000) / 10000; }

  // k-я порядковая статистика (3-way quickselect, без аллокаций и рекурсии).
  function selectK(a, n, k) {
    var left = 0, right = n - 1;
    for (var guard = 0; guard < 200; guard++) {
      if (left >= right) return a[left];
      var mid = (left + right) >> 1;
      var x = a[left], y = a[mid], z = a[right];
      // медиана трёх как опорный элемент
      var pv = (x < y) ? ((y < z) ? y : (x < z ? z : x))
                       : ((x < z) ? x : (y < z ? z : y));
      var i = left, lt = left, gt = right, t;
      while (i <= gt) {
        var v = a[i];
        if (v < pv) { t = a[i]; a[i] = a[lt]; a[lt] = t; i++; lt++; }
        else if (v > pv) { t = a[i]; a[i] = a[gt]; a[gt] = t; gt--; }
        else i++;
      }
      if (k < lt) right = lt - 1;
      else if (k <= gt) return pv;
      else left = gt + 1;
    }
    return a[k < 0 ? 0 : (k >= n ? n - 1 : k)];
  }

  // np.percentile(..., 'linear'): интерполяция между двумя порядковыми.
  function percentileCopy(src, n, p) {
    if (n <= 0) return 0;
    if (n === 1) return src[0];
    var a = src.slice(0, n);
    var rank = (n - 1) * p / 100;
    var lo = Math.floor(rank), hi = Math.ceil(rank);
    var vlo = selectK(a, n, lo);
    if (lo === hi) return vlo;
    var vhi = selectK(a, n, hi);
    return vlo + (vhi - vlo) * (rank - lo);
  }

  // малые массивы (профили/протяжённости): сортировка дешевле выборки
  function percentileSmall(src, n, p) {
    if (n <= 0) return 0;
    if (n === 1) return src[0];
    var a = src.slice(0, n);
    a.sort();
    var rank = (n - 1) * p / 100;
    var lo = Math.floor(rank), hi = Math.ceil(rank);
    if (lo === hi) return a[lo];
    return a[lo] + (a[hi] - a[lo]) * (rank - lo);
  }

  // --- шаг 1: уменьшение кадра ---------------------------------------------
  // Точный перенос Pillow LANCZOS (src/libImaging/Resample.c): фильтр
  // Lanczos3 с support=3*filterscale, коэффициенты нормализуются и
  // квантуются в INT32 с 22 битами точности, свёртка целочисленная:
  //   ss = 2^21 + Σ p*k;  out = clamp(ss >> 22).
  // Результат бит-в-бит совпадает с PIL (проверено: Δ=0 на 5.76 млн значений).
  // Более дешёвый area-box пробовался — он даёт расхождения в масках и ломает
  // паритет на 2 из 5 чистых снимков, поэтому оставлен точный LANCZOS.

  function sincFilter(x) {
    if (x === 0) return 1;
    var p = Math.PI * x;
    return Math.sin(p) / p;
  }
  function lanczosFilter(x) {
    if (x > -3.0 && x < 3.0) return sincFilter(x) * sincFilter(x / 3.0);
    return 0.0;
  }

  // Веса ресемплинга по одной оси: старт, количество, INT32-коэффициенты.
  function resampleWeights(inSize, outSize) {
    var scale = inSize / outSize;
    var filterscale = scale < 1.0 ? 1.0 : scale;
    var support = 3.0 * filterscale;
    var ksize = Math.ceil(support) * 2 + 1;
    var inv = 1.0 / filterscale;
    var bounds = new Int32Array(outSize * 2);
    var cnt = new Int32Array(outSize);
    var pre = new Float64Array(outSize * ksize);
    var xx, x;
    for (xx = 0; xx < outSize; xx++) {
      var center = (xx + 0.5) * scale;
      var xmin = Math.trunc(center - support + 0.5);
      if (xmin < 0) xmin = 0;
      var xmax = Math.trunc(center + support + 0.5);
      if (xmax > inSize) xmax = inSize;
      xmax -= xmin;
      var k = xx * ksize, sum = 0;
      for (x = 0; x < xmax; x++) {
        var w = lanczosFilter((x + xmin - center + 0.5) * inv);
        pre[k + x] = w;
        sum += w;
      }
      if (sum !== 0) for (x = 0; x < xmax; x++) pre[k + x] /= sum;
      bounds[xx * 2] = xmin;
      bounds[xx * 2 + 1] = xmax;
      cnt[xx] = xmax;
    }
    // квантование коэффициентов: int(±0.5 + w * 2^22) (Pillow normalize_coeffs_8bpc)
    var kk = new Int32Array(outSize * ksize);
    for (x = 0; x < outSize * ksize; x++) {
      var v = pre[x] * 4194304;
      kk[x] = v < 0 ? Math.trunc(-0.5 + v) : Math.trunc(0.5 + v);
    }
    return { ksize: ksize, bounds: bounds, cnt: cnt, kk: kk };
  }

  // RGBA -> RGB с уменьшением до dw x dh.
  function resizeRGB(data, sw, sh, dw, dh) {
    if (sw === dw && sh === dh) {
      var out0 = new Uint8Array(dw * dh * 3);
      for (var q = 0, o0 = 0; q < sw * sh; q++, o0 += 4) {
        out0[q * 3] = data[o0];
        out0[q * 3 + 1] = data[o0 + 1];
        out0[q * 3 + 2] = data[o0 + 2];
      }
      return out0;
    }
    var X = resampleWeights(sw, dw);
    var Y = resampleWeights(sh, dh);
    var tmp = new Uint8Array(sh * dw * 3);
    var y, xx, t, xmin, cn, kk, ss0, ss1, ss2, p, o, c;
    // горизонтальный проход
    for (y = 0; y < sh; y++) {
      var rowBase = y * sw * 4;
      for (xx = 0; xx < dw; xx++) {
        xmin = X.bounds[xx * 2];
        cn = X.cnt[xx];
        kk = xx * X.ksize;
        ss0 = ss1 = ss2 = 2097152;
        for (t = 0; t < cn; t++) {
          p = rowBase + (xmin + t) * 4;
          c = X.kk[kk + t];
          ss0 += data[p] * c;
          ss1 += data[p + 1] * c;
          ss2 += data[p + 2] * c;
        }
        o = (y * dw + xx) * 3;
        ss0 >>= 22; ss1 >>= 22; ss2 >>= 22;
        tmp[o] = ss0 < 0 ? 0 : (ss0 > 255 ? 255 : ss0);
        tmp[o + 1] = ss1 < 0 ? 0 : (ss1 > 255 ? 255 : ss1);
        tmp[o + 2] = ss2 < 0 ? 0 : (ss2 > 255 ? 255 : ss2);
      }
    }
    // вертикальный проход: аккумулятор на строку выхода
    var out = new Uint8Array(dw * dh * 3);
    var acc = new Float64Array(dw * 3);
    for (y = 0; y < dh; y++) {
      var ymin = Y.bounds[y * 2];
      var cnY = Y.cnt[y];
      var kkY = y * Y.ksize;
      acc.fill(0);
      for (t = 0; t < cnY; t++) {
        var kt = Y.kk[kkY + t];
        var src = (ymin + t) * dw * 3;
        for (var i = 0, m = dw * 3; i < m; i++) acc[i] += tmp[src + i] * kt;
      }
      var dst = y * dw * 3;
      for (i = 0, m = dw * 3; i < m; i++) {
        var vv = Math.floor((acc[i] + 2097152) / 4194304);
        out[dst + i] = vv < 0 ? 0 : (vv > 255 ? 255 : vv);
      }
    }
    return out;
  }

  // Пороги по целочисленному серому (после размытия gray — целые 0..255, как в
  // Python): точный перцентиль через гистограмму, O(N + 256) вместо выборки.
  function grayThresholds(gray, n) {
    var hist = new Int32Array(256);
    var i;
    for (i = 0; i < n; i++) hist[gray[i] | 0]++;

    function histValue(k) {
      var acc = 0;
      for (var v = 0; v < 256; v++) { acc += hist[v]; if (acc > k) return v; }
      return 255;
    }
    function pct(p) {
      var rank = (n - 1) * p / 100;
      var lo = Math.floor(rank), hi = Math.ceil(rank);
      var vlo = histValue(lo);
      if (hi === lo) return vlo;
      var vhi = histValue(hi);
      return vlo + (vhi - vlo) * (rank - lo);
    }
    return [
      clamp(pct(THR_PCT_LOW), THR_MIN, THR_MAX),
      clamp(pct(THR_PCT_HIGH), THR_MIN, THR_MAX)
    ];
  }

  // --- шаг 1b: серый + насыщенность (float32, как numpy) -------------------

  var F_R = Math.fround(0.299), F_G = Math.fround(0.587), F_B = Math.fround(0.114);

  function graySat(rgb, n) {
    var gray = new Float32Array(n);
    var sat = new Uint8Array(n);
    for (var i = 0, o = 0; i < n; i++, o += 3) {
      var r = rgb[o], g = rgb[o + 1], b = rgb[o + 2];
      // numpy: float32 * float32 и float32-сложения — повторяем через fround
      var y = Math.fround(Math.fround(Math.fround(r * F_R) + Math.fround(g * F_G))
                          + Math.fround(b * F_B));
      gray[i] = y;
      var mx = r > g ? (r > b ? r : b) : (g > b ? g : b);
      var mn = r < g ? (r < b ? r : b) : (g < b ? g : b);
      sat[i] = mx - mn;
    }
    return { gray: gray, sat: sat };
  }

  // --- шаг 1c: GaussianBlur(radius=1) ---------------------------------------
  // Точно как Pillow (src/libImaging/BoxBlur.c: ImagingGaussianBlur →
  // ImagingBoxBlur с passes=3): радиус превращается в дробный радиус box-фильтра
  // (_gaussian_blur_radius), затем 3 горизонтальных и 3 вертикальных прохода
  // фильтра [fw, ww, fw] в целочисленной арифметике с округлением
  // (bulk + 2^23) >> 24. Для radius=1: дробный радиус 0.25, ww=11184810,
  // fw=2796203 — это [1,4,1]/6-подобное ядро, три прохода дают гауссиану σ≈1.
  // Реализовано 1:1, чтобы маски совпадали с Python (проверено: Δ=0).

  function gaussBlurRadius(radius, passes) {
    var sigma2 = radius * radius / passes;
    var L = Math.sqrt(12.0 * sigma2 + 1.0);
    var l = Math.floor((L - 1.0) / 2.0);
    var a = (2 * l + 1) * (l * (l + 1) - 3 * sigma2);
    a /= 6 * (sigma2 - (l + 1) * (l + 1));
    return l + a;
  }

  var HALF24 = 8388608;

  // Частный случай ir=0 (наш radius=1 даёт именно его): ядро [fw, ww, fw].
  // Те же операции и то же округление, что в общем цикле выше, но без
  // бухгалтерии acc — втрое меньше обращений к памяти.
  function boxBlurH0(inp, out, b, n, ww, fw) {
    if (n === 1) { out[b] = (inp[b] * ww + 2 * inp[b] * fw + HALF24) >>> 24; return; }
    var i = b, l = inp[i], c = inp[i], r = inp[i + 1];
    out[i] = (c * ww + (l + r) * fw + HALF24) >>> 24;
    for (var x = 1; x < n - 1; x++) {
      l = c; c = r; r = inp[i + x + 1];
      out[i + x] = (c * ww + (l + r) * fw + HALF24) >>> 24;
    }
    out[i + n - 1] = (r * ww + (c + r) * fw + HALF24) >>> 24;
  }

  function boxBlurV0(inp, out, b, n, w, ww, fw) {
    if (n === 1) { out[b] = (inp[b] * ww + 2 * inp[b] * fw + HALF24) >>> 24; return; }
    var l = inp[b], c = inp[b], r = inp[b + w];
    out[b] = (c * ww + (l + r) * fw + HALF24) >>> 24;
    for (var x = 1; x < n - 1; x++) {
      l = c; c = r; r = inp[b + (x + 1) * w];
      out[b + x * w] = (c * ww + (l + r) * fw + HALF24) >>> 24;
    }
    out[b + (n - 1) * w] = (r * ww + (c + r) * fw + HALF24) >>> 24;
  }
  // Горизонтальная строка: точный ImagingLineBoxBlur8.
  function boxBlurH(inp, out, b, n, ir, ww, fw) {
    var last = n - 1;
    var edgeA = Math.min(ir + 1, n);
    var edgeB = Math.max(n - ir - 1, 0);
    var acc, bulk, x;
    acc = inp[b] * (ir + 1);
    for (x = 0; x < edgeA - 1; x++) acc += inp[b + x];
    acc += inp[b + last] * (ir - edgeA + 1);
    if (edgeA <= edgeB) {
      for (x = 0; x < edgeA; x++) {
        acc += inp[b + x + ir] - inp[b];
        bulk = acc * ww + (inp[b] + inp[b + x + ir + 1]) * fw;
        out[b + x] = (bulk + HALF24) >>> 24;
      }
      for (; x < edgeB; x++) {
        acc += inp[b + x + ir] - inp[b + x - ir - 1];
        bulk = acc * ww + (inp[b + x - ir - 1] + inp[b + x + ir + 1]) * fw;
        out[b + x] = (bulk + HALF24) >>> 24;
      }
      for (; x <= last; x++) {
        acc += inp[b + last] - inp[b + x - ir - 1];
        bulk = acc * ww + (inp[b + x - ir - 1] + inp[b + last]) * fw;
        out[b + x] = (bulk + HALF24) >>> 24;
      }
    } else {
      for (x = 0; x < edgeB; x++) {
        acc += inp[b + x + ir] - inp[b];
        bulk = acc * ww + (inp[b] + inp[b + x + ir + 1]) * fw;
        out[b + x] = (bulk + HALF24) >>> 24;
      }
      for (; x < edgeA; x++) {
        acc += inp[b + last] - inp[b];
        bulk = acc * ww + (inp[b] + inp[b + last]) * fw;
        out[b + x] = (bulk + HALF24) >>> 24;
      }
      for (; x <= last; x++) {
        acc += inp[b + last] - inp[b + x - ir - 1];
        bulk = acc * ww + (inp[b + x - ir - 1] + inp[b + last]) * fw;
        out[b + x] = (bulk + HALF24) >>> 24;
      }
    }
  }

  // Вертикальный столбец (то же, шаг w).
  function boxBlurV(inp, out, b, n, w, ir, ww, fw) {
    var last = n - 1;
    var edgeA = Math.min(ir + 1, n);
    var edgeB = Math.max(n - ir - 1, 0);
    var acc, bulk, x;
    acc = inp[b] * (ir + 1);
    for (x = 0; x < edgeA - 1; x++) acc += inp[b + x * w];
    acc += inp[b + last * w] * (ir - edgeA + 1);
    if (edgeA <= edgeB) {
      for (x = 0; x < edgeA; x++) {
        acc += inp[b + (x + ir) * w] - inp[b];
        bulk = acc * ww + (inp[b] + inp[b + (x + ir + 1) * w]) * fw;
        out[b + x * w] = (bulk + HALF24) >>> 24;
      }
      for (; x < edgeB; x++) {
        acc += inp[b + (x + ir) * w] - inp[b + (x - ir - 1) * w];
        bulk = acc * ww + (inp[b + (x - ir - 1) * w] + inp[b + (x + ir + 1) * w]) * fw;
        out[b + x * w] = (bulk + HALF24) >>> 24;
      }
      for (; x <= last; x++) {
        acc += inp[b + last * w] - inp[b + (x - ir - 1) * w];
        bulk = acc * ww + (inp[b + (x - ir - 1) * w] + inp[b + last * w]) * fw;
        out[b + x * w] = (bulk + HALF24) >>> 24;
      }
    } else {
      for (x = 0; x < edgeB; x++) {
        acc += inp[b + (x + ir) * w] - inp[b];
        bulk = acc * ww + (inp[b] + inp[b + (x + ir + 1) * w]) * fw;
        out[b + x * w] = (bulk + HALF24) >>> 24;
      }
      for (; x < edgeA; x++) {
        acc += inp[b + last * w] - inp[b];
        bulk = acc * ww + (inp[b] + inp[b + last * w]) * fw;
        out[b + x * w] = (bulk + HALF24) >>> 24;
      }
      for (; x <= last; x++) {
        acc += inp[b + last * w] - inp[b + (x - ir - 1) * w];
        bulk = acc * ww + (inp[b + (x - ir - 1) * w] + inp[b + last * w]) * fw;
        out[b + x * w] = (bulk + HALF24) >>> 24;
      }
    }
  }

  function gaussBlurU8(g8, w, h, radius) {
    if (!(radius > 0)) return g8;
    var fr = gaussBlurRadius(radius, 3);
    var ir = Math.trunc(fr);
    // В C это float-арифметика: (UINT32)(1<<24) / (floatRadius*2+1).
    // Для radius=1: 16777216f / 1.5f = 11184811 (округление float32),
    // fw = (16777216 - 11184811) / 2 = 2796202. Наивный double расчёт
    // даёт 11184810/2796203 и systematic +1 к яркости после 6 проходов.
    var ww = Math.trunc(Math.fround(16777216 / Math.fround(fr * 2 + 1)));
    var fw = Math.trunc((16777216 - (ir * 2 + 1) * ww) / 2);
    var n = w * h;
    var tmp = new Uint8Array(n);
    var p, x, y;
    var fast = (ir === 0);
    // 3 горизонтальных прохода
    for (p = 0; p < 3; p++) {
      if (fast) for (y = 0; y < h; y++) boxBlurH0(g8, tmp, y * w, w, ww, fw);
      else for (y = 0; y < h; y++) boxBlurH(g8, tmp, y * w, w, ir, ww, fw);
      g8.set(tmp);
    }
    // 3 вертикальных прохода (в Pillow — то же через транспонирование)
    for (p = 0; p < 3; p++) {
      if (fast) for (x = 0; x < w; x++) boxBlurV0(g8, tmp, x, h, w, ww, fw);
      else for (x = 0; x < w; x++) boxBlurV(g8, tmp, x, h, w, ir, ww, fw);
      g8.set(tmp);
    }
    return g8;
  }

  // --- box-mean произвольного окна (сепарабельно, скользящие суммы) --------
  // Окно центрировано на пикселе, за кадром — нули (как np.pad(..., 0)).
  // Делим всегда на k*k, поэтому у краёв среднее занижено — как в Python.
  // Суммы целые и укладываются в 2^24, поэтому float32-накопление точное и
  // результат совпадает с интегральным вариантом (проверено паритетом).

  function boxMeanInto(src, w, h, k, out) {
    var r = k >> 1;
    var inv = 1 / (k * k);
    var colAcc = new Int32Array(w);
    var rowBuf = new Float32Array(w);
    var x, y;
    var top = Math.min(r, h - 1);
    for (y = 0; y <= top; y++) {
      var b0 = y * w;
      for (x = 0; x < w; x++) colAcc[x] += src[b0 + x];
    }
    for (y = 0; y < h; y++) {
      var base = y * w;
      var s = 0;
      var right = Math.min(r, w - 1);
      for (x = 0; x <= right; x++) s += colAcc[x];
      rowBuf[0] = s * inv;
      for (x = 1; x < w; x++) {
        var add = x + r, sub = x - r - 1;
        if (add < w) s += colAcc[add];
        if (sub >= 0) s -= colAcc[sub];
        rowBuf[x] = s * inv;
      }
      for (x = 0; x < w; x++) out[base + x] = rowBuf[x];
      var addRow = y + r + 1, subRow = y - r;
      if (addRow < h) { var b1 = addRow * w; for (x = 0; x < w; x++) colAcc[x] += src[b1 + x]; }
      if (subRow >= 0) { var b2 = subRow * w; for (x = 0; x < w; x++) colAcc[x] -= src[b2 + x]; }
    }
  }

  // --- шаг 2: маска «бумаги» -----------------------------------------------
  // m = (gray >= thr) & (peak >= 14) & (sat <= 95); затем среднее 3x3 >= 0.5
  // (то есть в окне 3x3 минимум 5 «бумажных» пикселей).

  function paperMask(gray, sat, peak, w, h, thr) {
    var n = w * h;
    var m = new Uint8Array(n);
    var i;
    for (i = 0; i < n; i++) {
      m[i] = (gray[i] >= thr && peak[i] >= PEAK_MIN && sat[i] <= MAX_SAT) ? 1 : 0;
    }
    var out = new Uint8Array(n);
    var colSum = new Int32Array(w);
    var y, x;
    var yTop = Math.min(1, h - 1);
    for (y = 0; y <= yTop; y++) {
      var b0 = y * w;
      for (x = 0; x < w; x++) colSum[x] += m[b0 + x];
    }
    var xTop = Math.min(1, w - 1);
    for (y = 0; y < h; y++) {
      var base = y * w;
      var s = 0;
      for (x = 0; x <= xTop; x++) s += colSum[x];
      for (x = 0; x < w; x++) {
        if (x > 0) {
          var add = x + 1, sub = x - 2;
          if (add < w) s += colSum[add];
          if (sub >= 0) s -= colSum[sub];
        }
        out[base + x] = (s * 2 >= 9) ? 1 : 0;
      }
      var addRow = y + 2, subRow = y - 1;
      if (addRow < h) { var b2 = addRow * w; for (x = 0; x < w; x++) colSum[x] += m[b2 + x]; }
      if (subRow >= 0) { var b3 = subRow * w; for (x = 0; x < w; x++) colSum[x] -= m[b3 + x]; }
    }
    return out;
  }

  // --- run-length / union-find по строкам (8-связность) --------------------

  function growArr(a, n) {
    var b = new Int32Array(n);
    b.set(a.subarray(0, Math.min(a.length, n)));
    return b;
  }

  // --- шаг 3: заливка замкнутых дырок --------------------------------------

  function fillHoles(mask, w, h, maxArea) {
    var cap = Math.max(1024, w * 4);
    var rx0 = new Int32Array(cap), rx1 = new Int32Array(cap);
    var rrid = new Int32Array(cap), parent = new Int32Array(cap);
    var nRuns = 0;
    var rowStart = new Int32Array(h + 1);
    var x, y;

    function ensure(need) {
      if (need <= cap) return;
      var nc = cap;
      while (nc < need) nc <<= 1;
      rx0 = growArr(rx0, nc); rx1 = growArr(rx1, nc);
      rrid = growArr(rrid, nc); parent = growArr(parent, nc);
      cap = nc;
    }
    function find(a) {
      while (parent[a] !== a) { parent[a] = parent[parent[a]]; a = parent[a]; }
      return a;
    }
    function union(a, b) {
      var ra = find(a), rb = find(b);
      if (ra !== rb) parent[rb] = ra;
    }

    var prevS = 0, prevE = 0;
    for (y = 0; y < h; y++) {
      rowStart[y] = nRuns;
      var base = y * w;
      x = 0;
      while (x < w) {
        if (mask[base + x] !== 0) { x++; continue; }
        var s0 = x;
        while (x < w && mask[base + x] === 0) x++;
        var e0 = x - 1;
        ensure(nRuns + 1);
        var rid = nRuns++;
        rx0[rid] = s0; rx1[rid] = e0; rrid[rid] = rid; parent[rid] = rid;
        while (prevS < prevE && rx1[prevS] < s0 - 1) prevS++;
        for (var k = prevS; k < prevE && rx0[k] <= e0 + 1; k++) union(rid, rrid[k]);
      }
      prevS = rowStart[y]; prevE = nRuns;
    }
    rowStart[h] = nRuns;
    if (nRuns === 0) return mask;

    var area = new Int32Array(nRuns);
    var bx0 = new Int32Array(nRuns), bx1 = new Int32Array(nRuns);
    var by0 = new Int32Array(nRuns), by1 = new Int32Array(nRuns);
    var border = new Uint8Array(nRuns);
    bx0.fill(-1); by0.fill(-1);

    for (y = 0; y < h; y++) {
      var s = rowStart[y], e = rowStart[y + 1];
      for (var i = s; i < e; i++) {
        var r = find(rrid[i]);
        var a0 = rx0[i], a1 = rx1[i];
        area[r] += a1 - a0 + 1;
        if (bx0[r] < 0) { bx0[r] = a0; by0[r] = y; }
        else if (a0 < bx0[r]) bx0[r] = a0;
        if (a1 > bx1[r]) bx1[r] = a1;
        by1[r] = y;
        if (a0 === 0 || a1 === w - 1 || y === 0 || y === h - 1) border[r] = 1;
      }
    }

    var out = mask.slice();
    for (y = 0; y < h; y++) {
      var s2 = rowStart[y], e2 = rowStart[y + 1];
      for (var j = s2; j < e2; j++) {
        var r2 = find(rrid[j]);
        if (border[r2]) continue;
        if (maxArea && area[r2] > maxArea) continue;
        var bw = bx1[r2] - bx0[r2] + 1;
        var bh = by1[r2] - by0[r2] + 1;
        // вытянутые щели — стыки карт/полос, их не заливаем
        if ((bw > bh ? bw : bh) > 4 * ((bw > bh ? bh : bw) || 1)) continue;
        var rowb = y * w;
        out.fill(1, rowb + rx0[j], rowb + rx1[j] + 1);
      }
    }
    return out;
  }

  // --- шаг 4: «толстая бумага» k=11 ----------------------------------------
  // mean по 11 (вертикально и горизонтально) >= 0.80, то есть >= 9 из 11.

  function thickMask(filled, w, h) {
    var n = w * h;
    var v = new Uint8Array(n);
    var colSum = new Int32Array(w);
    var x, y, i;
    var yTop = Math.min(5, h - 1);
    for (y = 0; y <= yTop; y++) {
      var b0 = y * w;
      for (x = 0; x < w; x++) colSum[x] += filled[b0 + x];
    }
    for (y = 0; y < h; y++) {
      var base = y * w;
      for (x = 0; x < w; x++) v[base + x] = colSum[x] >= 9 ? 1 : 0;
      var addRow = y + 6, subRow = y - 5;
      if (addRow < h) { var b1 = addRow * w; for (x = 0; x < w; x++) colSum[x] += filled[b1 + x]; }
      if (subRow >= 0) { var b2 = subRow * w; for (x = 0; x < w; x++) colSum[x] -= filled[b2 + x]; }
    }
    var out = new Uint8Array(n);
    var xTop = Math.min(5, w - 1);
    for (y = 0; y < h; y++) {
      var row = y * w;
      var s = 0;
      for (i = 0; i <= xTop; i++) s += filled[row + i];
      out[row] = (v[row] && s >= 9) ? 1 : 0;
      for (x = 1; x < w; x++) {
        var add = x + 5, sub = x - 6;
        if (add < w) s += filled[row + add];
        if (sub >= 0) s -= filled[row + sub];
        out[row + x] = (v[row + x] && s >= 9) ? 1 : 0;
      }
    }
    return out;
  }

  // --- компоненты маски (bbox + area) --------------------------------------

  function components(mask, w, h) {
    var cap = Math.max(1024, w * 4);
    var rx0 = new Int32Array(cap), rx1 = new Int32Array(cap);
    var rrid = new Int32Array(cap), parent = new Int32Array(cap);
    var nRuns = 0;
    var rowStart = new Int32Array(h + 1);
    var x, y;

    function ensure(need) {
      if (need <= cap) return;
      var nc = cap;
      while (nc < need) nc <<= 1;
      rx0 = growArr(rx0, nc); rx1 = growArr(rx1, nc);
      rrid = growArr(rrid, nc); parent = growArr(parent, nc);
      cap = nc;
    }
    function find(a) {
      while (parent[a] !== a) { parent[a] = parent[parent[a]]; a = parent[a]; }
      return a;
    }
    function union(a, b) {
      var ra = find(a), rb = find(b);
      if (ra !== rb) parent[rb] = ra;
    }

    var prevS = 0, prevE = 0;
    for (y = 0; y < h; y++) {
      rowStart[y] = nRuns;
      var base = y * w;
      x = 0;
      while (x < w) {
        if (mask[base + x] === 0) { x++; continue; }
        var s0 = x;
        while (x < w && mask[base + x] !== 0) x++;
        var e0 = x - 1;
        ensure(nRuns + 1);
        var rid = nRuns++;
        rx0[rid] = s0; rx1[rid] = e0; rrid[rid] = rid; parent[rid] = rid;
        while (prevS < prevE && rx1[prevS] < s0 - 1) prevS++;
        for (var k = prevS; k < prevE && rx0[k] <= e0 + 1; k++) union(rid, rrid[k]);
      }
      prevS = rowStart[y]; prevE = nRuns;
    }
    rowStart[h] = nRuns;
    if (nRuns === 0) return [];

    var area = new Int32Array(nRuns);
    var bx0 = new Int32Array(nRuns), bx1 = new Int32Array(nRuns);
    var by0 = new Int32Array(nRuns), by1 = new Int32Array(nRuns);
    bx0.fill(-1); by0.fill(-1);

    for (y = 0; y < h; y++) {
      var s = rowStart[y], e = rowStart[y + 1];
      for (var i = s; i < e; i++) {
        var r = find(rrid[i]);
        var a0 = rx0[i], a1 = rx1[i];
        area[r] += a1 - a0 + 1;
        if (bx0[r] < 0) { bx0[r] = a0; by0[r] = y; }
        else if (a0 < bx0[r]) bx0[r] = a0;
        if (a1 > bx1[r]) bx1[r] = a1;
        by1[r] = y;
      }
    }

    var out = [];
    for (var q = 0; q < nRuns; q++) {
      if (parent[q] === q && area[q] > 0) {
        out.push({ x0: bx0[q], y0: by0[q], x1: bx1[q], y1: by1[q], area: area[q] });
      }
    }
    return out;
  }

  // --- шаг 5: подрезка по протяжённости ------------------------------------

  function trimDense(mask, w, bx0, by0, bx1, by1) {
    var x, y, i;
    var minX = -1, minY = -1, maxX = -1, maxY = -1;
    for (y = by0; y <= by1; y++) {
      var b = y * w;
      for (x = bx0; x <= bx1; x++) {
        if (mask[b + x]) {
          if (minX < 0) { minX = x; minY = y; }
          else if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          maxY = y;
        }
      }
    }
    if (minX < 0) return null;
    var x0 = minX, y0 = minY, x1 = maxX, y1 = maxY;

    var ext = new Float32Array(Math.max(by1 - by0 + 1, bx1 - bx0 + 1));
    var any = new Uint8Array(ext.length);

    for (var it = 0; it < 3; it++) {
      var nRows = y1 - y0 + 1, nCols = x1 - x0 + 1;
      if (nRows <= 0 || nCols <= 0) return null;

      var cnt = 0, hit = false;
      for (var yy = 0; yy < nRows; yy++) {
        var rowb = (y0 + yy) * w;
        var first = -1, last = -1;
        for (var xx = x0; xx <= x1; xx++) {
          if (mask[rowb + xx]) { if (first < 0) first = xx - x0; last = xx - x0; }
        }
        if (first >= 0) { any[yy] = 1; ext[yy] = last - first + 1; cnt++; hit = true; }
        else { any[yy] = 0; ext[yy] = nCols; }
      }
      if (!hit) return null;

      var vals = new Float32Array(cnt), kk = 0;
      for (yy = 0; yy < nRows; yy++) if (any[yy]) vals[kk++] = ext[yy];
      var thrR = TRIM_REL * percentileSmall(vals, cnt, 85);

      var moved = false, iLo = 0, iHi = nRows - 1;
      while (y1 > y0 && (!any[iLo] || ext[iLo] < thrR)) { y0++; iLo++; moved = true; }
      while (y1 > y0 && (!any[iHi] || ext[iHi] < thrR)) { y1--; iHi--; moved = true; }
      if (moved) continue;

      var nRows2 = y1 - y0 + 1, nCols2 = x1 - x0 + 1;
      var cntC = 0, hitC = false;
      for (var xc = 0; xc < nCols2; xc++) {
        var firstc = -1, lastc = -1;
        for (var yc = 0; yc < nRows2; yc++) {
          if (mask[(y0 + yc) * w + (x0 + xc)]) {
            if (firstc < 0) firstc = yc;
            lastc = yc;
          }
        }
        if (firstc >= 0) { any[xc] = 1; ext[xc] = lastc - firstc + 1; cntC++; hitC = true; }
        else { any[xc] = 0; ext[xc] = nRows2; }
      }
      if (!hitC) return null;

      var valsC = new Float32Array(cntC), kc = 0;
      for (xc = 0; xc < nCols2; xc++) if (any[xc]) valsC[kc++] = ext[xc];
      var thrC = TRIM_REL * percentileSmall(valsC, cntC, 85);

      var movedC = false, jLo = 0, jHi = nCols2 - 1;
      while (x1 > x0 && (!any[jLo] || ext[jLo] < thrC)) { x0++; jLo++; movedC = true; }
      while (x1 > x0 && (!any[jHi] || ext[jHi] < thrC)) { x1--; jHi--; movedC = true; }
      if (!movedC) break;
    }
    if (x1 <= x0 || y1 <= y0) return null;
    return [x0, y0, x1, y1];
  }

  // --- узкие провалы 1D-профиля --------------------------------------------

  function valleys(prof, n) {
    if (n < 16) return null;
    var med = percentileSmall(prof, n, 50);
    if (med <= 0) return null;
    var lowThr = VALLEY_REL * med;
    var maxW = Math.max(2, Math.floor(VALLEY_MAX_W * n));
    var out = [];
    var i = 0;
    while (i < n) {
      if (prof[i] < lowThr) {
        var j = i;
        while (j < n && prof[j] < lowThr) j++;
        var wd = j - i;
        if (wd <= maxW && i >= 0.15 * n && j <= 0.85 * n + 1 && i > 0 && j < n) {
          out.push(i, j);
        }
        i = j;
      } else i++;
    }
    return out.length ? out : null;
  }

  // --- метрики прямоугольника-кандидата ------------------------------------

  function cardStats(rgb, gray, filled, w, h, x0, y0, x1, y1) {
    var ww = x1 - x0 + 1, hh = y1 - y0 + 1;
    if (ww < 8 || hh < 8) return null;
    var my = Math.max(1, (hh * 0.10) | 0);
    var mx = Math.max(1, (ww * 0.10) | 0);
    var iy0 = y0 + my, iy1 = y1 - my, ix0 = x0 + mx, ix1 = x1 - mx;
    var ih = iy1 - iy0 + 1, iw = ix1 - ix0 + 1;
    if (ih <= 0 || iw <= 0 || ih * iw < 25) return null;

    var hist = new Int32Array(256);
    var y, x, i, total = 0;
    for (y = iy0; y <= iy1; y++) {
      var b = y * w;
      for (x = ix0; x <= ix1; x++) { hist[gray[b + x] | 0]++; total++; }
    }

    function histAt(k) {
      var acc = 0, v;
      for (v = 0; v < 256; v++) { acc += hist[v]; if (acc > k) return v; }
      return 255;
    }
    var rank50 = (total - 1) * 0.5;
    var lo50 = Math.floor(rank50), hi50 = Math.ceil(rank50);
    var bright = histAt(lo50);
    if (hi50 !== lo50) bright = bright + (histAt(hi50) - bright) * (rank50 - lo50);

    var inkThr = clamp(bright * 0.62, 60.0, 165.0);
    var p10rank = (total - 1) * 0.10;
    var lo10 = Math.floor(p10rank), hi10 = Math.ceil(p10rank);
    var p10 = histAt(lo10);
    if (hi10 !== lo10) p10 = p10 + (histAt(hi10) - p10) * (p10rank - lo10);

    // чернила = тёмное ИЛИ красное (объединение, не сумма)
    var nDark = 0, nRed = 0, nInk = 0;
    for (y = iy0; y <= iy1; y++) {
      var b2 = y * w;
      for (x = ix0; x <= ix1; x++) {
        var oi = (b2 + x) * 3;
        var r = rgb[oi], g = rgb[oi + 1], bb = rgb[oi + 2];
        var isRed = (r - (g + bb) * 0.5) > 40;
        var isDark = gray[b2 + x] < inkThr;
        if (isRed) nRed++;
        if (isDark) nDark++;
        if (isRed || isDark) nInk++;
      }
    }
    var ink = nInk / total;

    var cy = Math.max(2, (hh * 0.22) | 0);
    var cx = Math.max(2, (ww * 0.22) | 0);
    var c0 = 0, c1 = 0, c2 = 0, c3 = 0, cnt = cy * cx;
    for (y = 0; y < cy; y++) {
      var bt = (y0 + y) * w;
      var bb2 = (y1 - y) * w;
      for (x = 0; x < cx; x++) {
        c0 += filled[bt + x0 + x];
        c1 += filled[bt + x1 - x];
        c2 += filled[bb2 + x0 + x];
        c3 += filled[bb2 + x1 - x];
      }
    }
    var cm0 = c0 / cnt, cm1 = c1 / cnt, cm2 = c2 / cnt, cm3 = c3 / cnt;
    var cornerMean = (cm0 + cm1 + cm2 + cm3) / 4;
    var cornerMin = Math.min(cm0, cm1, cm2, cm3);

    return {
      bright: bright,
      ink: ink,
      red: nRed / total,
      dark: nDark / total,
      contrast: (bright - p10) / Math.max(1.0, bright),
      corner_min: cornerMin,
      corner_mean: cornerMean
    };
  }

  // --- quad по маске -------------------------------------------------------

  function quadFromMask(mask, w, x0, y0, x1, y1, invScale) {
    var minS = Infinity, maxS = -Infinity, minD = Infinity, maxD = -Infinity;
    var pMinSx = 0, pMinSy = 0, pMaxSx = 0, pMaxSy = 0;
    var pMaxDx = 0, pMaxDy = 0, pMinDx = 0, pMinDy = 0;
    var cnt = 0, y, x;
    for (y = y0; y <= y1; y++) {
      var b = y * w;
      for (x = x0; x <= x1; x++) {
        if (!mask[b + x]) continue;
        cnt++;
        var s = x + y, d = x - y;
        if (s < minS) { minS = s; pMinSx = x; pMinSy = y; }
        if (s > maxS) { maxS = s; pMaxSx = x; pMaxSy = y; }
        if (d > maxD) { maxD = d; pMaxDx = x; pMaxDy = y; }
        if (d < minD) { minD = d; pMinDx = x; pMinDy = y; }
      }
    }
    var qx, qy;
    if (cnt >= 8) {
      qx = [pMinSx, pMaxDx, pMaxSx, pMinDx];
      qy = [pMinSy, pMaxDy, pMaxSy, pMinDy];
    } else {
      qx = [x0, x1, x1, x0];
      qy = [y0, y0, y1, y1];
    }
    // площадь четырёхугольника (шнурок) в координатах рабочего кадра;
    // в Python площадь считается уже после умножения на inv_scale, поэтому
    // сравнение с 0.45*ww*hh эквивалентно (inv_scale² сокращается).
    var area = 0;
    for (var i = 0; i < 4; i++) {
      var j = (i + 1) & 3;
      area += qx[i] * qy[j] - qy[i] * qx[j];
    }
    area = 0.5 * Math.abs(area);
    var ww = x1 - x0 + 1, hh = y1 - y0 + 1;
    var q;
    if (area < 0.45 * ww * hh) {
      q = [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
    } else {
      q = [[qx[0], qy[0]], [qx[1], qy[1]], [qx[2], qy[2]], [qx[3], qy[3]]];
    }
    var out = new Array(4);
    for (var t = 0; t < 4; t++) {
      out[t] = [round1(q[t][0] * invScale), round1(q[t][1] * invScale)];
    }
    return out;
  }

  // --- IoU по (x, y, w, h) -------------------------------------------------

  function iou(a, b) {
    var ix0 = Math.max(a[0], b[0]), iy0 = Math.max(a[1], b[1]);
    var ix1 = Math.min(a[0] + a[2], b[0] + b[2]);
    var iy1 = Math.min(a[1] + a[3], b[1] + b[3]);
    var iw = ix1 - ix0, ih = iy1 - iy0;
    if (iw <= 0 || ih <= 0) return 0;
    var inter = iw * ih;
    return inter / (a[2] * a[3] + b[2] * b[3] - inter);
  }

  // --- кандидаты из одной маски --------------------------------------------

  function candidateBoxes(gray, paper, filled, rgb, w, h, invScale, thr, out) {
    var imgArea = w * h;
    var minArea = MIN_AREA_FRAC * imgArea;
    var maxArea = MAX_AREA_FRAC * imgArea;

    /** Все фильтры для одного прямоугольника: кандидат или null. */
    function acceptBox(box) {
      var x0 = box[0], y0 = box[1], x1 = box[2], y1 = box[3];
      var ww = x1 - x0 + 1, hh = y1 - y0 + 1;
      var area = ww * hh;
      if (area < minArea || area > maxArea) return null;
      var aspect = ww / hh;
      if (!(aspect >= ASPECT_MIN && aspect <= ASPECT_MAX)) return null;

      var sum = 0, y, x;
      for (y = y0; y <= y1; y++) {
        var b = y * w;
        for (x = x0; x <= x1; x++) sum += filled[b + x];
      }
      var fill = sum / area;
      if (fill < FILL_MIN) return null;

      var st = cardStats(rgb, gray, filled, w, h, x0, y0, x1, y1);
      if (!st) return null;
      if (st.corner_mean < CORNER_MIN) return null;
      if (!(st.ink >= INK_MIN && st.ink <= INK_MAX)) return null;
      if (st.dark > MAX_DARK) return null;
      if (st.contrast < CONTRAST_MIN && st.red < RED_OK) return null;

      var quad = quadFromMask(filled, w, x0, y0, x1, y1, invScale);

      var aspScore = Math.max(0, 1 - Math.abs(Math.log(aspect / CARD_ASPECT)) / Math.log(1.6));
      var inkScore = Math.max(0, 1 - Math.abs(st.ink - 0.18) / 0.40);
      var conScore = Math.min(1, st.contrast / 0.35);
      var score = 0.34 * aspScore + 0.26 * fill + 0.20 * inkScore + 0.20 * conScore;
      if (score < MIN_SCORE) return null;

      return {
        x: pyRound(x0 * invScale), y: pyRound(y0 * invScale),
        w: pyRound(ww * invScale), h: pyRound(hh * invScale),
        quad: quad, score: round4(score),
        ink: Math.round(st.ink * 1000) / 1000,
        red: Math.round(st.red * 1000) / 1000,
        dark: Math.round(st.dark * 1000) / 1000,
        contrast: Math.round(st.contrast * 1000) / 1000,
        corner: Math.round(st.corner_mean * 1000) / 1000,
        fill: Math.round(fill * 1000) / 1000,
        aspect: Math.round(aspect * 1000) / 1000,
        thr: Math.round(thr * 10) / 10
      };
    }

    function evaluate(box) {
      var c = acceptBox(box);
      if (c) out.push(c);
    }

    /**
     * Разрез слипшейся пары карт «по геометрии».
     *
     * Две карты, стоящие вплотную, дают один блок шириной ~2 карты (aspect ~1.4),
     * и он не проходит фильтр пропорций. Разделить его по провалу профиля можно
     * только пока шов строго вертикальный и достаточно контрастный: щель между
     * картами — 2-3 px, после размытия она даёт провал глубиной 20-30 % от
     * локального уровня, что ниже порога VALLEY_REL (32 % от медианы профиля,
     * а медиану «тянет вниз» тёмный рисунок на самих картах). Любой поворот
     * кадра размазывает щель на 2-3 колонки, и провал исчезает.
     *
     * Поэтому, если блок заведомо шире одной карты, положение шва ищем перебором.
     * Годятся только разрезы, где:
     *   - в столбце разреза сплошная маска «бумаги» проваливается: внутри карты
     *     после заливки дырок она сплошная (1.0), а в щели между картами — нет;
     *   - провал узкий: по обе стороны от него бумага снова сплошная (у края
     *     панели интерфейса провал «широкий и плоский», восстановления нет);
     *   - каждая половина сама по себе проходит все фильтры (площадь, пропорции,
     *     доля бумаги, чернила, углы, контраст, score) — ложный разрез по символу
     *     отбраковывается сам: половинки выходят слишком узкими.
     *
     * Из годных разрезов берём тот, у которого лучше худшая из половин.
     * Возвращает {left, right, score} или null. Время: ~60 положений, на каждом
     * два набора фильтров — единицы миллисекунд на блок.
     */
    function splitPair(box) {
      var x0 = box[0], y0 = box[1], x1 = box[2], y1 = box[3];
      var ww = x1 - x0 + 1, hh = y1 - y0 + 1;
      var aspect = ww / hh;
      if (!(aspect > ASPECT_MAX && aspect <= PAIR_MAX_ASPECT)) return null;
      if (ww < 24 || hh < 24) return null;

      // доля «бумаги» по столбцу: в щели между картами она заметно меньше 1.
      // Считаем целым счётчиком (а не float), чтобы сравнение с порогом было
      // бит-в-бит таким же, как в Python-эталоне.
      var colFill = new Int32Array(ww);
      var cx, cy;
      for (cx = 0; cx < ww; cx++) {
        var s = 0;
        for (cy = 0; cy < hh; cy++) s += filled[(y0 + cy) * w + (x0 + cx)];
        colFill[cx] = s;
      }

      var cutA = Math.max(2, Math.floor(PAIR_CUT_MIN * ww));
      var cutB = Math.min(ww - 2, Math.ceil(PAIR_CUT_MAX * ww));
      var best = null;
      for (var cut = cutA; cut <= cutB; cut++) {
        var seam = colFill[cut - 1] < colFill[cut] ? colFill[cut - 1] : colFill[cut];
        if (seam / hh > SEAM_MAX_FILL) continue;
        // шов — именно узкий провал: по обе стороны от него бумага снова
        // сплошная. У края сплошной области (панель интерфейса, край картинки)
        // провал «широкий и плоский» и восстановления нет.
        var lmax = 0, rmax = 0, k;
        for (k = Math.max(0, cut - 1 - SEAM_WIN); k <= cut - 2; k++) {
          if (colFill[k] > lmax) lmax = colFill[k];
        }
        for (k = cut + 1; k <= Math.min(ww - 1, cut + SEAM_WIN); k++) {
          if (colFill[k] > rmax) rmax = colFill[k];
        }
        if (lmax - seam < SEAM_RECOVER * hh) continue;
        if (rmax - seam < SEAM_RECOVER * hh) continue;
        var l = acceptBox([x0, y0, x0 + cut - 1, y1]);
        if (!l) continue;
        var r = acceptBox([x0 + cut, y0, x1, y1]);
        if (!r) continue;
        var sc = l.score < r.score ? l.score : r.score;
        if (!best || sc > best.score) {
          best = { score: sc, left: [x0, y0, x0 + cut - 1, y1], right: [x0 + cut, y0, x1, y1] };
        }
      }
      return best;
    }

    function trimBox(box) {
      var x0 = box[0], y0 = box[1], x1 = box[2], y1 = box[3];
      // trimDense работает в абсолютных координатах кадра
      var t = trimDense(filled, w, x0, y0, x1, y1);
      if (!t) return null;
      if ((t[2] - t[0] + 1) < 0.45 * (x1 - x0 + 1)) return null;
      if ((t[3] - t[1] + 1) < 0.45 * (y1 - y0 + 1)) return null;
      return t;
    }

    var thick = thickMask(filled, w, h);
    var seeds = components(thick, w, h);
    var stack = [];
    var pad = 4, i;
    for (i = 0; i < seeds.length; i++) {
      var c = seeds[i];
      var cw = c.x1 - c.x0 + 1, ch = c.y1 - c.y0 + 1;
      if (cw * ch < 0.4 * minArea) continue;
      stack.push(Math.max(0, c.x0 - pad), Math.max(0, c.y0 - pad),
                 Math.min(w - 1, c.x1 + pad), Math.min(h - 1, c.y1 + pad), 0);
    }
    if (!stack.length) {
      // запасной путь: «толстых» якорей нет (сильно размытый кадр)
      var comps = components(paper, w, h);
      for (i = 0; i < comps.length; i++) {
        var c2 = comps[i];
        var cw2 = c2.x1 - c2.x0 + 1, ch2 = c2.y1 - c2.y0 + 1;
        if (cw2 * ch2 < 0.5 * minArea) continue;
        stack.push(c2.x0, c2.y0, c2.x1, c2.y1, 0);
      }
    }

    while (stack.length) {
      var depth = stack.pop();
      var by1 = stack.pop(), bx1 = stack.pop();
      var by0 = stack.pop(), bx0 = stack.pop();
      var box = trimBox([bx0, by0, bx1, by1]);
      if (!box) continue;
      evaluate(box);
      if (depth >= SPLIT_DEPTH) continue;
      var qx0 = box[0], qy0 = box[1], qx1 = box[2], qy1 = box[3];
      var ww2 = qx1 - qx0 + 1, hh2 = qy1 - qy0 + 1;
      if (ww2 < 24 || hh2 < 24) continue;

      // Блок шире одной карты: сначала пробуем разрез слипшейся пары по
      // геометрии (см. splitPair). Он надёжнее профиля: не зависит от того,
      // насколько контрастным остался шов после поворота и размытия.
      var pair = splitPair(box);
      if (pair) {
        stack.push(pair.left[0], pair.left[1], pair.left[2], pair.left[3], depth + 1);
        stack.push(pair.right[0], pair.right[1], pair.right[2], pair.right[3], depth + 1);
        continue;
      }

      // профили: доля бумаги по столбцу и средняя яркость / 255
      var profX = new Float32Array(ww2);
      var x, y;
      for (x = 0; x < ww2; x++) {
        var sp = 0, sg = 0;
        for (y = 0; y < hh2; y++) {
          var idx = (qy0 + y) * w + (qx0 + x);
          sp += paper[idx]; sg += gray[idx];
        }
        profX[x] = 0.5 * (sp / hh2 + (sg / hh2) / 255.0);
      }
      // ВАЖНО (совместимость с эталоном): в cards_detect.py профиль по Y
      // считается как np.mean([sub.mean(axis=1), ...], axis=1); от матрицы
      // (2, n) это массив ДЛИНЫ 2, а _valleys требует n >= 16. То есть в
      // Python вертикальные разрезы фактически никогда не срабатывают.
      // Повторяем как есть: иначе порт режет карты на куски и находит
      // «лишние карты» там, где эталон их не видит.
      var cutsX = valleys(profX, ww2);
      if (cutsX) {
        var prev = 0;
        for (i = 0; i < cutsX.length; i += 2) {
          var s = cutsX[i], e = cutsX[i + 1];
          if (s - prev >= 8) stack.push(qx0 + prev, qy0, qx0 + s - 1, qy1, depth + 1);
          prev = e;
        }
        if (ww2 - prev >= 8) stack.push(qx0 + prev, qy0, qx1, qy1, depth + 1);
      }
    }
  }

  // --- главный вход --------------------------------------------------------

  function findCards(imageData) {
    if (!imageData || !imageData.data) return [];
    var sw = imageData.width | 0, sh = imageData.height | 0;
    if (sw <= 0 || sh <= 0) return [];
    var data = imageData.data;

    // 1) уменьшение до MAX_SIDE по длинной стороне
    var fitScale = Math.min(1.0, MAX_SIDE / Math.max(sw, sh));
    var w = sw, h = sh;
    if (fitScale < 0.999) {
      w = Math.max(1, pyRound(sw * fitScale));
      h = Math.max(1, pyRound(sh * fitScale));
    }
    var invScale = sw / w;
    var rgb = resizeRGB(data, sw, sh, w, h);
    var n = w * h;

    // 2) серый + насыщенность + размытие
    // В Python: gray(float32) -> clip+astype(uint8) [усечение] -> GaussianBlur
    // (8 бит, алгоритм Pillow) -> float32. Всё квантование повторено 1:1.
    var gs = graySat(rgb, n);
    var sat = gs.sat;
    var gray = new Float32Array(n);
    var g8 = new Uint8Array(n);
    for (var i = 0; i < n; i++) {
      var gv = clamp(Math.floor(gs.gray[i]), 0, 255);
      g8[i] = gv;
      gray[i] = gv;
    }
    if (BLUR_RADIUS > 0) {
      gaussBlurU8(g8, w, h, BLUR_RADIUS);
      for (i = 0; i < n; i++) gray[i] = g8[i];
    }
    g8 = null;

    // 3) локальный фон (box 161) и «пик» над фоном
    var peak = new Float32Array(n);
    boxMeanInto(gray, w, h, BG_K, peak);
    for (var i = 0; i < n; i++) peak[i] = gray[i] - peak[i];

    var found = [];
    var thrs = grayThresholds(gray, n);
    for (var pi = 0; pi < 2; pi++) {
      var thr = thrs[pi];
      var paper = paperMask(gray, sat, peak, w, h, thr);
      var any = false;
      for (i = 0; i < n; i++) if (paper[i]) { any = true; break; }
      if (!any) continue;
      var filled = fillHoles(paper, w, h, (0.002 * n) | 0);
      candidateBoxes(gray, paper, filled, rgb, w, h, invScale, thr, found);
    }

    // 4) дедупликация по IoU и сортировка по (y, x)
    found.sort(function (a, b) { return b.score - a.score; });
    var keep = [];
    for (i = 0; i < found.length; i++) {
      var c = found[i];
      var box = [c.x, c.y, c.w, c.h];
      var ok = true;
      for (var j = 0; j < keep.length; j++) {
        var kb = [keep[j].x, keep[j].y, keep[j].w, keep[j].h];
        if (iou(box, kb) >= 0.35) { ok = false; break; }
      }
      if (ok) keep.push(c);
    }
    // 5) согласованность размера: карты на столе одного размера, а мелкие
    // яркие элементы интерфейса (кнопки, цифры банка) проходят общие фильтры.
    if (keep.length > 1) {
      var widest = 0;
      for (i = 0; i < keep.length; i++) if (keep[i].w > widest) widest = keep[i].w;
      var minW = MIN_REL_W * widest;
      var tight = [];
      for (i = 0; i < keep.length; i++) if (keep[i].w >= minW) tight.push(keep[i]);
      keep = tight;
    }
    return orderCards(keep);
  }

  // Порядок карт: сверху вниз по рядам, внутри ряда — слева направо.
  // Сортировка по (y, x) на фото под углом перемешивает ряд: у карт одного
  // ряда y отличается на несколько пикселей, и они уходят в обратном порядке.
  function orderCards(cards) {
    if (!cards.length) return [];
    var hs = cards.map(function (c) { return c.h; }).sort(function (a, b) { return a - b; });
    var tol = 0.5 * hs[(hs.length - 1) >> 1];
    var sorted = cards.slice().sort(function (a, b) {
      return (a.y + a.h / 2) - (b.y + b.h / 2);
    });
    var rows = [];
    for (var i = 0; i < sorted.length; i++) {
      var c = sorted[i];
      var cy = c.y + c.h / 2;
      var row = rows.length ? rows[rows.length - 1] : null;
      if (row && Math.abs(cy - row.cy) <= tol) {
        row.items.push(c);
        var sum = 0;
        for (var k = 0; k < row.items.length; k++) sum += row.items[k].y + row.items[k].h / 2;
        row.cy = sum / row.items.length;
        continue;
      }
      rows.push({ cy: cy, items: [c] });
    }
    var out = [];
    for (var r = 0; r < rows.length; r++) {
      var items = rows[r].items.slice().sort(function (a, b) { return a.x - b.x; });
      for (var m = 0; m < items.length; m++) out.push(items[m]);
    }
    return out;
  }

  root.CardDetect = {
    findCards: findCards,
    // отладочные кишки для паритет-тестов (не для продакшена)
    _dbg: {
      resizeRGB: resizeRGB,
      graySat: graySat,
      gaussBlur: gaussBlurU8,
      boxMeanK: boxMeanInto,
      paperMask: paperMask,
      fillHoles: fillHoles,
      thickMask: thickMask,
      components: components,
      trimDense: trimDense,
      candidateBoxes: candidateBoxes,
      percentileCopy: percentileCopy,
      consts: {
        MAX_SIDE: MAX_SIDE, BG_K: BG_K, PEAK_MIN: PEAK_MIN, MAX_SAT: MAX_SAT,
        THR_PCT_LOW: THR_PCT_LOW, THR_PCT_HIGH: THR_PCT_HIGH,
        THR_MIN: THR_MIN, THR_MAX: THR_MAX
      }
    }
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);

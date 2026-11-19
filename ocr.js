/* OCR карт PokerDom на клиенте: порт dev/tools/card_ocr.py (numpy -> JS).
 *
 * Вход: кроп карты (RGBA ImageData-подобный объект), кроп всегда одной карты.
 * Выход: {rank, suit, card, rankScore, suitScore, rankMargin, suitMargin,
 *         needConfirm, reason, rankScores, suitScores}
 *
 * Алгоритм повторяет питоновский один-в-один: «чернильность» (тёмное ИЛИ
 * красное), зоны в долях ширины карты, компоненты связности с отсечением
 * прилипших к границе, нормализация в 28x28 и IoU с допуском сдвига ±1 px.
 */
(function (global) {
  'use strict';

  var SIZE = 28;
  var PAD = 2;
  var DARK_LUM = 140;
  var RED_EXCESS = 45;
  var INK_THR = 0.5;

  var RANK_WIN = [0.040, 0.035, 0.460, 0.550];
  var SUIT_WIN = [0.040, 0.530, 0.460, 0.950];

  /* ---------- шаблоны ---------- */

  function b64ToBytes(b64) {
    var bin = global.atob(b64);
    var out = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  function unpackMask(b64, size) {
    var bytes = b64ToBytes(b64);
    var n = size * size;
    var out = new Uint8Array(n);
    for (var i = 0; i < n; i++) {
      var byte = bytes[i >> 3];
      out[i] = (byte >> (7 - (i & 7))) & 1;
    }
    return out;
  }

  var templates = null;

  function buildTemplates(spec) {
    var size = spec.size || SIZE;
    var cards = spec.cards.map(function (c) {
      return {
        card: c.card,
        rank: c.rank,
        suit: c.suit,
        r: unpackMask(c.r, size),
        s: unpackMask(c.s, size)
      };
    });
    return {
      size: size,
      pad: spec.pad,
      rankWin: spec.rank_win,
      suitWin: spec.suit_win,
      darkLum: spec.dark_lum,
      redExcess: spec.red_excess,
      cards: cards
    };
  }

  function ensureTemplates() {
    if (!templates) {
      if (!global.OCR_TPL) throw new Error('OCR_TPL не загружен');
      templates = buildTemplates(global.OCR_TPL);
      SIZE = templates.size;
      PAD = templates.pad;
      DARK_LUM = templates.darkLum;
      RED_EXCESS = templates.redExcess;
      RANK_WIN = templates.rankWin;
      SUIT_WIN = templates.suitWin;
    }
    return templates;
  }

  /* ---------- «чернила» ---------- */

  function inknessAt(r, g, b) {
    var lum = 0.299 * r + 0.587 * g + 0.114 * b;
    var dark = Math.min(1, Math.max(0, (DARK_LUM + 20 - lum) / 60));
    var excess = r - (g + b) / 2;
    var red = 0;
    if (excess > RED_EXCESS) red = Math.min(1, Math.max(0, (excess - RED_EXCESS) / 40 + 0.5));
    return dark > red ? dark : red;
  }

  /** RGBA -> Float32Array «чернильности» размером w*h. */
  function inkness(rgba, w, h) {
    var out = new Float32Array(w * h);
    for (var i = 0, p = 0; i < out.length; i++, p += 4) {
      out[i] = inknessAt(rgba[p], rgba[p + 1], rgba[p + 2]);
    }
    return out;
  }

  /* ---------- зоны ---------- */

  function zonePx(cardW, cardH, rel) {
    var x0 = Math.max(0, Math.min(cardW - 1, Math.round(rel[0] * cardW)));
    var x1 = Math.max(x0 + 1, Math.min(cardW, Math.round(rel[2] * cardW)));
    var y0 = Math.max(0, Math.min(cardH - 1, Math.round(rel[1] * cardW)));
    var y1 = Math.max(y0 + 1, Math.min(cardH, Math.round(rel[3] * cardW)));
    return [x0, y0, x1, y1];
  }

  /* ---------- компоненты связности (8-связность по строкам) ---------- */

  function components(mask, w, h, minArea) {
    minArea = minArea || 8;
    var parent = new Int32Array(w * h + 8);
    var next = 0;
    function find(x) {
      while (parent[x] !== x) {
        parent[x] = parent[parent[x]];
        x = parent[x];
      }
      return x;
    }
    function union(a, b) {
      var ra = find(a), rb = find(b);
      if (ra !== rb) parent[rb] = ra;
    }

    var prev = [];
    var rows = [];
    for (var y = 0; y < h; y++) {
      var runs = [];
      var x = 0;
      while (x < w) {
        if (mask[y * w + x]) {
          var x0 = x;
          while (x < w && mask[y * w + x]) x++;
          var id = next++;
          parent[id] = id;
          runs.push([x0, x - 1, id]);
          for (var k = 0; k < prev.length; k++) {
            var pr = prev[k];
            if (x0 <= pr[1] + 1 && pr[0] <= x - 2 + 1) union(id, pr[2]);
          }
        } else {
          x++;
        }
      }
      prev = runs;
      rows.push(runs);
    }

    var boxes = {};
    for (var yy = 0; yy < rows.length; yy++) {
      var rr = rows[yy];
      for (var i = 0; i < rr.length; i++) {
        var r0 = find(rr[i][2]);
        var b = boxes[r0];
        if (!b) {
          boxes[r0] = [rr[i][0], yy, rr[i][1], yy];
        } else {
          if (rr[i][0] < b[0]) b[0] = rr[i][0];
          if (rr[i][1] > b[2]) b[2] = rr[i][1];
          b[3] = yy;
        }
      }
    }

    var out = [];
    for (var key in boxes) {
      if (!Object.prototype.hasOwnProperty.call(boxes, key)) continue;
      var bx = boxes[key];
      var area = 0;
      for (var y2 = bx[1]; y2 <= bx[3]; y2++) {
        for (var x2 = bx[0]; x2 <= bx[2]; x2++) {
          if (mask[y2 * w + x2]) area++;
        }
      }
      if (area >= minArea) out.push([bx[0], bx[1], bx[2], bx[3], area]);
    }
    return out;
  }

  /* ---------- нормализация глифа ---------- */

  /** Уменьшение/увеличение серого изображения с усреднением по площади (близко к LANCZOS при downscale). */
  function resizeGray(src, w, h, nw, nh) {
    var out = new Float32Array(nw * nh);
    var sx = w / nw;
    var sy = h / nh;
    for (var y = 0; y < nh; y++) {
      var y0 = y * sy;
      var y1 = Math.min(h, (y + 1) * sy);
      for (var x = 0; x < nw; x++) {
        var x0 = x * sx;
        var x1 = Math.min(w, (x + 1) * sx);
        var sum = 0, cnt = 0;
        for (var yy = Math.floor(y0); yy < Math.max(Math.floor(y0) + 1, Math.ceil(y1)); yy++) {
          if (yy >= h) break;
          var wy = Math.min(yy + 1, y1) - Math.max(yy, y0);
          if (wy <= 0) continue;
          for (var xx = Math.floor(x0); xx < Math.max(Math.floor(x0) + 1, Math.ceil(x1)); xx++) {
            if (xx >= w) break;
            var wx = Math.min(xx + 1, x1) - Math.max(xx, x0);
            if (wx <= 0) continue;
            sum += src[yy * w + xx] * wx * wy;
            cnt += wx * wy;
          }
        }
        out[y * nw + x] = cnt > 0 ? sum / cnt : 0;
      }
    }
    return out;
  }

  function normalize(ink, w, h, meta) {
    var x0 = -1, y0 = -1, x1 = -1, y1 = -1;
    for (var y = 0; y < h; y++) {
      for (var x = 0; x < w; x++) {
        if (ink[y * w + x] > INK_THR) {
          if (x0 < 0 || x < x0) x0 = x;
          if (x1 < 0 || x > x1) x1 = x;
          if (y0 < 0) y0 = y;
          y1 = y;
        }
      }
    }
    if (x0 < 0) {
      if (meta) { meta.empty = true; meta.bbox = null; meta.wh = [0, 0]; meta.aspect = 0; }
      return new Uint8Array(SIZE * SIZE);
    }
    var sw = x1 - x0 + 1;
    var sh = y1 - y0 + 1;
    var sub = new Float32Array(sw * sh);
    for (var yy = 0; yy < sh; yy++) {
      for (var xx = 0; xx < sw; xx++) {
        sub[yy * sw + xx] = ink[(y0 + yy) * w + (x0 + xx)];
      }
    }
    var inner = SIZE - 2 * PAD;
    var scale = inner / Math.max(sh, sw);
    var nw = Math.max(1, Math.round(sw * scale));
    var nh = Math.max(1, Math.round(sh * scale));
    var small = resizeGray(sub, sw, sh, nw, nh);
    var out = new Uint8Array(SIZE * SIZE);
    var ox = (SIZE - nw) >> 1;
    var oy = (SIZE - nh) >> 1;
    for (var ny = 0; ny < nh; ny++) {
      for (var nx = 0; nx < nw; nx++) {
        if (small[ny * nw + nx] * 255 >= 128) out[(oy + ny) * SIZE + (ox + nx)] = 1;
      }
    }
    if (meta) {
      meta.empty = false;
      meta.bbox = [x0, y0, x1, y1];
      meta.wh = [sw, sh];
      meta.aspect = Math.round((sw / sh) * 1000) / 1000;
      meta.scale = Math.round(scale * 1000) / 1000;
    }
    return out;
  }

  function glyphFromZone(inkFull, w, h, rel) {
    var z = zonePx(w, h, rel);
    var zx0 = z[0], zy0 = z[1], zx1 = z[2], zy1 = z[3];
    var zw = zx1 - zx0;
    var zh = zy1 - zy0;
    var ink = new Float32Array(zw * zh);
    for (var y = 0; y < zh; y++) {
      for (var x = 0; x < zw; x++) {
        ink[y * zw + x] = inkFull[(zy0 + y) * w + (zx0 + x)];
      }
    }
    var mask = new Uint8Array(zw * zh);
    for (var i = 0; i < mask.length; i++) mask[i] = ink[i] > INK_THR ? 1 : 0;

    var comps = components(mask, zw, zh, 8);
    var keep = comps.filter(function (c) {
      return c[0] > 0 && c[1] > 0 && c[2] < zw - 1 && c[3] < zh - 1;
    });
    if (!keep.length) keep = comps;
    if (keep.length) {
      var hmax = 0;
      for (var k = 0; k < keep.length; k++) hmax = Math.max(hmax, keep[k][3] - keep[k][1] + 1);
      var tall = keep.filter(function (c) { return (c[3] - c[1] + 1) >= 0.55 * hmax; });
      if (tall.length) keep = tall;
      var m = new Uint8Array(zw * zh);
      for (var j = 0; j < keep.length; j++) {
        var c = keep[j];
        for (var yy = c[1]; yy <= c[3]; yy++) {
          for (var xx = c[0]; xx <= c[2]; xx++) {
            if (ink[yy * zw + xx] > INK_THR) m[yy * zw + xx] = 1;
          }
        }
      }
      for (var t = 0; t < ink.length; t++) {
        if (!m[t]) ink[t] = 0;
      }
    }
    var meta = { zone: z, nComps: comps.length, nKept: keep.length };
    var glyph = normalize(ink, zw, zh, meta);
    return { glyph: glyph, meta: meta };
  }

  /* ---------- сравнение ---------- */

  function iou(a, b) {
    var inter = 0, union = 0;
    for (var i = 0; i < a.length; i++) {
      var x = a[i], y = b[i];
      if (x && y) inter++;
      if (x || y) union++;
    }
    return union ? inter / union : 0;
  }

  function shifted(a, dy, dx) {
    var out = new Uint8Array(SIZE * SIZE);
    for (var y = 0; y < SIZE; y++) {
      var sy = y - dy;
      if (sy < 0 || sy >= SIZE) continue;
      for (var x = 0; x < SIZE; x++) {
        var sx = x - dx;
        if (sx < 0 || sx >= SIZE) continue;
        out[y * SIZE + x] = a[sy * SIZE + sx];
      }
    }
    return out;
  }

  function iouShift(a, b, r) {
    r = r || 1;
    var best = 0;
    for (var dy = -r; dy <= r; dy++) {
      for (var dx = -r; dx <= r; dx++) {
        var v = iou(shifted(a, dy, dx), b);
        if (v > best) best = v;
      }
    }
    return best;
  }

  function classScores(glyph, key) {
    var tpl = ensureTemplates();
    var per = {};
    for (var i = 0; i < tpl.cards.length; i++) {
      var t = tpl.cards[i];
      var s = iouShift(glyph, t[key], 1);
      (per[t[key === 'r' ? 'rank' : 'suit']] = per[t[key === 'r' ? 'rank' : 'suit']] || []).push(s);
    }
    var out = [];
    for (var lab in per) {
      if (!Object.prototype.hasOwnProperty.call(per, lab)) continue;
      var vals = per[lab];
      var sum = 0;
      for (var k = 0; k < vals.length; k++) sum += vals[k];
      out.push([sum / vals.length, lab]);
    }
    out.sort(function (a, b) { return b[0] - a[0]; });
    return out;
  }

  /* ---------- выпрямление карты (perspective warp) ---------- */

  /** Решает систему A*x=b методом Гаусса с выбором ведущего элемента. */
  function solve8(A, b) {
    var n = 8;
    for (var col = 0; col < n; col++) {
      var piv = col;
      for (var r = col + 1; r < n; r++) {
        if (Math.abs(A[r][col]) > Math.abs(A[piv][col])) piv = r;
      }
      if (Math.abs(A[piv][col]) < 1e-12) return null;
      if (piv !== col) {
        var tmp = A[piv]; A[piv] = A[col]; A[col] = tmp;
        var tb = b[piv]; b[piv] = b[col]; b[col] = tb;
      }
      for (var r2 = col + 1; r2 < n; r2++) {
        var f = A[r2][col] / A[col][col];
        if (!f) continue;
        for (var c2 = col; c2 < n; c2++) A[r2][c2] -= f * A[col][c2];
        b[r2] -= f * b[col];
      }
    }
    var x = new Float64Array(n);
    for (var i = n - 1; i >= 0; i--) {
      var s = b[i];
      for (var j = i + 1; j < n; j++) s -= A[i][j] * x[j];
      x[i] = s / A[i][i];
    }
    return x;
  }

  /** Гомография по 4 парам точек (из -> в). Возвращает [a..h,g] или null. */
  function homography(src, dst) {
    var A = [], b = [];
    for (var i = 0; i < 4; i++) {
      var x = src[i][0], y = src[i][1], u = dst[i][0], v = dst[i][1];
      A.push([x, y, 1, 0, 0, 0, -x * u, -y * u]); b.push(u);
      A.push([0, 0, 0, x, y, 1, -x * v, -y * v]); b.push(v);
    }
    return solve8(A, b);
  }

  /**
   * Выпрямляет карту по её четырём углам в прямоугольник outW x outH.
   * @param {{data:*,width:number,height:number}} img исходный кадр (RGBA)
   * @param {Array} quad [[TL],[TR],[BR],[BL]] в пикселях кадра
   * @param {number} outW
   * @param {number} outH
   * @returns {{data: Uint8ClampedArray, width:number, height:number}}
   */
  function warp(img, quad, outW, outH) {
    outW = Math.round(outW || 232);
    outH = Math.round(outH || 332);
    var dst = [[0, 0], [outW - 1, 0], [outW - 1, outH - 1], [0, outH - 1]];
    var h = homography(dst, quad);   // из координат результата в координаты кадра
    if (!h) throw new Error('не смогла построить гомографию карты');
    var out = new Uint8ClampedArray(outW * outH * 4);
    var sw = img.width, sh = img.height, sd = img.data;
    for (var y = 0; y < outH; y++) {
      for (var x = 0; x < outW; x++) {
        var den = h[6] * x + h[7] * y + 1;
        var sx = (h[0] * x + h[1] * y + h[2]) / den;
        var sy = (h[3] * x + h[4] * y + h[5]) / den;
        var o = (y * outW + x) * 4;
        if (sx < 0 || sy < 0 || sx > sw - 1 || sy > sh - 1) {
          out[o] = out[o + 1] = out[o + 2] = 255; out[o + 3] = 255;
          continue;
        }
        var x0 = sx | 0, y0 = sy | 0;
        var x1 = Math.min(sw - 1, x0 + 1), y1 = Math.min(sh - 1, y0 + 1);
        var fx = sx - x0, fy = sy - y0;
        var i00 = (y0 * sw + x0) * 4, i10 = (y0 * sw + x1) * 4;
        var i01 = (y1 * sw + x0) * 4, i11 = (y1 * sw + x1) * 4;
        for (var c = 0; c < 3; c++) {
          var top = sd[i00 + c] * (1 - fx) + sd[i10 + c] * fx;
          var bot = sd[i01 + c] * (1 - fx) + sd[i11 + c] * fx;
          out[o + c] = top * (1 - fy) + bot * fy;
        }
        out[o + 3] = 255;
      }
    }
    return { data: out, width: outW, height: outH };
  }

  /* ---------- распознавание кропа ---------- */

  /**
   * @param {{data: Uint8ClampedArray|Uint8Array, width: number, height: number}} crop RGBA кроп карты
   * @returns {{rank:string, suit:string, card:string, rankScore:number, suitScore:number,
   *            rankMargin:number, suitMargin:number, needConfirm:boolean, reason:string,
   *            rankScores:Array, suitScores:Array}}
   */
  function recognize(crop) {
    ensureTemplates();
    var w = crop.width, h = crop.height;
    if (!w || !h) throw new Error('пустой кроп');
    var ink = inkness(crop.data, w, h);
    var rg = glyphFromZone(ink, w, h, RANK_WIN);
    var sg = glyphFromZone(ink, w, h, SUIT_WIN);

    var rs = classScores(rg.glyph, 'r');
    var ss = classScores(sg.glyph, 's');
    var r1 = rs.length ? rs[0][0] : 0, rlab = rs.length ? rs[0][1] : '?';
    var s1 = ss.length ? ss[0][0] : 0, slab = ss.length ? ss[0][1] : '?';
    var r2 = rs.length > 1 ? rs[1][0] : 0;
    var s2 = ss.length > 1 ? ss[1][0] : 0;

    var reasons = [];
    if (r1 < 0.65) reasons.push('ранг: сходство ' + r1.toFixed(2) + ' < 0.65');
    if (r1 - r2 < 0.05) reasons.push('ранг: отрыв ' + (r1 - r2).toFixed(2) + ' < 0.05');
    if (s1 < 0.80) reasons.push('масть: сходство ' + s1.toFixed(2) + ' < 0.80');
    if (s1 - s2 < 0.06) reasons.push('масть: отрыв ' + (s1 - s2).toFixed(2) + ' < 0.06');

    return {
      rank: rlab,
      suit: slab,
      card: rlab + slab,
      rankScore: r1,
      suitScore: s1,
      rankMargin: r1 - r2,
      suitMargin: s1 - s2,
      needConfirm: reasons.length > 0,
      reason: reasons.join('; '),
      rankScores: rs,
      suitScores: ss,
      rankMeta: rg.meta,
      suitMeta: sg.meta
    };
  }

  global.CardOCR = {
    recognize: recognize,
    warp: warp,
    ensureTemplates: ensureTemplates,
    // для тестов
    _inkness: inkness,
    _iouShift: iouShift,
    _components: components,
    get templates() { return ensureTemplates(); }
  };
})(typeof window !== 'undefined' ? window : globalThis);

/* Движок NLHE-эквити. Извлечён из nlhe-calculator.html (там же остаётся единственная копия математики).
   Монте-Карло: сэмплируем руки соперников из диапазона и докатываем борд. */
(function (root) {
function createEngine(){
  'use strict';
  const RANKS = '23456789TJQKA';
  const SUITS = 'cdhs';
  const CAT = 371293;            // 13^5
  const POW13 = [28561, 2197, 169, 13, 1];

  const CNT = new Int32Array(13);
  const SCNT = new Int32Array(4);
  const FLS = new Int32Array(7);

  function cardName(c){ return RANKS[c >> 2] + SUITS[c & 3]; }
  function parseCard(s){
    if (!s || s.length < 2) return -1;
    const r = RANKS.indexOf(s[0].toUpperCase());
    const u = SUITS.indexOf(s[1].toLowerCase());
    return (r < 0 || u < 0) ? -1 : r * 4 + u;
  }
  function pack(cat, a, b, c, d, e){
    return (((((cat * 13 + a) * 13 + b) * 13 + c) * 13 + d) * 13 + e);
  }

  // Оценка 5..7 карт. Возвращает целое, больше = сильнее.
  function eval7(cards){
    const n = cards.length;
    CNT.fill(0); SCNT.fill(0);
    let rm = 0;
    for (let i = 0; i < n; i++){
      const c = cards[i], r = c >> 2;
      CNT[r]++; SCNT[c & 3]++; rm |= 1 << r;
    }

    let fs = -1;
    for (let s = 0; s < 4; s++){ if (SCNT[s] >= 5){ fs = s; break; } }

    let st = -1;
    for (let h = 12; h >= 4; h--){ const m = 0x1f << (h - 4); if ((rm & m) === m){ st = h; break; } }
    if (st < 0 && (rm & 0x100f) === 0x100f) st = 3;

    if (fs >= 0){
      let fm = 0, f = 0;
      for (let i = 0; i < n; i++){
        const c = cards[i];
        if ((c & 3) === fs){ const r = c >> 2; fm |= 1 << r; FLS[f++] = r; }
      }
      let sf = -1;
      for (let h = 12; h >= 4; h--){ const m = 0x1f << (h - 4); if ((fm & m) === m){ sf = h; break; } }
      if (sf < 0 && (fm & 0x100f) === 0x100f) sf = 3;
      if (sf >= 0){
        return pack(8, sf, Math.max(sf - 1, 0), Math.max(sf - 2, 0), Math.max(sf - 3, 0), Math.max(sf - 4, 0));
      }
      for (let i = 1; i < f; i++){
        const v = FLS[i]; let j = i - 1;
        while (j >= 0 && FLS[j] < v){ FLS[j + 1] = FLS[j]; j--; }
        FLS[j + 1] = v;
      }
      return pack(5, FLS[0], FLS[1], FLS[2], FLS[3], FLS[4]);
    }

    let p1 = -1, p2 = -1, p3 = -1, t1 = -1, t2 = -1, quads = -1;
    for (let r = 12; r >= 0; r--){
      const c = CNT[r];
      if (c === 4) quads = r;
      else if (c === 3){ if (t1 < 0) t1 = r; else t2 = r; }
      else if (c === 2){ if (p1 < 0) p1 = r; else if (p2 < 0) p2 = r; else p3 = r; }
    }

    if (quads >= 0){
      let kick = -1;
      for (let r = 12; r >= 0; r--){ if (r !== quads && CNT[r]){ kick = r; break; } }
      return pack(7, quads, quads, quads, quads, kick);
    }
    if (t1 >= 0 && t2 >= 0) return pack(6, t1, t1, t1, t2, t2);
    if (t1 >= 0 && p1 >= 0) return pack(6, t1, t1, t1, p1, p1);
    if (st >= 0){
      return pack(4, st, Math.max(st - 1, 0), Math.max(st - 2, 0), Math.max(st - 3, 0), Math.max(st - 4, 0));
    }
    if (t1 >= 0){
      let k1 = -1, k2 = -1;
      for (let r = 12; r >= 0; r--){
        if (r === t1 || !CNT[r]) continue;
        if (k1 < 0) k1 = r; else { k2 = r; break; }
      }
      return pack(3, t1, t1, t1, k1, k2);
    }
    if (p1 >= 0 && p2 >= 0){
      let kick = -1;
      for (let r = 12; r >= 0; r--){
        if (r === p1 || r === p2 || !CNT[r]) continue;
        kick = r; break;
      }
      return pack(2, p1, p1, p2, p2, kick);
    }
    if (p1 >= 0){
      let k1 = -1, k2 = -1, k3 = -1;
      for (let r = 12; r >= 0; r--){
        if (r === p1 || !CNT[r]) continue;
        if (k1 < 0) k1 = r; else if (k2 < 0) k2 = r; else { k3 = r; break; }
      }
      return pack(1, p1, p1, k1, k2, k3);
    }
    let a = -1, b = -1, c = -1, d = -1, e = -1;
    for (let r = 12; r >= 0; r--){
      if (!CNT[r]) continue;
      if (a < 0) a = r; else if (b < 0) b = r; else if (c < 0) c = r; else if (d < 0) d = r; else { e = r; break; }
    }
    return pack(0, a, b, c, d, e);
  }

  const CAT_RU = ['старшая карта','пара','две пары','сет','стрит','флеш','фулл-хаус','каре','стрит-флеш'];
  const R_GEN = ['двоек','троек','четвёрок','пятёрок','шестёрок','семёрок','восьмёрок',
                 'девяток','десяток','валетов','дам','королей','тузов'];
  const R_PL  = ['двойки','тройки','четвёрки','пятёрки','шестёрки','семёрки','восьмёрки',
                 'девятки','десятки','валеты','дамы','короли','тузы'];
  const R_SG  = ['двойка','тройка','четвёрка','пятёрка','шестёрка','семёрка','восьмёрка',
                 'девятка','десятка','валет','дама','король','туз'];
  const R_GEN_SG = ['двойки','тройки','четвёрки','пятёрки','шестёрки','семёрки','восьмёрки',
                    'девятки','десятки','валета','дамы','короля','туза'];

  function describe(cards){
    if (!cards || cards.length < 5) return '';
    const s = eval7(cards);
    const cat = Math.floor(s / CAT);
    let rem = s % CAT;
    const d = [];
    for (let i = 0; i < 5; i++){ const p = Math.floor(rem / POW13[i]); d.push(p); rem -= p * POW13[i]; }
    switch (cat){
      case 0: return 'старшая карта — ' + R_SG[d[0]];
      case 1: return 'пара ' + R_GEN[d[0]];
      case 2: return 'две пары: ' + R_PL[d[0]] + ' и ' + R_PL[d[2]];
      case 3: return 'сет ' + R_GEN[d[0]];
      case 4: return 'стрит до ' + R_GEN_SG[d[0]];
      case 5: return 'флеш, старшая — ' + R_SG[d[0]];
      case 6: return 'фулл-хаус: ' + R_PL[d[0]] + ' и ' + R_PL[d[3]];
      case 7: return 'каре ' + R_GEN[d[0]];
      case 8: return 'стрит-флеш до ' + R_GEN_SG[d[0]];
    }
    return '';
  }

  // Комбинации конкретного класса руки: 'AA' | 'AKs' | 'AKo'
  function combosFor(name){
    const r1 = RANKS.indexOf(name[0]);
    const r2 = RANKS.indexOf(name[1]);
    const out = [];
    if (r1 === r2){
      for (let a = 0; a < 4; a++) for (let b = a + 1; b < 4; b++) out.push([r1 * 4 + a, r2 * 4 + b]);
      return out;
    }
    const hi = Math.max(r1, r2), lo = Math.min(r1, r2);
    const suited = name.length > 2 && name[2] === 's';
    if (suited){
      for (let s = 0; s < 4; s++) out.push([hi * 4 + s, lo * 4 + s]);
    } else {
      for (let s1 = 0; s1 < 4; s1++) for (let s2 = 0; s2 < 4; s2++){
        if (s1 === s2) continue;
        out.push([hi * 4 + s1, lo * 4 + s2]);
      }
    }
    return out;
  }

  function prepare(req){
    const hero = req.hero, board = req.board || [];
    const opps = Math.max(1, Math.min(6, req.opponents || 1));
    const known = new Set([hero[0], hero[1]]);
    for (let i = 0; i < board.length; i++) known.add(board[i]);

    const deckArr = [];
    for (let c = 0; c < 52; c++) if (!known.has(c)) deckArr.push(c);
    const deckBase = new Int8Array(deckArr);

    const combos = [];
    let totalW = 0;
    for (let i = 0; i < req.range.length; i++){
      const r = req.range[i];
      if (!r || !(r.w > 0)) continue;
      if (known.has(r.a) || known.has(r.b)) continue;
      combos.push(r); totalW += r.w;
    }
    if (!combos.length || combos.length < opps) return null;

    const nC = combos.length;
    const ca = new Int8Array(nC), cb = new Int8Array(nC), cum = new Float64Array(nC);
    let acc = 0;
    for (let i = 0; i < nC; i++){
      ca[i] = combos[i].a; cb[i] = combos[i].b;
      acc += combos[i].w; cum[i] = acc;
    }

    const bd = new Int8Array(5);
    for (let i = 0; i < board.length; i++) bd[i] = board[i];

    const vCards = [];
    for (let k = 0; k < opps; k++) vCards.push(new Int8Array(7));

    return {
      deckBase, L: deckBase.length, ca, cb, cum, totalW, nC, opps,
      hero: [hero[0], hero[1]], bd, bl: board.length, need: 5 - board.length,
      tmp: new Int8Array(52), cA: new Int8Array(7), vCards,
      mark: new Uint8Array(52), picks: new Int8Array(opps * 2)
    };
  }

  function runTrials(S, count){
    const { deckBase, L, ca, cb, cum, totalW, nC, opps, bd, bl, need,
            tmp, cA, vCards, hero, mark, picks } = S;
    const single = nC === 1;
    let wins = 0, ties = 0, eqSum = 0, retries = 0, done = 0;

    for (let t = 0; t < count; t++){
      // руки соперников: карты не должны пересекаться
      let ok = true, np = 0;
      for (let k = 0; k < opps; k++){
        let good = false, tries = 0;
        while (tries < 40){
          let vi = 0;
          if (!single){
            const r = Math.random() * totalW;
            let lo = 0, hi = nC - 1;
            while (lo < hi){ const mid = (lo + hi) >> 1; if (cum[mid] < r) lo = mid + 1; else hi = mid; }
            vi = lo;
          }
          const a = ca[vi], b = cb[vi];
          let clash = false;
          for (let q = 0; q < np; q++){ if (picks[q] === a || picks[q] === b){ clash = true; break; } }
          if (!clash){ picks[np++] = a; picks[np++] = b; good = true; break; }
          tries++;
        }
        if (!good){ ok = false; break; }
        vCards[k][0] = picks[np - 2]; vCards[k][1] = picks[np - 1];
      }
      if (!ok){ t--; if (++retries > 5000) break; continue; }
      done++;

      if (need > 0){
        for (let q = 0; q < np; q++) mark[picks[q]] = 1;
        let m = 0;
        for (let i = 0; i < L; i++){
          const c = deckBase[i];
          if (!mark[c]) tmp[m++] = c;
        }
        for (let q = 0; q < np; q++) mark[picks[q]] = 0;
        for (let k = 0; k < need; k++){
          const j = k + ((Math.random() * (m - k)) | 0);
          const tv = tmp[k]; tmp[k] = tmp[j]; tmp[j] = tv;
          bd[bl + k] = tmp[k];
        }
      }

      cA[0] = hero[0]; cA[1] = hero[1];
      for (let i = 0; i < 5; i++) cA[2 + i] = bd[i];
      const sH = eval7(cA);

      let best = sH, cnt = 1;
      for (let k = 0; k < opps; k++){
        const h = vCards[k];
        for (let i = 0; i < 5; i++) h[2 + i] = bd[i];
        const s = eval7(h);
        if (s > best){ best = s; cnt = 1; }
        else if (s === best){ cnt++; }
      }

      if (best === sH){
        if (cnt === 1) wins++; else ties++;
        eqSum += 1 / cnt;
      }
    }
    return { wins, ties, eqSum, done };
  }

  function now(){ return (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now(); }

  function estimateSync(req){
    const S = prepare(req);
    if (!S) return null;
    const t0 = now();
    const r = runTrials(S, req.trials);
    const total = r.done;                       // считаем только те раздачи, где удалось раздать
    if (!total) return null;
    return {
      win: r.wins / total, tie: r.ties / total, lose: (total - r.wins - r.ties) / total,
      equity: r.eqSum / total, trials: total, combos: S.nC, opponents: S.opps, ms: now() - t0
    };
  }

  function estimateAsync(req, onProgress, isCancelled){
    return new Promise((resolve) => {
      const S = prepare(req);
      if (!S) { resolve(null); return; }
      const total = req.trials;
      const batch = 4000;
      const t0 = now();
      let done = 0, wins = 0, ties = 0, eqSum = 0;

      function step(){
        // просим ровно столько, сколько ещё нужно: часть раздач может не раздаться
        const r = runTrials(S, Math.min(batch, total - done));
        wins += r.wins; ties += r.ties; eqSum += r.eqSum; done += r.done;
        if (isCancelled && isCancelled()){ resolve(null); return; }
        if (!r.done){ resolve(null); return; }  // диапазон не сходится: карт не хватает
        if (onProgress) onProgress(done / total);
        if (done < total){
          setTimeout(step, 0);
        } else {
          resolve({
            win: wins / total, tie: ties / total, lose: (total - wins - ties) / total,
            equity: eqSum / total, trials: total, combos: S.nC, opponents: S.opps, ms: now() - t0
          });
        }
      }
      step();
    });
  }

  return { RANKS, SUITS, cardName, parseCard, eval7, describe, combosFor,
           estimateSync, estimateAsync, CAT };
}

  root.createEngine = createEngine;
  root.E = createEngine();
})(typeof globalThis !== 'undefined' ? globalThis : this);

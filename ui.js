/* Общие мелочи интерфейса: карты, числа, склонения, шторки. */
(function (root) {
  'use strict';
  const E = root.E;
  const SUIT_CH = ['♣', '♦', '♥', '♠'];      // порядок движка: c d h s
  const RED = [1, 2];

  const $ = (id) => document.getElementById(id);

  function cardEl(card, opts) {
    const o = opts || {};
    const el = document.createElement('div');
    el.className = 'card' + (o.small ? ' small' : '') + (card === null ? ' empty' : '');
    if (card === null || card === undefined) {
      el.innerHTML = '<span class="plus">+</span>';
      return el;
    }
    const rank = E.RANKS[card >> 2];
    const suit = card & 3;
    el.classList.add(RED.includes(suit) ? 'red' : 'black');
    el.innerHTML = `<span class="rk">${rank}</span><span class="st">${SUIT_CH[suit]}</span>`;
    return el;
  }

  function fmt(x, d) {
    return Number(x).toLocaleString('ru-RU', {
      minimumFractionDigits: d, maximumFractionDigits: d,
    });
  }

  /** Склонение: plural(2, ['соперник','соперника','соперников']) */
  function plural(n, forms) {
    const m10 = n % 10, m100 = n % 100;
    if (m10 === 1 && m100 !== 11) return forms[0];
    if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return forms[1];
    return forms[2];
  }

  const pct = (x, d) => fmt(x * 100, d === undefined ? 1 : d) + '%';

  /** Шторка снизу: один общий контейнер, содержимое подставляется. */
  function openSheet(title, build) {
    const sheet = $('sheet');
    const body = $('sheetBody');
    $('sheetTitle').textContent = title;
    body.innerHTML = '';
    build(body);
    sheet.classList.remove('hidden');
    // принудительный reflow вместо requestAnimationFrame: переход должен
    // сработать и в фоновой вкладке, где кадры не рисуются
    void sheet.querySelector('.sheet-panel').offsetHeight;
    sheet.classList.add('shown');
    document.body.classList.add('locked');
  }

  function closeSheet() {
    const sheet = $('sheet');
    sheet.classList.remove('shown');
    document.body.classList.remove('locked');
    setTimeout(() => sheet.classList.add('hidden'), 180);
  }

  root.UI = { $, cardEl, fmt, plural, pct, openSheet, closeSheet, SUIT_CH };
})(typeof globalThis !== 'undefined' ? globalThis : this);

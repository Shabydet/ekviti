/* Споты для тренировки: только мои карты и борд. Чужие карты не раздаются —
   шанс победы считается против случайной руки. */
(function (root) {
  'use strict';

  const pick = (arr) => arr[(Math.random() * arr.length) | 0];

  function shuffledDeck(known) {
    const deck = [];
    for (let c = 0; c < 52; c++) if (!known.has(c)) deck.push(c);
    for (let i = deck.length - 1; i > 0; i--) {
      const j = (Math.random() * (i + 1)) | 0;
      const t = deck[i]; deck[i] = deck[j]; deck[j] = t;
    }
    return deck;
  }

  /**
   * Случайный спот: моя рука, борд и банк.
   * level 1 — флоп, level 2 — флоп/терн, level 3 — любая улица.
   */
  function createSpot(opts) {
    const level = (opts && opts.level) || 2;
    const streets = level === 1 ? [3] : level === 2 ? [3, 4] : [0, 3, 4, 5];
    const boardLen = pick(streets);

    const deck = shuffledDeck(new Set());
    const hero = [deck[0], deck[1]].sort((a, b) => (b >> 2) - (a >> 2));
    const board = deck.slice(2, 2 + boardLen);

    return {
      level,
      hero,
      board,
      pot: pick([60, 80, 100, 120, 150, 180, 200, 240, 300]),
      bb: 2,
    };
  }

  root.Drill = { createSpot };
})(typeof globalThis !== 'undefined' ? globalThis : this);

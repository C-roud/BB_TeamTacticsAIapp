/* =====================================================================
 * responsive.js — 画面幅に合わせてコート（1000px 固定）を縮小表示する（スマホ・タブレット縦向け対応）
 *   コートは transform: scale() で縮小し、駒の座標（left/top）は常に「1000px のコート基準」のまま。
 *   そのため、保存データ・AI提案・採点の座標は、画面サイズが違っても同じ値になる。
 *   駒のドラッグだけは縮小を考慮した座標計算が必要なので、main.js の drag() が拡大率を使っている。
 *   駒は縮小すると小さすぎて掴めないため、縮小率に応じて少し大きく表示する（最大2倍）。
 * ===================================================================== */
(function () {
  'use strict';
  const SIDE_MARGIN = 12;     // 画面の左右に残す余白(px)

  function fit() {
    const wrap = document.getElementById('court-wrap');
    const court = document.getElementById('court-container');
    if (!wrap || !court) return;
    const w = court.offsetWidth, h = court.offsetHeight;      // 縮小前の大きさ（transform の影響を受けない）
    if (!w || !h) return;
    const avail = document.documentElement.clientWidth - SIDE_MARGIN * 2;
    const s = Math.min(1, Math.max(0.2, avail / w));
    court.style.transform = s < 1 ? `scale(${s})` : '';
    wrap.style.width = Math.round(w * s) + 'px';
    wrap.style.height = Math.round(h * s) + 'px';
    document.documentElement.style.setProperty('--piece-k', String(Math.min(2, Math.max(1, 0.8 / s)).toFixed(3)));
  }

  window.BBResponsive = { fit };
  window.addEventListener('resize', fit);
  window.addEventListener('orientationchange', () => setTimeout(fit, 150));
  document.addEventListener('DOMContentLoaded', fit);
  window.addEventListener('load', fit);
})();

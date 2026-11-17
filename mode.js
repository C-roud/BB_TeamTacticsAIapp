/* =====================================================================
 * mode.js — 「練習モード」「試合モード」の切り替え（トップ画面のモード選択＋上部ナビ）
 *   練習モード: 戦術提案(AI)・採点モード・戦術ボード   → 選手プロフィール（身長・10エリアのシュート率）が必要
 *   試合モード: 戦術ボード ＋ リアルタイム・スコアシート → プロフィール不要で、すぐ記録を始められる
 * 依存: main.js のグローバル（modalOverlay, mainContent, closeModal, validateProfileForm, pausePlayback）
 * ===================================================================== */
(function () {
  'use strict';
  const $ = (id) => document.getElementById(id);
  let mode = 'practice';                 // 現在表示しているモード
  let started = false;                   // 最初のモード選択を終えたか

  // ---------------- トップ画面（モーダル）内のモード選択 ----------------
  function selectInModal(m) {
    $('mode-card-practice').classList.toggle('is-selected', m === 'practice');
    $('mode-card-game').classList.toggle('is-selected', m === 'game');
    $('profile-setup').style.display = m === 'practice' ? '' : 'none';
    $('game-start-footer').style.display = m === 'game' ? '' : 'none';
    $('modal-title').textContent = m === 'practice' ? '選手データ・セットアップ' : '試合モードの開始';
  }

  function openModal(m) {
    modalOverlay.style.display = 'flex';
    mainContent.classList.add('content-locked');
    document.body.style.overflow = 'hidden';
    $('modal-cancel-btn').style.display = started ? '' : 'none';   // 途中から開いたときだけ「戻る」を出す
    selectInModal(m);
  }

  // ---------------- 画面の切り替え ----------------
  function apply(m) {
    mode = m;
    document.body.classList.toggle('mode-game', m === 'game');
    document.body.classList.toggle('mode-practice', m === 'practice');
    $('practice-area').style.display = m === 'practice' ? '' : 'none';
    $('game-area').style.display = m === 'game' ? '' : 'none';
    $('nav-practice').classList.toggle('active', m === 'practice');
    $('nav-game').classList.toggle('active', m === 'game');
    $('mode-nav-hint').textContent = m === 'practice'
      ? '戦術提案（AI）・採点・戦術ボード'
      : '戦術ボード ＋ リアルタイム・スコアシート（Four Factors など）';
    if (typeof pausePlayback === 'function') pausePlayback();
    if (window.BBGame && m === 'game') window.BBGame.refresh();
  }

  /** ナビから切り替える。練習モードは選手プロフィールが必要なので、未入力ならセットアップ画面を開く */
  function switchTo(m) {
    if (m === mode && started) return;
    if (m === 'practice' && !validateProfileForm()) {
      openModal('practice');
      return;
    }
    apply(m);
  }

  function init() {
    if (!$('mode-nav')) return;
    $('mode-card-practice').addEventListener('click', () => selectInModal('practice'));
    $('mode-card-game').addEventListener('click', () => selectInModal('game'));
    $('start-game-btn').addEventListener('click', () => {
      closeModal();                       // main.js: モーダルを閉じてロック解除
      started = true;
      apply('game');
    });
    // 既存の「戦術ボードへ進む」（練習モードの開始）。main.js 側のハンドラ(closeModal)の後に実行される
    $('proceed-to-board-btn').addEventListener('click', () => { started = true; apply('practice'); });
    $('nav-practice').addEventListener('click', () => switchTo('practice'));
    $('nav-game').addEventListener('click', () => switchTo('game'));
    // 途中でセットアップ画面を開いたとき、入力せずに元のモードへ戻る
    $('modal-cancel-btn').addEventListener('click', () => {
      if (!started) return;
      closeModal();
      apply(mode);
    });
    apply('practice');
  }

  window.BBMode = { get mode() { return mode; }, switchTo };
  document.addEventListener('DOMContentLoaded', init);
})();

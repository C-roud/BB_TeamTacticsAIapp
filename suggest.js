/* =====================================================================
 * suggest.js — 「戦術提案」パネル（既存アプリ main.js に後付けする拡張。main.js は変更していない）
 *   ボード上の赤駒(r1〜r5) = 自チームの初期配置、ボール保持者、プロフィール(身長・10エリアのシュート率)、
 *   ドライブ/パス重視 を入力に、engine.js が上位3案を計算 → 結果をタイムラインに読み込んで再生する。
 *   計算はすべてブラウザ内で完結（サーバー不要 = GitHub Pages でそのまま動く）。
 * 依存: main.js のグローバル（players, recordedData, playerProfiles, validateProfileForm,
 *       renderTimelineKeyframes, jumpToTime, startPlayback, pausePlayback, isPlaying, currentTime, exportBtn）,
 *       engine.js(BBEngine), macros_data.js(MACRO_DATA)
 * ===================================================================== */
(function () {
  'use strict';
  const PIECE = 15;                              // 駒(30x30)の left/top → 中心 への補正
  const MAX_LEFT = 970, MAX_TOP = 506;           // 駒をドラッグできる範囲（main.js の drag() と同じ）
  const AREA_COLORS = ['#e6194b', '#f58231', '#ffe119', '#3cb44b', '#4363d8', '#911eb4', '#46f0f0', '#f032e6', '#9a6324', '#808000'];

  let engine = null;
  let overlay = null;
  let lastResults = [];
  const $ = (id) => document.getElementById(id);

  // ------------------------------------------------------------ 初期化
  function init() {
    const panel = $('suggest-panel');
    if (!panel) return;
    const info = $('suggest-data-info');
    if (typeof window.MACRO_DATA === 'undefined' || !window.MACRO_DATA.macros) {
      info.className = 'suggest-error';
      info.textContent = 'macros_data.js が見つかりません。README の手順（export_web_data.py）で生成し、index.html と同じ場所に置いてください。';
      $('suggest-generate-btn').disabled = true;
      return;
    }
    rebuildEngine();
    info.textContent = `マクロデータ: ${window.MACRO_DATA.count}本（生成: ${window.MACRO_DATA.generated}）`;
    $('suggest-generate-btn').addEventListener('click', onGenerate);
    $('suggest-zones-btn').addEventListener('click', toggleZones);
    const defNote = () => { $('suggest-defense-note').textContent = $('suggest-defense').value === 'man' ? '' : '※ ゾーンの動きは簡易モデル（基本位置は一般的な配置を仮定）'; };
    $('suggest-defense').addEventListener('change', defNote); defNote();
    $('suggest-use-drive').addEventListener('change', () => { $('suggest-drive').disabled = !$('suggest-use-drive').checked; updateDriveLabel(); });
    $('suggest-drive').addEventListener('input', updateDriveLabel);
    ['suggest-fliplr', 'suggest-hpx', 'suggest-basis'].forEach((id) => $(id).addEventListener('change', () => {
      rebuildEngine();
      if (overlay && overlay.style.display !== 'none') drawZones();
    }));
    updateDriveLabel();
  }

  function rebuildEngine() {
    const G = Object.assign({}, BBEngine.GEOM_APP, { flipLR: $('suggest-fliplr').checked, hpX: Number($('suggest-hpx').value) || 150 });
    G.areaOf = BBEngine.makeAppAreaOf(G);
    engine = new BBEngine.Engine(window.MACRO_DATA, { geometry: G, fgBasis: $('suggest-basis').value });
  }

  function updateDriveLabel() {
    const on = $('suggest-use-drive').checked, v = Number($('suggest-drive').value);
    $('suggest-drive-label').textContent = on ? `${v.toFixed(2)}（${v < 0.34 ? 'パス寄り' : (v > 0.66 ? 'ドライブ寄り' : '中間')}）` : '指定しない';
  }

  // ------------------------------------------------------------ ボード・プロフィールの読み取り
  function pieceCenter(el) {
    const st = window.getComputedStyle(el);
    return [parseFloat(el.style.left || st.left || 0) + PIECE, parseFloat(el.style.top || st.top || 0) + PIECE];
  }

  function readBoard() {
    const initPos = [], blue = [];
    for (let i = 1; i <= 5; i++) { initPos.push(pieceCenter($('red' + i))); blue.push(pieceCenter($('blue' + i))); }
    let holder = 0, note = '';
    const sel = $('suggest-holder').value;
    const hb = document.querySelector('.player.ball-holder');
    if (sel !== 'auto') {
      holder = Number(sel);
      document.querySelectorAll('.player').forEach((p) => p.classList.remove('ball-holder'));      // 盤面にも反映
      $('red' + (holder + 1)).classList.add('ball-holder');
      if (typeof updateStatusDisplay === 'function') updateStatusDisplay();
    } else if (hb && /^red[1-5]$/.test(hb.id)) holder = Number(hb.id.slice(3)) - 1;
    else if (hb) throw new Error('ボール保持者が青の駒になっています。赤の駒(r1〜r5)をボール保持者にするか、「ボール保持者」の欄で選んでください。');
    else note = 'ボール保持者が未指定のため r1 を保持者として計算しました。';
    return { init: initPos, blue, holder, note };
  }

  function readProfiles() {
    if (typeof validateProfileForm === 'function') validateProfileForm();     // フォームの最新値を playerProfiles に反映
    const out = [];
    for (let i = 1; i <= 5; i++) {
      const p = playerProfiles['red' + i];
      if (!p) throw new Error(`r${i} のプロフィールがありません。選手データを入力してください。`);
      const fg = [];
      for (let k = 1; k <= 10; k++) fg.push(Number(p['area_' + k]));
      const h = Number(p.height);
      if (!(h >= 100 && h <= 260)) throw new Error(`r${i} の身長が不正です（${p.height}）。`);
      if (fg.some((v) => !isFinite(v) || v < 0 || v > 100)) throw new Error(`r${i} のシュート率は 0〜100 の数字で入力してください。`);
      out.push({ id: 'red' + i, height_cm: h, fg });
    }
    return out;
  }

  // エンジンのフレーム → main.js の recordedData 形式（駒の左上座標）
  function framesToRecorded(frames) {
    const clampX = (v) => Math.max(0, Math.min(MAX_LEFT, Math.round(v - PIECE)));
    const clampY = (v) => Math.max(0, Math.min(MAX_TOP, Math.round(v - PIECE)));
    return frames.map((f) => {
      const positions = [];
      for (let i = 0; i < 5; i++) positions.push({ id: 'blue' + (i + 1), x: clampX(f.dfn[i][0]), y: clampY(f.dfn[i][1]), ball: 0 });
      for (let p = 0; p < 5; p++) positions.push({ id: 'red' + (p + 1), x: clampX(f.att[p][0]), y: clampY(f.att[p][1]), ball: f.hold === p ? 1 : 0 });
      return { timestamp: f.t.toFixed(1), positions };
    });
  }

  // ------------------------------------------------------------ 生成
  function setMsg(text, isError) {
    const el = $('suggest-msg');
    el.textContent = text || '';
    el.className = isError ? 'suggest-error' : 'suggest-note';
  }

  function onGenerate() {
    let board, profiles;
    try { board = readBoard(); profiles = readProfiles(); } catch (e) { setMsg(e.message, true); return; }
    const btn = $('suggest-generate-btn');
    btn.disabled = true; btn.textContent = '計算中…';
    setMsg(board.note || '', false);
    $('suggest-results').innerHTML = '';
    clearShotMarker();
    setTimeout(() => {                       // 「計算中」表示を描画してから重い計算を実行
      try {
        const t0 = performance.now();
        const opts = {
          ballHolder: board.holder, topK: 3, minMacros: Number($('suggest-minmacros').value),
          driveWeight: $('suggest-use-drive').checked ? Number($('suggest-drive').value) : null,
          defInit: $('suggest-use-blue').checked ? board.blue : null,
          defense: $('suggest-defense').value,
        };
        lastResults = engine.suggest(board.init, profiles, opts);
        renderResults(lastResults, ((performance.now() - t0) / 1000).toFixed(1));
      } catch (e) {
        setMsg('計算に失敗しました: ' + e.message, true);
      } finally {
        btn.disabled = false; btn.textContent = '提案を生成';
      }
    }, 30);
  }

  const DEFENSE_JP = { man: 'マンツーマン', zone23: '2-3ゾーン', zone32: '3-2ゾーン' };

  function renderResults(results, sec) {
    const box = $('suggest-results');
    box.innerHTML = '';
    const head = document.createElement('p');
    head.className = 'suggest-note';
    head.textContent = `上位${results.length}案（計算 ${sec}秒）。期待得点は「案どうしを比べるための指標」で、実戦の得点を予測するものではありません。`;
    box.appendChild(head);
    results.forEach((r) => {
      const card = document.createElement('div'); card.className = 'suggest-card';
      const h = document.createElement('div'); h.className = 'suggest-card-title';
      h.textContent = `案${r.rank}　${r.chain_jp.join(' → ')}`;
      const meta = document.createElement('div'); meta.className = 'suggest-card-meta';
      const imp = r.improvement;
      meta.textContent = `守備: ${DEFENSE_JP[r.defense] || 'マンツーマン'} ／ 約${r.duration_seconds}秒 ／ 最終シュート: ${r.best_shot.shooter_id.replace('red', 'r')} ${r.best_shot.area_name} ／ ` +
        `期待得点 ${r.best_shot.ep.toFixed(2)}（開始直後に打つより ${imp >= 0 ? '+' : ''}${imp.toFixed(2)}） ／ 関与 ${r.involved.length}/5人`;
      const det = document.createElement('details');
      const sum = document.createElement('summary'); sum.textContent = '各マクロの役割と説明';
      const pre = document.createElement('pre'); pre.textContent = r.explanation.replace(/red(\d)/g, 'r$1');
      det.appendChild(sum); det.appendChild(pre);
      const btn = document.createElement('button'); btn.textContent = 'この案をボードに読み込んで再生 ▶';
      btn.addEventListener('click', () => loadPlay(r, card));
      card.appendChild(h); card.appendChild(meta); card.appendChild(det); card.appendChild(btn);
      box.appendChild(card);
    });
  }

  // ------------------------------------------------------------ ボードへ読み込み・再生
  function clearShotMarker() { document.querySelectorAll('.shot-marker').forEach((e) => e.remove()); }

  function loadPlay(r, card) {
    if (typeof pausePlayback === 'function') pausePlayback();
    if (recordedData.length > 0 && !confirm('現在のタイムライン（記録済みの配置）は、この案で置き換えられます。よろしいですか？')) return;
    recordedData = framesToRecorded(r.frames);
    renderTimelineKeyframes();
    exportBtn.disabled = false;
    jumpToTime(0.0);
    document.querySelectorAll('.suggest-card').forEach((c) => c.classList.remove('active'));
    if (card) card.classList.add('active');
    clearShotMarker();
    const mk = document.createElement('div');
    mk.className = 'shot-marker'; mk.textContent = '★';
    mk.title = `最終シュート: ${r.best_shot.shooter_id.replace('red', 'r')} / ${r.best_shot.area_name} / ${r.best_shot.t_sec.toFixed(1)}秒`;
    mk.style.left = (r.best_shot.pos[0] - 11) + 'px'; mk.style.top = (r.best_shot.pos[1] - 11) + 'px';
    $('court-container').appendChild(mk);
    const lastT = parseFloat(recordedData[recordedData.length - 1].timestamp);
    startPlayback();
    const watcher = setInterval(() => {      // 最後のフレームで自動停止
      if (!isPlaying) { clearInterval(watcher); return; }
      if (currentTime >= lastT) { pausePlayback(); clearInterval(watcher); }
    }, 100);
  }

  // ------------------------------------------------------------ エリア表示（10エリアの境界の確認用）
  function toggleZones() {
    if (!overlay) {
      overlay = document.createElement('canvas');
      overlay.id = 'zone-overlay';
      const c = $('court-container');
      overlay.width = c.clientWidth; overlay.height = c.clientHeight;
      c.insertBefore(overlay, c.firstChild);
      drawZones();
      overlay.style.display = 'block';
      return;
    }
    const show = overlay.style.display === 'none';
    overlay.style.display = show ? 'block' : 'none';
    if (show) drawZones();
  }

  function drawZones() {
    const ctx = overlay.getContext('2d');
    ctx.clearRect(0, 0, overlay.width, overlay.height);
    const g = engine.zoneGrid(6), sum = {}, step = g.step;
    g.rows.forEach((row, ri) => row.forEach((a, ci) => {
      ctx.fillStyle = AREA_COLORS[a - 1] + '55';
      ctx.fillRect(ci * step, ri * step, step, step);
      const s = sum[a] || (sum[a] = { x: 0, y: 0, n: 0 });
      s.x += ci * step + step / 2; s.y += ri * step + step / 2; s.n++;
    }));
    ctx.textAlign = 'center'; ctx.fillStyle = '#111';
    Object.keys(sum).forEach((a) => {
      const s = sum[a], d = typeof AREA_DEFINITIONS !== 'undefined' ? AREA_DEFINITIONS[a - 1].description : '';
      ctx.font = 'bold 13px sans-serif'; ctx.fillText(String(a), s.x / s.n, s.y / s.n - 2);
      ctx.font = '11px sans-serif'; ctx.fillText(d, s.x / s.n, s.y / s.n + 12);
    });
  }

  // 採点モード（score_ui.js）から使う
  const g = typeof window !== 'undefined' ? window : globalThis;
  g.BBApp = g.BBApp || {};
  g.BBApp.getEngine = () => engine;
  g.BBApp.readProfiles = readProfiles;
  g.BBApp.loadPlay = (r) => loadPlay(r, null);
  g.BBApp.clearShotMarker = clearShotMarker;

  if (typeof document !== 'undefined') document.addEventListener('DOMContentLoaded', init);
  if (typeof module !== 'undefined' && module.exports) module.exports = { framesToRecorded };
})();

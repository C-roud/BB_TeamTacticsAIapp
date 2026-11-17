/* =====================================================================
 * score_ui.js — 採点モード（試合の振り返り）の画面部分。計算は scoring.js、AI案は suggest.js / engine.js を使う。
 * 依存: main.js のグローバル（recordedData, currentTime, jumpToTime）, BBApp(suggest.js), BBScoring(scoring.js), BBEngine(engine.js)
 * ===================================================================== */
(function () {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const FT_PER_PX = 1 / 10.55;
  let shotTime = null;          // null = 最後のキーフレーム
  let lastResult = null;

  const short = (id) => String(id).replace('red', 'r').replace('blue', 'b');

  function init() {
    if (!$('score-panel')) return;
    $('tab-suggest').addEventListener('click', () => showTab('suggest'));
    $('tab-score').addEventListener('click', () => showTab('score'));
    $('score-run-btn').addEventListener('click', onRun);
    $('score-set-shot-btn').addEventListener('click', () => { shotTime = Math.round(currentTime * 10) / 10; updateShotLabel(); });
    $('score-clear-shot-btn').addEventListener('click', () => { shotTime = null; updateShotLabel(); });
    $('score-copy-btn').addEventListener('click', onCopy);
    updateShotLabel();
  }

  function showTab(which) {
    const sug = which === 'suggest';
    $('suggest-panel').style.display = sug ? '' : 'none';
    $('score-panel').style.display = sug ? 'none' : '';
    $('tab-suggest').classList.toggle('active', sug);
    $('tab-score').classList.toggle('active', !sug);
  }

  function updateShotLabel() { $('score-shot-label').textContent = shotTime === null ? '最後のキーフレーム' : `${shotTime.toFixed(1)}秒`; }

  function setMsg(text, isError) {
    const el = $('score-msg');
    el.textContent = text || '';
    el.className = isError ? 'suggest-error' : 'suggest-note';
  }

  function getEngine() {
    const e = window.BBApp && BBApp.getEngine && BBApp.getEngine();
    return e || new BBEngine.Engine({ macros: {} });     // マクロデータが無くても、シュート機会・スペーシング等の採点はできる
  }

  // ------------------------------------------------------------ 実行
  function onRun() {
    let profiles;
    try { profiles = BBApp.readProfiles(); } catch (e) { setMsg(e.message, true); return; }
    const btn = $('score-run-btn');
    btn.disabled = true; btn.textContent = '採点中…';
    setMsg('', false);
    $('score-results').innerHTML = '';
    $('score-copy-btn').disabled = true;
    setTimeout(() => {                         // 「採点中」表示を描画してから計算
      try {
        const engine = getEngine();
        const opts = { shotTime, macros: $('score-use-macros').checked, ai: $('score-use-ai').checked };
        lastResult = BBScoring.scorePlay(engine, recordedData, profiles, opts);
        render(lastResult, engine);
        $('score-copy-btn').disabled = false;
        showShotOnBoard(lastResult);
        const notes = [];
        if (!engine.ids.length) notes.push('マクロデータ（macros_data.js）が無いため、基本戦術の判定とAI案との比較は行っていません。');
        if (lastResult.meta.warnings.length) notes.push(lastResult.meta.warnings.slice(0, 3).join(' '));
        setMsg(notes.join(' '), false);
      } catch (e) {
        setMsg(e.message, true);
      } finally {
        btn.disabled = false; btn.textContent = '採点する';
      }
    }, 30);
  }

  function showShotOnBoard(r) {
    if (window.BBApp && BBApp.clearShotMarker) BBApp.clearShotMarker();
    const times = recordedData.map((f) => parseFloat(f.timestamp)).sort((a, b) => a - b);
    const t = times.filter((x) => x <= r.meta.shot_time + 1e-6).pop();
    if (t !== undefined && typeof jumpToTime === 'function') jumpToTime(t);
    const mk = document.createElement('div');
    mk.className = 'shot-marker'; mk.textContent = '★';
    mk.title = `最終シュート: ${short(r.shot.id)} / ${r.shot.area_name} / ${r.shot.t.toFixed(1)}秒`;
    mk.style.left = (r.shot.pos[0] - 11) + 'px'; mk.style.top = (r.shot.pos[1] - 11) + 'px';
    $('court-container').appendChild(mk);
  }

  // ------------------------------------------------------------ 表示
  function el(tag, cls, text) { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; }
  function section(title) { const s = el('div', 'score-section'); s.appendChild(el('h4', null, title)); return s; }
  function metric(value, label) { const m = el('div', 'score-metric'); m.appendChild(el('div', 'v', value)); m.appendChild(el('div', 'l', label)); return m; }
  const sign = (v) => (v >= 0 ? '+' : '') + v.toFixed(2);

  function render(r, engine) {
    const box = $('score-results');
    box.innerHTML = '';

    // 1) 最終シュート
    let s = section('最終シュート');
    s.appendChild(el('div', 'score-headline', `${short(r.shot.id)}（${r.shot.height_cm.toFixed(0)}cm）が ${r.shot.area_name} から（${r.shot.t.toFixed(1)}秒）${r.meta.shot_is_last ? '' : '　※指定した時点'}`));
    const ms = el('div', 'score-metrics');
    ms.appendChild(metric(r.shot.ep.toFixed(2), '期待得点（点/本）'));
    if (r.improvement !== null) ms.appendChild(metric(sign(r.improvement), `開始直後に打つ場合（${r.start_ep.toFixed(2)}）との差`));
    ms.appendChild(metric(`${(r.shot.fg * 100).toFixed(0)}%`, 'この選手のそのエリアのシュート率'));
    ms.appendChild(metric(`${r.shot.open_ft.toFixed(1)}ft`, `最寄りの守備者まで（補正 ×${r.shot.mult.toFixed(2)}）`));
    s.appendChild(ms);
    box.appendChild(s);

    // 2) コメント
    s = section('気づいた点（ルールに基づく目安）');
    if (!r.comments.length) s.appendChild(el('div', 'score-note', '特に目立つ点はありません。'));
    r.comments.forEach((c) => s.appendChild(el('div', 'score-comment ' + c.kind, c.text.replace(/red(\d)/g, 'r$1'))));
    box.appendChild(s);

    // 3) シュート時点の他の選択肢
    s = section('シュート時点で、他の選手が受けていたら');
    const tb = el('table', 'score-table');
    const hr = el('tr'); ['選手', '位置のエリア', '守備者まで', '期待得点', 'パスコース'].forEach((h) => hr.appendChild(el('th', null, h))); tb.appendChild(hr);
    r.alternatives.forEach((a) => {
      const tr = el('tr');
      [short(a.id), a.area_name, `${(a.open_px * FT_PER_PX).toFixed(1)}ft`, a.ep.toFixed(2), a.lane_open ? '空いている' : '守備者に塞がれている'].forEach((t) => tr.appendChild(el('td', null, t)));
      tb.appendChild(tr);
    });
    s.appendChild(tb);
    s.appendChild(el('div', 'score-note', `実際のシューター ${short(r.shot.id)} は ${r.shot.ep.toFixed(2)}。パスコースは「シューターとの間に守備者が約2ft以内にいるか」だけの簡易判定です。`));
    box.appendChild(s);

    // 4) 動きの内訳
    s = section('動きの内訳');
    const driveLabel = r.drive_score < 0.35 ? 'パス中心' : (r.drive_score > 0.65 ? 'ドライブ中心' : 'バランス');
    [
      `関与した選手: ${r.involved.length}/5人（${r.involved.map(short).join('・')}）${r.not_involved.length ? ` ／ 関与なし: ${r.not_involved.map(short).join('・')}` : ''}`,
      `パス ${r.passes}回 ／ ドリブル ${(r.dribble_px * FT_PER_PX).toFixed(0)}ft ／ ドライブ寄り度 ${r.drive_score.toFixed(2)}（${driveLabel}）`,
      `スペーシング: 赤の駒どうしの最小距離 ${r.spacing.min_pair_ft.toFixed(1)}ft（約2ft未満になった回数 ${r.spacing.close_frames}回）`,
    ].forEach((t) => s.appendChild(el('div', 'score-comment info', t)));
    box.appendChild(s);

    // 5) 近い基本戦術
    if (r.macros) {
      s = section('近い基本戦術（目安）');
      if (r.macros.segments.length) {
        const ul = el('div');
        r.macros.segments.forEach((g) => {
          const alt = g.alt.length ? `（他の候補: ${g.alt.join('、')}）` : '';
          ul.appendChild(el('div', 'score-comment good', `${g.t0.toFixed(1)}〜${g.t1.toFixed(1)}秒　${g.name}　平均のずれ ${(g.err_px * FT_PER_PX).toFixed(1)}ft ${alt}`));
        });
        s.appendChild(ul);
        s.appendChild(el('div', 'score-note', `記録のうち ${(r.macros.coverage * 100).toFixed(0)}% の時間が、登録済みの基本戦術で説明できました。`));
      } else {
        s.appendChild(el('div', 'score-note', '登録済みの基本戦術と一致する区間は見つかりませんでした。'));
        if (r.macros.closest.length) s.appendChild(el('div', 'score-note', '最も近かったもの（一致とは言えません）: ' + r.macros.closest.map((c) => `${c.name}（${c.t0.toFixed(1)}〜${c.t1.toFixed(1)}秒、ずれ ${(c.err_px * FT_PER_PX).toFixed(1)}ft）`).join('、')));
      }
      s.appendChild(el('div', 'score-note', '各マクロを、あなたの駒の配置から始まる形に直して、実際の動きとの位置のずれを測っています。動きが小さいマクロ' + (r.macros.skipped.length ? `（${r.macros.skipped.join('、')}）` : '') + 'は、静止と区別できないため判定の対象外です。'));
      box.appendChild(s);
    }

    // 6) AI案との比較
    if (r.ai) {
      s = section('AI案との比較（同じ初期配置・同じボール保持者・同じ選手）');
      const ms2 = el('div', 'score-metrics');
      ms2.appendChild(metric(r.shot.ep.toFixed(2), 'あなたの最終シュート'));
      ms2.appendChild(metric(r.ai.ep.toFixed(2), `AI案1（${short(r.ai.shooter)} ${r.ai.area_name}）`));
      ms2.appendChild(metric(sign(r.shot.ep - r.ai.ep), 'あなた − AI'));
      s.appendChild(ms2);
      s.appendChild(el('div', 'score-note', `AI案1: ${r.ai.chain_jp.join(' → ')}（${r.ai.duration}秒）。守備は、AI案ではシミュレーション、あなたの記録ではボードに置いた青駒の位置です。`));
      const b = el('button', 'score-ai-btn', 'AI案1をボードに読み込んで再生 ▶');
      b.addEventListener('click', () => { if (window.BBApp && BBApp.loadPlay) BBApp.loadPlay(r.ai.plan); });
      s.appendChild(b);
      box.appendChild(s);
    }

    box.appendChild(el('div', 'score-note', '※ 期待得点 =（エリア別シュート率）×（得点価値）×（守備者の接近による減衰）。案どうしを比べるための指標で、実戦の得点を予測するものではありません。シュート率は「フリーで測った値」として扱っています。0.5秒刻みの記録なので、一瞬の動きや守備の反応は見えません。'));
  }

  function onCopy() {
    if (!lastResult) return;
    const text = lastResult.text.replace(/red(\d)/g, 'r$1');
    const done = () => setMsg('採点結果をクリップボードにコピーしました。', false);
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(done, () => fallbackCopy(text, done));
    else fallbackCopy(text, done);
  }
  function fallbackCopy(text, done) {
    const ta = document.createElement('textarea'); ta.value = text; document.body.appendChild(ta); ta.select();
    try { document.execCommand('copy'); done(); } catch (e) { setMsg('コピーに失敗しました。', true); }
    ta.remove();
  }

  document.addEventListener('DOMContentLoaded', init);
})();

/* =====================================================================
 * game_ui.js — 試合モード「リアルタイム・スコアシート & チーム分析ダッシュボード」の画面部分。
 * 計算は analytics.js（BBAnalytics）。画面に依存しない計算とここを分けてあるので、式の確認・変更は analytics.js だけでよい。
 * 構成:  state(記録) → refresh() → [選手別の数値/派生値, チーム合計, 相手, ダッシュボード] を毎回まるごと再計算
 * 依存: analytics.js
 * ===================================================================== */
(function () {
  'use strict';
  const A = window.BBAnalytics;
  const $ = (id) => document.getElementById(id);
  const STORAGE_KEY = 'bbtt_game_v1';
  const DEFAULT_ROWS = 8;
  const MAX_ROWS = 20;

  let state = null;
  let uid = 0;
  let saveTimer = null;

  // ------------------------------------------------------------ 状態
  function newPlayer(label) { return Object.assign({ id: 'p' + (++uid), label: label || '' }, A.emptyRecord()); }

  function defaultState() {
    const players = [];
    for (let i = 0; i < DEFAULT_ROWS; i++) players.push(newPlayer(''));
    return { meta: { team: '', opp: '', date: todayStr() }, players, opp: A.emptyRecord() };
  }

  function todayStr() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }

  function loadState() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return null;
      const s = JSON.parse(raw);
      if (!s || !Array.isArray(s.players) || !s.players.length) return null;
      const clean = (r) => { const o = A.emptyRecord(); A.FIELDS.forEach((f) => { o[f] = Math.max(0, Math.min(A.MAX_COUNT, parseInt(r && r[f], 10) || 0)); }); return o; };
      return {
        meta: Object.assign({ team: '', opp: '', date: todayStr() }, s.meta || {}),
        players: s.players.slice(0, MAX_ROWS).map((p) => Object.assign({ id: 'p' + (++uid), label: String(p.label || '').slice(0, 5) }, clean(p))),
        opp: clean(s.opp),
      };
    } catch (e) { return null; }       // プライベートブラウズ等で localStorage が使えなくても、そのまま動く
  }

  function scheduleSave() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => { try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch (e) { /* 保存できなくても記録は続けられる */ } }, 200);
  }

  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  // ------------------------------------------------------------ 表（構造）
  const SHOOT_COLS = [
    { key: 'p3', label: '3P', made: 'p3m', att: 'p3a' },
    { key: 'p2', label: '2P', made: 'p2m', att: 'p2a' },
    { key: 'ft', label: 'FT', made: 'ftm', att: 'fta' },
  ];
  const COUNT_COLS = [
    { f: 'orb', label: 'ORB' }, { f: 'drb', label: 'DRB' }, { f: 'tov', label: 'TOV' },
  ];

  function ctr(field, label, editable) {
    if (!editable) return `<div class="ctr"><span class="cv" data-f="${field}">0</span></div>`;
    return `<div class="ctr"><button type="button" class="cb up" data-f="${field}" data-d="1" aria-label="${label} ＋1">▲</button>` +
      `<span class="cv" data-f="${field}">0</span>` +
      `<button type="button" class="cb dn" data-f="${field}" data-d="-1" aria-label="${label} －1">▼</button></div>`;
  }

  function counterCells(editable) {
    let h = '';
    SHOOT_COLS.forEach((c) => {
      h += `<td class="shoot"><div class="pair">${ctr(c.made, c.label + ' 成功', editable)}<span class="slash">/</span>${ctr(c.att, c.label + ' 試投', editable)}</div></td>`;
    });
    COUNT_COLS.forEach((c) => { h += `<td class="cnt">${ctr(c.f, c.label, editable)}</td>`; });
    return h;
  }

  const DERIVED = ['pts', 'efg', 'ts', 'usg', 'eff'];
  const derivedCells = () => DERIVED.map((d) => `<td class="dv" data-dv="${d}">—</td>`).join('');

  function buildTable() {
    let h = '<thead><tr>' +
      '<th class="c-label" rowspan="2">選手の番号</th>' +
      SHOOT_COLS.map((c) => `<th class="c-shoot">${c.label}<small>成功 / 試投</small></th>`).join('') +
      COUNT_COLS.map((c) => `<th class="c-cnt">${c.label}</th>`).join('') +
      '<th class="c-dv" title="得点 = 3P×3 + 2P×2 + FT">PTS</th>' +
      '<th class="c-dv" title="有効シュート効率 = (FGM + 0.5×3PM) ÷ FGA">eFG%</th>' +
      '<th class="c-dv" title="真のシュート効率 = PTS ÷ (2×(FGA + 0.44×FTA))">TS%</th>' +
      '<th class="c-dv" title="使用率(簡易) = 選手の(FGA + 0.44×FTA + TOV) ÷ チーム合計。出場時間は使わない簡易版">USG%<small>簡易</small></th>' +
      '<th class="c-dv" title="個人効率 = 100 × PTS ÷ (FGA + 0.44×FTA + TOV)。ボールを使った100回あたりの得点">個人効率</th>' +
      '<th class="c-del" rowspan="2"></th></tr>' +
      '<tr class="sub"><th colspan="3" class="grp">タップで加減算（▲ ＋1 / ▼ －1）</th><th colspan="3" class="grp">リバウンド・ミス</th><th colspan="5" class="grp">自動計算</th></tr></thead>';
    h += '<tbody>';
    state.players.forEach((p) => {
      h += `<tr class="prow" data-rid="${p.id}"><td class="c-label"><input type="text" class="label-in" maxlength="5" placeholder="背番号" value="${esc(p.label)}" aria-label="選手の番号"></td>` +
        counterCells(true) + derivedCells() +
        `<td class="c-del"><button type="button" class="del-btn" data-del="${p.id}" title="この選手を削除" aria-label="この選手を削除">✕</button></td></tr>`;
    });
    h += '</tbody><tfoot>';
    h += '<tr class="trow" data-rid="team"><td class="c-label">チーム合計</td>' + counterCells(false) + derivedCells() + '<td></td></tr>';
    h += '<tr class="orow" data-rid="opp"><td class="c-label">相手チーム<small>合計を入力</small></td>' + counterCells(true) + derivedCells() + '<td></td></tr>';
    h += '</tfoot>';
    $('game-sheet').innerHTML = h;
    measureFooter();
  }

  /** 下に固定する「チーム合計」行の位置は、「相手チーム」行の実際の高さに合わせる */
  function measureFooter() {
    const c = document.querySelector('#game-sheet tr.orow td');
    if (c && c.offsetHeight) $('game-sheet').style.setProperty('--opp-h', c.offsetHeight + 'px');
  }

  // ------------------------------------------------------------ 再計算・描画
  function recFor(rid) {
    if (rid === 'opp') return state.opp;
    if (rid === 'team') return A.sum(state.players);
    return state.players.find((p) => p.id === rid);
  }

  function setText(el, text, cls) { el.textContent = text; if (cls !== undefined) el.className = el.className.replace(/\b(good|bad|dim)\b/g, '').trim() + (cls ? ' ' + cls : ''); }

  function refresh() {
    const team = A.sum(state.players);
    const teamB = A.basics(team);
    const tsAll = A.teamStats(team, state.opp);

    document.querySelectorAll('#game-sheet tr[data-rid]').forEach((tr) => {
      const rid = tr.dataset.rid;
      const rec = recFor(rid);
      if (!rec) return;
      tr.querySelectorAll('.cv').forEach((sp) => { sp.textContent = rec[sp.dataset.f]; });
      const st = A.playerStats(rec, team);
      const dv = (k) => tr.querySelector(`[data-dv="${k}"]`);
      setText(dv('pts'), st.empty ? '0' : String(st.pts));
      setText(dv('efg'), A.fmtPct(st.efg));
      setText(dv('ts'), A.fmtPct(st.ts));
      setText(dv('usg'), rid === 'opp' ? '—' : (rid === 'team' ? (teamB.used > 0 ? '100%' : '—') : A.fmtPct(st.usg)));
      setText(dv('eff'), A.fmtNum(st.eff, 0));
      // 選手の TS% を、チーム平均と比べて色分け（使用ポゼッション3回未満は参考外）
      let cls = '';
      if (rid !== 'team' && rid !== 'opp' && st.ts !== null && st.used >= 3 && tsAll.us.ts !== null) {
        if (st.ts >= tsAll.us.ts + 0.02) cls = 'good'; else if (st.ts <= tsAll.us.ts - 0.10) cls = 'bad';
      }
      setText(dv('ts'), A.fmtPct(st.ts), cls);
      if (st.empty) tr.classList.add('empty'); else tr.classList.remove('empty');
    });
    renderDashboard(tsAll);
    measureFooter();
  }

  const P = (x) => A.fmtPct(x);
  const pt = (d) => (d === null ? '—' : A.fmtSigned(d * 100, 1) + 'pt');

  function renderDashboard(ts) {
    const us = ts.us, op = ts.opp;
    const ff = A.compareFourFactors(ts);
    const teamName = state.meta.team.trim() || '自チーム';
    const oppName = state.meta.opp.trim() || '相手';
    const none = '<span class="dim">—</span>';
    const cell = (v, better) => `<td class="${better ? 'best' : ''}">${v}</td>`;

    // --- 得点バー
    let h = `<div class="gd-score">
      <div class="gd-team"><span class="n">${esc(teamName)}</span><span class="pts">${us.pts}</span></div>
      <div class="gd-vs">－</div>
      <div class="gd-team opp"><span class="pts">${op.pts}</span><span class="n">${esc(oppName)}</span></div>
      <div class="gd-kpis">
        <div><span class="l">ポゼッション(推計)</span><span class="v">${A.fmtNum(us.poss, 1)}</span></div>
        <div><span class="l">ORtg<small>100回あたり得点</small></span><span class="v">${A.fmtNum(us.ortg, 1)}</span></div>
        <div><span class="l">DRtg<small>100回あたり失点</small></span><span class="v">${A.fmtNum(us.drtg, 1)}</span></div>
        <div><span class="l">Net Rtg</span><span class="v ${us.net > 0 ? 'good' : (us.net < 0 ? 'bad' : '')}">${A.fmtSigned(us.net, 1)}</span></div>
      </div></div>`;

    // --- Four Factors
    h += '<div class="gd-grid"><div class="gd-box"><h4>Four Factors（勝敗を決める4要素）</h4><table class="gd-table"><thead><tr><th>指標</th><th>重み</th><th>' + esc(teamName) + '</th><th>' + esc(oppName) + '</th><th>差</th><th>判定</th></tr></thead><tbody>';
    ff.forEach((f) => {
      const verdict = f.lead === 1 ? '<span class="good">◎ 優勢</span>' : (f.lead === -1 ? '<span class="bad">▲ 劣勢</span>' : none);
      h += `<tr title="${esc(f.name)}${f.higherBetter ? '（高いほど良い）' : '（低いほど良い）'}"><th>${f.label}<small>${esc(f.name)}</small></th><td class="w">${f.weight}%</td>` +
        cell(f.us === null ? none : P(f.us), f.lead === 1) + cell(f.opp === null ? none : P(f.opp), f.lead === -1) +
        `<td>${pt(f.diff)}</td><td>${verdict}</td></tr>`;
    });
    h += '</tbody></table><p class="gd-note">TOV% は低いほど良い。ORB%・DRB% には相手の DRB・ORB が必要です。重みは D. Oliver の目安（シュート40・TO25・リバウンド20・FT15）。</p>@@INSIGHT@@</div>';

    // --- その他の主要スタッツ
    const row = (label, a, b, title) => `<tr${title ? ` title="${esc(title)}"` : ''}><th>${label}</th><td>${a}</td><td>${b}</td></tr>`;
    h += '<div class="gd-box"><h4>主要スタッツ</h4><table class="gd-table"><thead><tr><th>指標</th><th>' + esc(teamName) + '</th><th>' + esc(oppName) + '</th></tr></thead><tbody>';
    h += row('TS%<small>真のシュート効率</small>', P(us.ts), P(op.ts), 'PTS ÷ (2×(FGA + 0.44×FTA))');
    h += row('PPP<small>1ポゼッション得点</small>', A.fmtNum(us.ppp, 2), A.fmtNum(op.ppp, 2), 'PTS ÷ Poss');
    h += row('FG%', P(us.fgPct), P(op.fgPct));
    h += row('3P%', P(us.p3Pct), P(op.p3Pct));
    h += row('FT%', P(us.ftPct), P(op.ftPct));
    h += row('3P試投比率<small>3PA ÷ FGA</small>', P(us.p3Rate), P(op.p3Rate));
    h += row('DRB%<small>守備リバウンド率</small>', P(us.drbPct), P(op.drbPct), 'DRB ÷ (DRB + 相手ORB)');
    h += row('REB%<small>全リバウンド率</small>', P(us.rebPct), P(op.rebPct));
    h += '</tbody></table></div></div>';

    // --- ひとこと診断
    const msgs = [];
    const have = ff.filter((f) => f.us !== null && f.opp !== null);
    if (!ts.oppEntered) {
      msgs.push('相手チームの記録（特に ORB / DRB）を入力すると、ORB%・DRB%・DRtg・Net Rtg と4要素の比較が出ます。');
    } else if (have.length) {
      const win = have.filter((f) => f.lead === 1).map((f) => f.label);
      const lose = have.filter((f) => f.lead === -1).map((f) => f.label);
      msgs.push(`<b>4要素のうち ${win.length} 要素で優勢。</b>` + (win.length ? ` 優勢: ${win.join('・')}` : '') + (lose.length ? ` ／ 課題: ${lose.join('・')}` : ''));
    }
    if (us.poss !== null && us.poss < 20) msgs.push(`※ ポゼッションがまだ ${A.fmtNum(us.poss, 0)} 回と少ないため、数字は大きく振れます（参考値）。`);
    const insight = `<div class="gd-insight">${msgs.map((m) => `<p>${m}</p>`).join('') || '<p class="dim">数値を入力すると、ここに4要素の診断が表示されます。</p>'}</div>`;
    $('game-dashboard').innerHTML = h.replace('@@INSIGHT@@', insight);
  }

  // ------------------------------------------------------------ 操作
  function onSheetClick(e) {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.dataset.del) { removePlayer(b.dataset.del); return; }
    if (!b.dataset.f) return;
    const rec = recFor(b.closest('tr').dataset.rid);
    if (!rec) return;
    A.applyDelta(rec, b.dataset.f, parseInt(b.dataset.d, 10));
    refresh();
    scheduleSave();
  }

  function onSheetInput(e) {
    if (!e.target.classList.contains('label-in')) return;
    const p = recFor(e.target.closest('tr').dataset.rid);
    if (p) { p.label = e.target.value; scheduleSave(); }
  }

  function addPlayer() {
    if (state.players.length >= MAX_ROWS) { alert(`選手は最大 ${MAX_ROWS} 人までです。`); return; }
    state.players.push(newPlayer(''));
    buildTable(); refresh(); scheduleSave();
    const inputs = document.querySelectorAll('#game-sheet .label-in');
    if (inputs.length) inputs[inputs.length - 1].focus();
  }

  function removePlayer(id) {
    if (state.players.length <= 1) { alert('選手の行は最低 1 行必要です。'); return; }
    const p = state.players.find((x) => x.id === id);
    if (!p) return;
    if (!A.basics(p).isEmpty && !confirm(`${p.label ? '「' + p.label + '」' : 'この選手'}の記録を削除します。よろしいですか？\n（チーム合計からも引かれます）`)) return;
    state.players = state.players.filter((x) => x.id !== id);
    buildTable(); refresh(); scheduleSave();
  }

  function resetCounts() {
    if (!confirm('すべての記録（数値）を 0 に戻します。選手の番号とチーム名は残ります。よろしいですか？\n※ 先に CSV を保存することをおすすめします。')) return;
    state.players.forEach((p) => A.FIELDS.forEach((f) => { p[f] = 0; }));
    A.FIELDS.forEach((f) => { state.opp[f] = 0; });
    refresh(); scheduleSave();
  }

  // ------------------------------------------------------------ CSV
  function csvCell(v) {
    let s = v === null || v === undefined ? '' : String(v);
    if (/^[=+\-@\t\r]/.test(s) && !/^-?\d+(\.\d+)?$/.test(s)) s = "'" + s;   // 表計算ソフトの数式として解釈されるのを防ぐ
    return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }
  const line = (arr) => arr.map(csvCell).join(',');
  const pc = (x, d) => (x === null || x === undefined ? '' : (100 * x).toFixed(d === undefined ? 1 : d));   // CSV の % は「52.3」のように単位なしの数値
  const nm = (x, d) => (x === null || x === undefined ? '' : x.toFixed(d === undefined ? 1 : d));

  function buildCsv() {
    const team = A.sum(state.players);
    const ts = A.teamStats(team, state.opp);
    const ff = A.compareFourFactors(ts);
    const now = new Date();
    const rows = [];
    rows.push(line(['試合情報']));
    rows.push(line(['自チーム', state.meta.team]));
    rows.push(line(['相手チーム', state.meta.opp]));
    rows.push(line(['試合日', state.meta.date]));
    rows.push(line(['出力日時', now.toLocaleString('ja-JP')]));
    rows.push(line(['注', '% の列は百分率（52.3 = 52.3%）。USG%は出場時間を使わない簡易値。']));
    rows.push('');
    rows.push(line(['選手別スコアシート']));
    rows.push(line(['区分', '選手の番号', '3PM', '3PA', '2PM', '2PA', 'FTM', 'FTA', 'ORB', 'DRB', 'TOV', 'PTS', 'FGM', 'FGA', 'FG%', 'eFG%', 'TS%', 'USG%(簡易)', '個人効率']));
    const rec = (kind, label, r, usgBase) => {
      const s = A.playerStats(r, team);
      return line([kind, label, r.p3m, r.p3a, r.p2m, r.p2a, r.ftm, r.fta, r.orb, r.drb, r.tov, s.pts, s.fgm, s.fga,
        pc(s.fgPct), pc(s.efg), pc(s.ts), usgBase === 'team' ? (s.used > 0 ? '100.0' : '') : (usgBase === 'opp' ? '' : pc(s.usg)), nm(s.eff, 1)]);
    };
    state.players.forEach((p) => rows.push(rec('選手', p.label, p, 'p')));
    rows.push(rec('チーム合計', '', team, 'team'));
    rows.push(rec('相手チーム', '', state.opp, 'opp'));
    rows.push('');
    rows.push(line(['チーム分析', '自チーム', '相手チーム', '差(自-相手)', '判定']));
    rows.push(line(['【Four Factors】']));
    ff.forEach((f) => rows.push(line([`${f.label}(${f.name})`, pc(f.us), pc(f.opp), f.diff === null ? '' : (100 * f.diff).toFixed(1), f.lead === 1 ? '優勢' : (f.lead === -1 ? '劣勢' : '')])));
    rows.push(line(['【主要スタッツ】']));
    const u = ts.us, o = ts.opp;
    const both = (label, a, b) => rows.push(line([label, a, b]));
    both('得点', u.pts, o.pts);
    both('ポゼッション(推計)', nm(u.poss), nm(o.poss));
    both('ORtg(100回あたり得点)', nm(u.ortg), nm(o.ortg));
    both('DRtg(100回あたり失点)', nm(u.drtg), nm(o.drtg));
    both('Net Rtg', nm(u.net), nm(o.net));
    both('PPP', nm(u.ppp, 2), nm(o.ppp, 2));
    both('TS%', pc(u.ts), pc(o.ts));
    both('FG%', pc(u.fgPct), pc(o.fgPct));
    both('3P%', pc(u.p3Pct), pc(o.p3Pct));
    both('FT%', pc(u.ftPct), pc(o.ftPct));
    both('3P試投比率', pc(u.p3Rate), pc(o.p3Rate));
    both('DRB%', pc(u.drbPct), pc(o.drbPct));
    both('REB%', pc(u.rebPct), pc(o.rebPct));
    return '﻿' + rows.join('\r\n');            // BOM付き: Excel で日本語が文字化けしない
  }

  function exportCsv() {
    const blob = new Blob([buildCsv()], { type: 'text/csv;charset=utf-8;' });
    const now = new Date();
    const p2 = (n) => String(n).padStart(2, '0');
    const name = `scoresheet_${now.getFullYear()}${p2(now.getMonth() + 1)}${p2(now.getDate())}_${p2(now.getHours())}${p2(now.getMinutes())}${p2(now.getSeconds())}.csv`;
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = name;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    setTimeout(() => URL.revokeObjectURL(link.href), 1000);
  }

  // ------------------------------------------------------------ 初期化
  function init() {
    if (!$('game-sheet') || !A) return;
    state = loadState() || defaultState();
    $('game-team').value = state.meta.team;
    $('game-opp').value = state.meta.opp;
    $('game-date').value = state.meta.date;
    buildTable();
    refresh();
    $('game-sheet').addEventListener('click', onSheetClick);
    $('game-sheet').addEventListener('input', onSheetInput);
    window.addEventListener('resize', measureFooter);
    $('game-add-player').addEventListener('click', addPlayer);
    $('game-export-csv').addEventListener('click', exportCsv);
    $('game-reset').addEventListener('click', resetCounts);
    [['game-team', 'team'], ['game-opp', 'opp'], ['game-date', 'date']].forEach(([id, key]) => {
      $(id).addEventListener('input', () => { state.meta[key] = $(id).value; refresh(); scheduleSave(); });
    });
  }

  window.BBGame = { getState: () => state, buildCsv, refresh };
  document.addEventListener('DOMContentLoaded', init);
})();

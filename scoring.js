/* =====================================================================
 * scoring.js — 採点モードの計算部分（DOM に依存しない。ブラウザ・Node 両対応）
 *   ボード上の記録（recordedData: 赤=攻撃 / 青=守備 のキーフレーム）を読み取り、機械学習なしで次を計算する。
 *     1) シュート機会の質      : 最終シュート（または指定した時点）の期待得点。守備者 = ボードに置いた青駒の位置
 *     2) より良い選択肢        : その瞬間に他の選手が受けていたら？（パスコースの妨害も簡易判定）
 *     3) 関与人数・スペーシング・パス/ドリブルの量
 *     4) 近い基本戦術          : 登録済みマクロのうち、どれに近い動きか（再配置したマクロとの位置のずれで判定。目安）
 *     5) AI案との比較          : 同じ初期配置・同じボール保持者・同じ選手でのAI案の期待得点
 *   期待得点 = (エリア別シュート率) x (得点価値 2点/3点) x (守備者の接近による減衰)。案どうしを比べる指標で、実戦の得点の予測ではない。
 * ===================================================================== */
(function (root) {
  'use strict';
  const E = (typeof require !== 'undefined' && typeof module !== 'undefined' && typeof root.BBEngine === 'undefined')
    ? require('./engine.js') : root.BBEngine;

  const FRAME_DT = 0.5;
  const MOVE_PX = 60;          // これ以上動いたら「動いた選手」
  const PASS_EQ_PX = 100;      // パス1回 = ドリブル何px分として drive_score を出すか（マクロ側と同じ定義）
  const PIECE_IDS_RED = [1, 2, 3, 4, 5].map((i) => 'red' + i);
  const PIECE_IDS_BLUE = [1, 2, 3, 4, 5].map((i) => 'blue' + i);

  const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
  function pointSegDist(p, a, b) {
    const abx = b[0] - a[0], aby = b[1] - a[1], l2 = abx * abx + aby * aby;
    if (l2 < 1e-9) return dist(p, a);
    const t = Math.min(1, Math.max(0, ((p[0] - a[0]) * abx + (p[1] - a[1]) * aby) / l2));
    return Math.hypot(p[0] - (a[0] + t * abx), p[1] - (a[1] + t * aby));
  }
  const shortId = (id) => String(id).replace('red', 'r').replace('blue', 'b');

  // ------------------------------------------------------------------ タイムライン化
  // recordedData（疎なキーフレーム）→ 0.5秒刻みの配置。位置は線形補間、ボール保持者は「次のキーフレームまで直前のキーフレームのまま」
  function buildTimeline(frames, pieceOffset) {
    if (!Array.isArray(frames) || frames.length < 2) throw new Error('キーフレームが2つ以上必要です。「この時間の配置を保存」で、動きの途中と最後の配置を記録してください。');
    const warnings = [];
    const byT = new Map();
    frames.forEach((f) => { byT.set(Math.round(parseFloat(f.timestamp) * 10) / 10, f); });     // 同じ時刻は後勝ち
    const times = Array.from(byT.keys()).sort((a, b) => a - b);
    if (times.length < 2) throw new Error('時刻の異なるキーフレームが2つ以上必要です。');
    const ks = times.map((t) => {
      const f = byT.get(t), map = {};
      f.positions.forEach((p) => { map[p.id] = p; });
      const red = [], blue = [];
      PIECE_IDS_RED.forEach((id) => { if (!map[id]) throw new Error(`${t.toFixed(1)}秒のキーフレームに ${shortId(id)} がありません。`); red.push([Number(map[id].x) + pieceOffset, Number(map[id].y) + pieceOffset]); });
      PIECE_IDS_BLUE.forEach((id) => { if (!map[id]) throw new Error(`${t.toFixed(1)}秒のキーフレームに ${shortId(id)} がありません。`); blue.push([Number(map[id].x) + pieceOffset, Number(map[id].y) + pieceOffset]); });
      const holders = PIECE_IDS_RED.map((id, i) => (Number(map[id].ball) === 1 ? i : -1)).filter((i) => i >= 0);
      const blueHas = PIECE_IDS_BLUE.some((id) => Number(map[id].ball) === 1);
      if (holders.length > 1) warnings.push(`${t.toFixed(1)}秒: 赤の複数の駒がボールを持っています（最初の駒を採用）。`);
      if (blueHas) warnings.push(`${t.toFixed(1)}秒: 青の駒がボールを持っています（攻撃側の保持としては数えません）。`);
      return { t, red, blue, holder: holders.length ? holders[0] : -1 };
    });
    const t0 = ks[0].t, tN = ks[ks.length - 1].t;
    const grid = [];
    for (let g = t0; g <= tN + 1e-9; g += FRAME_DT) grid.push(Math.round(g * 10) / 10);
    if (grid[grid.length - 1] < tN - 1e-6) grid.push(tN);
    const tl = { t: [], red: [], blue: [], holder: [], keyTimes: times, warnings };
    const lerp2 = (a, b, w) => [a[0] + (b[0] - a[0]) * w, a[1] + (b[1] - a[1]) * w];
    grid.forEach((g) => {
      let j = ks.length - 1;
      for (let q = 0; q < ks.length - 1; q++) if (g >= ks[q].t - 1e-9 && g < ks[q + 1].t - 1e-9) { j = q; break; }
      if (j === ks.length - 1) {
        tl.red.push(ks[j].red.map((p) => p.slice())); tl.blue.push(ks[j].blue.map((p) => p.slice())); tl.holder.push(ks[j].holder);
      } else {
        const w = (g - ks[j].t) / (ks[j + 1].t - ks[j].t);
        tl.red.push(ks[j].red.map((p, i) => lerp2(p, ks[j + 1].red[i], w)));
        tl.blue.push(ks[j].blue.map((p, i) => lerp2(p, ks[j + 1].blue[i], w)));
        tl.holder.push(ks[j].holder);
      }
      tl.t.push(g);
    });
    return tl;
  }

  function nearestIndex(arr, v) {
    let bi = 0, bd = 1e18;
    arr.forEach((x, i) => { const d = Math.abs(x - v); if (d < bd) { bd = d; bi = i; } });
    return bi;
  }
  const minDefDist = (tl, k, pos) => { let d = 1e18; for (let j = 0; j < 5; j++) d = Math.min(d, dist(tl.blue[k][j], pos)); return d; };
  const pathLen = (arr, p, k0, k1) => { let s = 0; for (let k = k0 + 1; k <= k1; k++) s += dist(arr[k][p], arr[k - 1][p]); return s; };

  // ------------------------------------------------------------------ 近い基本戦術の判定（目安）
  // 各マクロを「ユーザーの配置から始まる形」に再配置（engine.realize）し、ユーザーの実際の動きとの平均位置ずれを測る。
  // 開始時刻をずらしながら探す。ボールを持った選手がマクロの「ハンドラー」に対応する割当（24通り）を全部試す。
  // 採用の条件: ① 平均位置ずれ <= thrPx  ② 「その場で動かない」と仮定したときのずれより、minExplained 以上小さい（=動きを説明できている）
  //             ③ ユーザーの動きがマクロより明らかに小さくない。重なる区間は、ずれの小さい方を優先して貪欲に採用する。
  function recognizeMacros(engine, tl, endIdx, thrPx, minExplained, minStaticPx) {
    thrPx = thrPx === undefined ? 30 : thrPx;
    minExplained = minExplained === undefined ? 0.4 : minExplained;
    minStaticPx = minStaticPx === undefined ? 4 : minStaticPx;
    const ids = engine.ids, out = [], skipped = [];
    ids.forEach((id) => {
      const mm = engine.meta[id], n = mm.att.length;
      const Pm = mm.path_px.reduce((a, b) => a + b, 0);
      if (Pm < 25 || n < 2) { skipped.push(mm.name_jp); return; }     // 動きがほぼ無いマクロは、静止との区別がつかないので対象外
      for (let i0 = 0; i0 + n - 1 <= endIdx; i0++) {
        const h0 = tl.holder[i0];
        if (h0 < 0) continue;
        const cur = tl.red[i0];
        let Pu = 0; for (let p = 0; p < 5; p++) Pu += pathLen(tl.red, p, i0, i0 + n - 1);
        if (Pu < 0.4 * Pm) continue;                                   // ユーザーの動きがマクロより明らかに小さい区間は対象外
        let staticErr = 0; for (let k = 0; k < n; k++) for (let p = 0; p < 5; p++) staticErr += dist(tl.red[i0 + k][p], tl.red[i0][p]);
        staticErr /= (n * 5);
        if (staticErr < minStaticPx) continue;                          // ほぼ動いていない区間は判定しない
        const hs = mm.roles.handler;
        let best = null;
        for (let a = 0; a < E.PERMS.length; a++) {
          const perm = E.PERMS[a];
          if (perm[h0] !== hs) continue;                                // ボールを持った選手 = マクロのハンドラー
          const seg = engine.realize(mm.att, mm, perm, cur).seg;
          let e = 0; for (let k = 0; k < n; k++) for (let p = 0; p < 5; p++) e += dist(seg[k][p], tl.red[i0 + k][p]);
          e /= (n * 5);
          if (best === null || e < best.err) best = { err: e, perm };
        }
        if (best) out.push({ id, name: mm.name_jp, i0, n, err: best.err, perm: best.perm, staticErr, explained: 1 - best.err / staticErr });
      }
    });
    const perMacro = {};                                               // マクロごとに最も近い区間（閾値なし。参考表示用）
    out.forEach((r) => { if (!perMacro[r.id] || r.err < perMacro[r.id].err) perMacro[r.id] = r; });
    const closest = Object.keys(perMacro).map((k) => perMacro[k]).sort((a, b) => a.err - b.err).slice(0, 3);
    const cover = new Array(tl.t.length).fill(false), chosen = [];
    out.filter((r) => r.err <= thrPx && r.explained >= minExplained).sort((a, b) => a.err - b.err).forEach((r) => {
      let overlap = 0; for (let k = r.i0; k <= r.i0 + r.n - 1; k++) if (cover[k]) overlap++;
      if (overlap > 1) return;                                          // 重なりは境界の1フレームまで
      for (let k = r.i0; k <= r.i0 + r.n - 1; k++) cover[k] = true;
      chosen.push(r);
    });
    chosen.sort((a, b) => a.i0 - b.i0);
    const segments = chosen.map((r) => ({
      id: r.id, name: r.name, t0: tl.t[r.i0], t1: tl.t[r.i0 + r.n - 1], err_px: r.err, explained: r.explained,
      alt: out.filter((q) => q.i0 === r.i0 && q.id !== r.id && q.err <= r.err + 8).sort((a, b) => a.err - b.err).slice(0, 2).map((q) => q.name),
    }));
    let covered = 0; for (let k = 0; k <= endIdx; k++) if (cover[k]) covered++;
    return { skipped, segments, closest: closest.map((r) => ({ id: r.id, name: r.name, t0: tl.t[r.i0], t1: tl.t[r.i0 + r.n - 1], err_px: r.err })),
             coverage: endIdx > 0 ? Math.min(1, covered / (endIdx + 1)) : 0 };
  }

  // ------------------------------------------------------------------ AI案との比較
  function aiCompare(engine, tl, players) {
    if (!engine.ids.length) return null;
    let h0 = tl.holder[0];
    if (h0 < 0) { h0 = tl.holder.find((h) => h >= 0); if (h0 === undefined) h0 = 0; }
    const res = engine.suggest(tl.red[0].map((p) => p.slice()), players, { ballHolder: h0, topK: 3, minMacros: 2, defInit: tl.blue[0].map((p) => p.slice()) });
    if (!res.length) return null;
    return { best: res[0], all: res };
  }

  // ------------------------------------------------------------------ 採点本体
  function scorePlay(engine, frames, profiles, opts) {
    opts = Object.assign({ shotTime: null, ai: true, macros: true, errThresholdPx: 30, minExplained: 0.4 }, opts || {});
    const G = engine.G, ft = (px) => px / G.pxPerFt;
    const players = E.normalizePlayers(profiles);
    const tl = buildTimeline(frames, G.pieceOffset);
    const last = tl.t.length - 1;
    const shotIdx = (opts.shotTime === null || opts.shotTime === undefined) ? last : nearestIndex(tl.t, opts.shotTime);

    // シューター: シュート時点でボールを持つ赤の駒。持っていなければ、それ以前に最後に持った駒（ボールが空中にある場合）
    let shooter = tl.holder[shotIdx];
    if (shooter < 0) for (let k = shotIdx; k >= 0; k--) if (tl.holder[k] >= 0) { shooter = tl.holder[k]; break; }
    if (shooter < 0) throw new Error('ボールを持った赤の駒が、シュート時点までに一度もありません。シュートを打つ選手に、ボール保持者を設定してください。');

    const spos = tl.red[shotIdx][shooter];
    const dOpen = minDefDist(tl, shotIdx, spos);
    const shot = engine.epAt(players[shooter], spos, dOpen);
    const mult = engine.openMult(dOpen);

    // 途中の得点機会（ボールを持っている各時点）
    const opps = [];
    for (let k = 0; k <= shotIdx; k++) {
      const h = tl.holder[k] >= 0 ? tl.holder[k] : (k === shotIdx ? shooter : -1);
      if (h < 0) continue;
      const pos = tl.red[k][h], d = minDefDist(tl, k, pos), e = engine.epAt(players[h], pos, d);
      opps.push({ k, t: tl.t[k], player: h, ep: e.ep, zone: e.zone, fg: e.fg, open_px: d });
    }
    const bestOpp = opps.reduce((b, o) => (b === null || o.ep > b.ep ? o : b), null);
    const startOpp = opps.length ? opps[0] : null;

    // シュート時点で、他の選手が同じ場面で受けていたら（パスコースの妨害を簡易判定）
    const alternatives = [];
    for (let p = 0; p < 5; p++) {
      if (p === shooter) continue;
      const pos = tl.red[shotIdx][p], d = minDefDist(tl, shotIdx, pos), e = engine.epAt(players[p], pos, d);
      let blocked = false;
      for (let j = 0; j < 5; j++) if (pointSegDist(tl.blue[shotIdx][j], spos, pos) < 22) { blocked = true; break; }
      alternatives.push({ player: p, id: players[p].id, ep: e.ep, zone: e.zone, area_name: E.AREA_NAMES[e.zone], fg: e.fg, open_px: d, lane_open: !blocked, pos });
    }
    alternatives.sort((a, b) => b.ep - a.ep);

    // シューターの得意エリア（守備なしの期待値）
    let bestZone = 1, bestZoneEp = -1;
    for (let z = 1; z <= 10; z++) { const v = players[shooter].fg[z - 1] * engine.ptsOf(z); if (v > bestZoneEp) { bestZoneEp = v; bestZone = z; } }
    const shotOpenEp = shot.fg * engine.ptsOf(shot.zone);

    // 関与人数
    const involved = [];
    for (let p = 0; p < 5; p++) {
      const touched = tl.holder.slice(0, shotIdx + 1).indexOf(p) >= 0;
      if (touched || pathLen(tl.red, p, 0, shotIdx) >= MOVE_PX) involved.push(p);
    }
    // パス・ドリブル
    const seq = tl.holder.slice(0, shotIdx + 1).filter((h) => h >= 0);
    let nPass = 0; for (let i = 1; i < seq.length; i++) if (seq[i] !== seq[i - 1]) nPass++;
    let dribble = 0;
    for (let k = 0; k < shotIdx; k++) if (tl.holder[k] >= 0 && tl.holder[k] === tl.holder[k + 1]) dribble += dist(tl.red[k + 1][tl.holder[k]], tl.red[k][tl.holder[k]]);
    const den = dribble + PASS_EQ_PX * nPass, driveScore = den > 1e-6 ? dribble / den : 0.5;
    // スペーシング
    let minPair = 1e18, closeFrames = 0;
    for (let k = 0; k <= shotIdx; k++) {
      let frameMin = 1e18;
      for (let i = 0; i < 5; i++) for (let j = i + 1; j < 5; j++) frameMin = Math.min(frameMin, dist(tl.red[k][i], tl.red[k][j]));
      minPair = Math.min(minPair, frameMin);
      if (frameMin < 20.5) closeFrames++;                         // 22px(約2ft)未満。駒の座標は整数pxに丸められるので 1.5px の余裕を見る
    }

    const result = {
      meta: { keyframes: tl.keyTimes.length, duration: tl.t[last], shot_time: tl.t[shotIdx], shot_is_last: shotIdx === last, warnings: tl.warnings },
      shot: { player: shooter, id: players[shooter].id, zone: shot.zone, area_name: E.AREA_NAMES[shot.zone], fg: shot.fg, ep: shot.ep,
              open_px: dOpen, open_ft: ft(dOpen), mult, pos: spos, t: tl.t[shotIdx], height_cm: players[shooter].height_cm,
              best_zone: bestZone, best_zone_name: E.AREA_NAMES[bestZone], best_zone_fg: players[shooter].fg[bestZone - 1], best_zone_ep: bestZoneEp,
              efficiency: bestZoneEp > 0 ? shotOpenEp / bestZoneEp : 0 },
      start_ep: startOpp ? startOpp.ep : null,
      improvement: startOpp ? shot.ep - startOpp.ep : null,
      best_opportunity: bestOpp,
      alternatives,
      involved: involved.map((p) => players[p].id),
      not_involved: [0, 1, 2, 3, 4].filter((p) => involved.indexOf(p) < 0).map((p) => players[p].id),
      passes: nPass, dribble_px: dribble, drive_score: driveScore,
      spacing: { min_pair_px: minPair, min_pair_ft: ft(minPair), close_frames: closeFrames },
      macros: null, ai: null, comments: [],
    };
    const ids = (arr) => arr.map(shortId).join('・');

    if (opts.macros && engine.ids.length) result.macros = recognizeMacros(engine, tl, shotIdx, opts.errThresholdPx, opts.minExplained);
    if (opts.ai && engine.ids.length) {
      const ai = aiCompare(engine, tl, players);
      if (ai) result.ai = { chain_jp: ai.best.chain_jp, ep: ai.best.best_shot.ep, shooter: ai.best.best_shot.shooter_id, area_name: ai.best.best_shot.area_name,
                            duration: ai.best.duration_seconds, improvement: ai.best.improvement, plan: ai.best, diff: shot.ep - ai.best.best_shot.ep };
    }

    // ---- 自動コメント（ルールに基づく目安。数字つきで出す）
    const C = result.comments;
    if (result.improvement !== null) {
      if (result.improvement >= 0.05) C.push({ kind: 'good', text: `最終シュートの期待得点は、開始直後にそのまま打つ場合より ${result.improvement.toFixed(2)} 高い（${result.start_ep.toFixed(2)} → ${shot.ep.toFixed(2)}）。動きでよい機会を作れています。` });
      else if (result.improvement <= -0.05) C.push({ kind: 'warn', text: `最終シュートの期待得点は、開始直後に打つ場合より ${(-result.improvement).toFixed(2)} 低い（${result.start_ep.toFixed(2)} → ${shot.ep.toFixed(2)}）。動いたことで、機会が悪くなっています。` });
      else C.push({ kind: 'info', text: `最終シュートの期待得点は、開始直後に打つ場合と同程度（${result.start_ep.toFixed(2)} → ${shot.ep.toFixed(2)}）。動きの効果は見えていません。` });
    }
    if (mult <= 0.7) C.push({ kind: 'warn', text: `シュート時、最も近い守備者が ${result.shot.open_ft.toFixed(1)}ft と近く、成功率が ×${mult.toFixed(2)} に下がっています。` });
    else if (mult >= 0.99) C.push({ kind: 'good', text: `シュート時、最も近い守備者まで ${result.shot.open_ft.toFixed(1)}ft あり、ほぼフリーです。` });
    const betterAlt = alternatives.find((a) => a.lane_open && a.ep - shot.ep >= 0.15);
    if (betterAlt) C.push({ kind: 'warn', text: `シュート時点では、${shortId(betterAlt.id)} が ${betterAlt.area_name} で期待得点 ${betterAlt.ep.toFixed(2)} の位置にいました（実際は ${shot.ep.toFixed(2)}）。パスコースも空いています。` });
    else if (alternatives.length && alternatives[0].ep - shot.ep >= 0.15) C.push({ kind: 'info', text: '他の選手の方が期待得点の高い位置にいましたが、パスコースが守備者に塞がれています。' });
    if (result.shot.efficiency < 0.7) C.push({ kind: 'info', text: `${shortId(players[shooter].id)} の最も期待値の高いエリアは ${result.shot.best_zone_name}（FG ${(result.shot.best_zone_fg * 100).toFixed(0)}% × ${engine.ptsOf(bestZone)}点）です。実際に打ったエリアは、それの ${(result.shot.efficiency * 100).toFixed(0)}% です。` });
    if (result.not_involved.length >= 2) C.push({ kind: 'warn', text: `${ids(result.not_involved)} が、ほとんど動かず、ボールにも触れていません（関与 ${involved.length}/5人）。` });
    else if (result.not_involved.length === 1) C.push({ kind: 'info', text: `${ids(result.not_involved)} は、動かず、ボールにも触れていません。` });
    if (closeFrames > 0) C.push({ kind: 'warn', text: `赤の駒どうしが 約2ft 未満に近づいた場面が ${closeFrames} 回あります（最小 ${result.spacing.min_pair_ft.toFixed(1)}ft）。スペースが詰まっています。` });
    if (result.ai) {
      if (result.ai.diff >= -0.05) C.push({ kind: 'good', text: `同じ初期配置でのAI案（${result.ai.chain_jp.join(' → ')}）と同程度か、それ以上の期待得点です（あなた ${shot.ep.toFixed(2)} / AI ${result.ai.ep.toFixed(2)}）。` });
      else C.push({ kind: 'info', text: `同じ初期配置でのAI案の方が、期待得点が ${(-result.ai.diff).toFixed(2)} 高くなっています（あなた ${shot.ep.toFixed(2)} / AI ${result.ai.ep.toFixed(2)}）。AI案をボードに読み込んで、動きを見比べられます。` });
    }
    result.text = buildText(result);
    return result;
  }

  function buildText(r) {
    const L = [];
    L.push(`【採点結果】キーフレーム ${r.meta.keyframes} 個 / 長さ ${r.meta.duration.toFixed(1)}秒 / シュート時点 ${r.meta.shot_time.toFixed(1)}秒${r.meta.shot_is_last ? '（最後のキーフレーム）' : '（指定）'}`);
    L.push(`最終シュート: ${shortId(r.shot.id)}（${r.shot.height_cm.toFixed(0)}cm）が ${r.shot.area_name} から。FG ${(r.shot.fg * 100).toFixed(0)}% / 守備者まで ${r.shot.open_ft.toFixed(1)}ft（補正 ×${r.shot.mult.toFixed(2)}） → 期待得点 ${r.shot.ep.toFixed(2)}`);
    if (r.improvement !== null) L.push(`開始直後に打つ場合: ${r.start_ep.toFixed(2)} → 差 ${r.improvement >= 0 ? '+' : ''}${r.improvement.toFixed(2)}`);
    L.push(`関与: ${r.involved.length}/5人（${r.involved.map(shortId).join('・')}） / パス ${r.passes}回 / ドリブル ${(r.dribble_px / 10.55).toFixed(0)}ft / ドライブ寄り度 ${r.drive_score.toFixed(2)}`);
    L.push(`スペーシング: 赤どうしの最小距離 ${r.spacing.min_pair_ft.toFixed(1)}ft（約2ft未満 ${r.spacing.close_frames}回）`);
    if (r.macros) L.push('近い基本戦術（目安）: ' + (r.macros.segments.length ? r.macros.segments.map((s) => `${s.t0.toFixed(1)}-${s.t1.toFixed(1)}秒 ${s.name}`).join(' → ') : '該当なし'));
    if (r.ai) L.push(`AI案: ${r.ai.chain_jp.join(' → ')}（${r.ai.duration}秒） 期待得点 ${r.ai.ep.toFixed(2)}（あなたとの差 ${r.shot.ep - r.ai.ep >= 0 ? '+' : ''}${(r.shot.ep - r.ai.ep).toFixed(2)}）`);
    r.comments.forEach((c) => L.push('・' + c.text));
    return L.join('\n');
  }

  const api = { buildTimeline, scorePlay, recognizeMacros, aiCompare };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.BBScoring = api;
})(typeof globalThis !== 'undefined' ? globalThis : (typeof window !== 'undefined' ? window : this));

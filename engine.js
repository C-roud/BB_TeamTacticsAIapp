/* =====================================================================
 * engine.js — 戦術提案エンジン（chain_search.py の JavaScript 移植版 / ブラウザ・Node 両対応）
 *   入力  : 初期配置(5人の駒の中心座標[px]) / 選手プロフィール(身長・10エリア別シュート率) / ボール保持者 / drive-pass重み
 *   処理  : マクロ(15種)をテンプレとして初期配置へ再配置 → 役割割当 → 守備シミュレーション → 期待得点(EP)でビームサーチ
 *   出力  : 上位K件のセットオフェンス（0.5秒ごとのフレーム・得点機会・説明文）
 * 座標系: コート画像(court.jpg)を表示したコンテナの px。x=ベースライン(0)→ハーフライン、y=上サイドライン(0)→下サイドライン
 * 重要な前提（卒論で正直に書くべき点）:
 *   - 守備は「各攻撃選手にマンツーマンで追従する簡易モデル」。期待得点 = (エリア別シュート率) x (得点価値 2or3) x (守備者の接近による減衰)
 *   - プロフィールの成功率は「フリー(守備なし)で測った値」として扱う（fgBasis='free'）。試合の得点を予測するものではなく、案を比較する指標
 * ===================================================================== */
(function (root) {
  'use strict';

  // ------------------------------------------------------------------ コート幾何（court.jpg を画素解析して決めた値）
  // court.jpg(629x340) をコンテナ(1000x536)に contain で表示 → 倍率 1.5765。以下は表示後の px。
  // 10エリアの定義は main.js の AREA_DEFINITIONS に合わせている:
  //   1 右コーナー3P / 2 右ウィング3P / 3 トップ3P / 4 左ウィング3P / 5 左コーナー3P /
  //   6 右ミドル / 7 左ミドル / 8 ハイポスト / 9 ゴール下(右) / 10 ゴール下(左)
  //   「右」= 攻める選手がリングを向いたときの右手側 = 画面の上側(y が小さい側)。逆なら flipLR を true に。
  const S = 536 / 340;
  const GEOM_APP = {
    name: 'app',
    courtX: 314.5 * S,            // ハーフラインまでの長さ
    courtY: 336 * S,              // サイドライン間の幅
    ring: [37 * S, 168 * S],      // リング中心
    arcCenter: [51.4 * S, 168 * S], arcR: 150.6 * S,   // 3Pアーク（円弧の中心と半径）
    cornerHalfW: 148 * S, cornerXMax: 79.3 * S,        // コーナー3P: 中央からの距離>=cornerHalfW かつ x<=cornerXMax
    laneHalfW: 55 * S,            // ペイント半幅
    hpX: 150,                     // ★ゴール下とハイポストの境界(x)。アプリの定義に合わせて調整可
    wingDeg: 30, midDeg: 30,      // 3Pの「トップ/ウィング」境界角
    pieceOffset: 15,              // 駒(30x30)の left/top → 中心 への補正
    pxPerFt: 10.55,               // 1ft あたりの px（コート長94ft ↔ 991.6px）
    flipLR: false,
    areaOf: null,
  };
  function makeAppAreaOf(G) {
    return function areaOf(x, y) {
      const dx = x - G.ring[0], dy = y - G.ring[1];
      const ang = Math.atan2(dy, dx) * 180 / Math.PI;
      const corner = Math.abs(y - G.ring[1]) >= G.cornerHalfW && x <= G.cornerXMax;
      const rr = Math.hypot(x - G.arcCenter[0], y - G.arcCenter[1]);
      let a;
      if (corner || rr >= G.arcR) {                       // 3P
        if (corner) a = dy < 0 ? 1 : 5;
        else a = ang < -G.wingDeg ? 2 : (ang > G.wingDeg ? 4 : 3);
      } else if (Math.abs(dy) <= G.laneHalfW) {           // ペイント幅の内側
        a = x <= G.hpX ? (dy < 0 ? 9 : 10) : 8;           // ゴール下(右/左) / ハイポスト
      } else {
        a = dy < 0 ? 6 : 7;                               // 右ミドル / 左ミドル
      }
      if (G.flipLR) a = ({ 1: 5, 5: 1, 2: 4, 4: 2, 6: 7, 7: 6, 9: 10, 10: 9 })[a] || a;
      return a;
    };
  }
  GEOM_APP.areaOf = makeAppAreaOf(GEOM_APP);

  const AREA_NAMES = { 1: '右コーナー3P', 2: '右ウィング3P', 3: 'トップ3P', 4: '左ウィング3P', 5: '左コーナー3P',
                       6: '右ミドル', 7: '左ミドル', 8: 'ハイポスト', 9: 'ゴール下(右)', 10: 'ゴール下(左)' };

  // ------------------------------------------------------------------ 定数・既定の重み
  const FRAME_DT = 0.5;
  const MOVE_PX = 60;
  const STEP_MAX_PX = 110;
  // 既定 = これまでの実験で気に入った設定（v3 の動き + style=0.6）
  const DEFAULT_W = {
    time: 0.012, mid: 0.3, style: 0.6, follow: 0.03, trans: 0.05,
    dist: 0.04, dist_move: 0.04, path: 0.0, min_improve: -9.0, max_travel: 1e9,
    infeasible: 0.05, collide: 0.10, involve: 0.05, min_gain: -9.0,
  };
  const PRESET_V4 = { dist_move: 0.10, path: 0.03, max_travel: 500, involve: 0.03, min_improve: 0.05 };
  const DEFAULT_DEF = { gap: 70, gap_ball: 56, alpha: 0.7, step_max: 100, screen_r: 26, screen_speed: 18, screen_slow: 0.45 };
  const OPEN_FREE = { lo: 0.55, near: 15, far: 70 };
  const OPEN_GAME = { per_px: 0.004, lo: 0.7, hi: 1.2 };

  // 5! 通りの割当（辞書順。Python の itertools.permutations と同じ順序 → 同点のときの選択も一致）
  const PERMS = (function () {
    const out = [];
    (function rec(cur, rest) {
      if (!rest.length) { out.push(cur); return; }
      for (let i = 0; i < rest.length; i++) rec(cur.concat(rest[i]), rest.slice(0, i).concat(rest.slice(i + 1)));
    })([], [0, 1, 2, 3, 4]);
    return out;
  })();

  // ------------------------------------------------------------------ 小物
  const clamp01 = (x) => Math.min(1, Math.max(0, x));
  const smoothstep = (x) => { x = clamp01(x); return x * x * (3 - 2 * x); };
  const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
  const copy2 = (a) => [a[0], a[1]];
  const copyPts = (pts) => pts.map(copy2);
  function pointSegDist(p, a, b) {
    const abx = b[0] - a[0], aby = b[1] - a[1];
    const l2 = abx * abx + aby * aby;
    if (l2 < 1e-9) return Math.hypot(p[0] - a[0], p[1] - a[1]);
    const t = Math.min(1, Math.max(0, ((p[0] - a[0]) * abx + (p[1] - a[1]) * aby) / l2));
    return Math.hypot(p[0] - (a[0] + t * abx), p[1] - (a[1] + t * aby));
  }
  const pathLen = (frames, p) => { let s = 0; for (let k = 1; k < frames.length; k++) s += dist(frames[k][p], frames[k - 1][p]); return s; };

  // ------------------------------------------------------------------ プロフィール
  function normalizePlayers(players) {
    if (!Array.isArray(players) || players.length !== 5) throw new Error('選手は5人必要です');
    return players.map((p, i) => {
      const fg = Array.from(p.fg, Number);
      if (fg.length !== 10 || fg.some((v) => !isFinite(v))) throw new Error(`選手${i + 1}: 10エリア分のシュート率が必要です`);
      const mx = Math.max(...fg);
      return { id: p.id || `red${i + 1}`, height_cm: Number(p.height_cm), fg: mx > 1.5 ? fg.map((v) => v / 100) : fg };
    });
  }

  // ------------------------------------------------------------------ エンジン本体
  class Engine {
    /**
     * @param data  macros_data.js が定義する MACRO_DATA（{macros:{id:{...}}}）。座標は駒の中心座標[px]
     * @param opts  { geometry, W, DEF, fgBasis:'free'|'game', legacyValuation:boolean, margin:number }
     */
    constructor(data, opts) {
      opts = opts || {};
      this.G = opts.geometry || GEOM_APP;
      this.W = Object.assign({}, DEFAULT_W, opts.W || {});
      this.DEF = Object.assign({}, DEFAULT_DEF, opts.DEF || {});
      this.fgBasis = opts.fgBasis || 'free';
      this.legacy = opts.legacyValuation !== undefined ? opts.legacyValuation : true;   // true = v3 の挙動
      this.margin = opts.margin !== undefined ? opts.margin : 8;
      this.openFree = Object.assign({}, OPEN_FREE, opts.openFree || {});
      this.meta = {};
      this.ids = [];
      Object.keys(data.macros).forEach((id) => {
        const m = data.macros[id];
        this.meta[id] = m;
        this.ids.push(id);
      });
    }

    openMult(d) {
      if (this.fgBasis === 'free') {
        const f = clamp01((d - this.openFree.near) / (this.openFree.far - this.openFree.near));
        return this.openFree.lo + (1 - this.openFree.lo) * f;
      }
      return Math.min(OPEN_GAME.hi, Math.max(OPEN_GAME.lo, 1 + OPEN_GAME.per_px * (d - this.DEF.gap_ball)));
    }

    ptsOf(zone) { return zone <= 5 ? 3 : 2; }

    epAt(player, pos, dOpen) {
      const zone = this.G.areaOf(pos[0], pos[1]);
      const fg = player.fg[zone - 1];
      let ep = fg * this.ptsOf(zone);
      if (dOpen !== null && dOpen !== undefined) ep *= this.openMult(dOpen);
      if (pos[0] < this.G.ring[0] - 5) ep *= 0.6;           // リングより後ろ(ベースライン側)からは難しい
      return { ep, zone, fg };
    }

    // ---- 守備モデル
    newDefense(att0, holder, init) {
      const self = this;
      const sim = { D: null };
      const P = this.DEF, ring = this.G.ring, G = this.G;
      function target(a, hasBall) {
        const vx = ring[0] - a[0], vy = ring[1] - a[1];
        const n = Math.hypot(vx, vy);
        let gap = hasBall ? P.gap_ball : P.gap;
        if (n < 1e-6) return copy2(a);
        gap = Math.min(gap, 0.6 * n);
        return [a[0] + vx / n * gap, a[1] + vy / n * gap];
      }
      sim.D = init ? copyPts(init) : att0.map((a, i) => target(a, i === holder));
      sim.step = function (attPrev, attNow, hold) {
        const speed = attNow.map((a, j) => dist(a, attPrev[j]));
        const newD = [];
        for (let i = 0; i < 5; i++) {
          const tgt = target(attNow[i], i === hold);
          let mvx = P.alpha * (tgt[0] - sim.D[i][0]), mvy = P.alpha * (tgt[1] - sim.D[i][1]);
          const l = Math.hypot(mvx, mvy);
          if (l > P.step_max) { mvx *= P.step_max / l; mvy *= P.step_max / l; }
          let nd = [sim.D[i][0] + mvx, sim.D[i][1] + mvy];
          for (let j = 0; j < 5; j++) {                    // スクリーン効果: 静止中の他の攻撃選手が進路を塞ぐと減速
            if (j === i || speed[j] > P.screen_speed) continue;
            if (pointSegDist(attNow[j], sim.D[i], nd) < P.screen_r) {
              nd = [sim.D[i][0] + (nd[0] - sim.D[i][0]) * P.screen_slow, sim.D[i][1] + (nd[1] - sim.D[i][1]) * P.screen_slow];
              break;
            }
          }
          newD.push([Math.min(G.courtX, Math.max(0, nd[0])), Math.min(G.courtY, Math.max(0, nd[1]))]);
        }
        sim.D = newD;
      };
      return sim;
    }

    // ---- 役割割当
    roleValues(players, mm, att, cur) {
      const roles = mm.roles, n = att.length;
      const V = [];
      for (let p = 0; p < 5; p++) V.push([0, 0, 0, 0, 0]);
      for (let s = 0; s < 5; s++) {
        const moving = mm.path_px[s] >= MOVE_PX;
        for (let p = 0; p < 5; p++) {
          const pl = players[p];
          const end = (moving || this.legacy) ? att[n - 1][s]
            : [cur[p][0] + (att[n - 1][s][0] - att[0][s][0]), cur[p][1] + (att[n - 1][s][1] - att[0][s][1])];
          const zone = this.G.areaOf(end[0], end[1]);
          const ep = pl.fg[zone - 1] * this.ptsOf(zone);
          const h = pl.height_cm;
          let v;
          if (s === roles.finisher) v = ep + (zone >= 9 ? 0.08 * clamp01((h - 175) / 30) : 0);
          else if (s === roles.handler) v = 0.3 * ep;
          else if (roles.movers.indexOf(s) >= 0) v = 0.25 * ep;
          else v = 0.5 * ep;
          if (s === roles.handler) v += 0.08 * (1 - clamp01((h - 170) / 30));
          V[p][s] = v;
        }
      }
      return V;
    }

    bestAssignment(V, cur, starts, holder, handlerSlot, mm) {
      const W = this.W;
      const moving = [0, 1, 2, 3, 4].map((s) => mm.path_px[s] >= MOVE_PX);
      const cost = [], over = [];
      for (let p = 0; p < 5; p++) {
        cost.push([]); over.push([]);
        for (let s = 0; s < 5; s++) {
          const d = dist(cur[p], starts[s]);
          cost[p].push((moving[s] ? W.dist_move : W.dist) * d / 100);
          over[p].push(moving[s] && d + mm.path_px[s] > W.max_travel);
        }
      }
      let best = null, bestVal = -1e9;
      for (let i = 0; i < PERMS.length; i++) {
        const perm = PERMS[i];
        if (holder !== null && perm[holder] !== handlerSlot) continue;
        let bad = false;
        for (let p = 0; p < 5; p++) if (over[p][perm[p]]) { bad = true; break; }
        if (bad) continue;
        let val = 0;
        for (let p = 0; p < 5; p++) val += V[p][perm[p]] - cost[p][perm[p]];
        if (val > bestVal) { best = perm; bestVal = val; }
      }
      return best;
    }

    separate(pts, minDist, iters) {
      const m = this.margin, G = this.G;
      let out = copyPts(pts);
      for (let it = 0; it < iters; it++) {
        let any = false;
        const push = [[0, 0], [0, 0], [0, 0], [0, 0], [0, 0]];
        for (let i = 0; i < 5; i++) {
          for (let j = 0; j < 5; j++) {
            if (i === j) continue;
            const dx = out[i][0] - out[j][0], dy = out[i][1] - out[j][1];
            const d = Math.hypot(dx, dy);
            if (d < minDist) {
              any = true;
              const f = ((minDist - d) * 0.5) / Math.max(d, 1e-6);
              push[i][0] += dx * f; push[i][1] += dy * f;
            }
          }
        }
        if (!any) break;
        out = out.map((q, i) => [Math.min(G.courtX - m, Math.max(m, q[0] + push[i][0])),
                                  Math.min(G.courtY - m, Math.max(m, q[1] + push[i][1]))]);
      }
      return out;
    }

    // テンプレを現在位置 cur から始まる軌跡へ再配置（動くスロット: ずれを smoothstep で消しつつ終点へ / 静止スロット: ずれを保って待機）
    realize(att, mm, perm, cur) {
      const n = att.length, m = this.margin, G = this.G, stepMax = STEP_MAX_PX;
      const out = Array.from({ length: n }, () => [[0, 0], [0, 0], [0, 0], [0, 0], [0, 0]]);
      const w = Array.from({ length: n }, (_, k) => smoothstep(n > 1 ? k / (n - 1) : 1));
      let infeasible = 0;
      for (let p = 0; p < 5; p++) {
        const s = perm[p];
        const P = att.map((f) => f[s]);
        const off = [cur[p][0] - P[0][0], cur[p][1] - P[0][1]];
        const moving = mm.path_px[s] >= MOVE_PX;
        const raw = P.map((q, k) => moving ? [q[0] + (1 - w[k]) * off[0], q[1] + (1 - w[k]) * off[1]] : [q[0] + off[0], q[1] + off[1]]);
        const nw = [copy2(cur[p])];
        for (let k = 1; k < n; k++) {
          let sx = raw[k][0] - nw[k - 1][0], sy = raw[k][1] - nw[k - 1][1];
          const l = Math.hypot(sx, sy);
          if (l > stepMax) { sx *= stepMax / l; sy *= stepMax / l; }
          nw.push([nw[k - 1][0] + sx, nw[k - 1][1] + sy]);
        }
        for (let k = 0; k < n; k++) {
          nw[k][0] = Math.min(G.courtX - m, Math.max(m, nw[k][0]));
          nw[k][1] = Math.min(G.courtY - m, Math.max(m, nw[k][1]));
        }
        if (moving) infeasible += dist(nw[n - 1], raw[n - 1]);
        for (let k = 0; k < n; k++) out[k][p] = nw[k];
      }
      for (let k = 1; k < n; k++) out[k] = this.separate(out[k], 22, 3);
      return { seg: out, infeasible };
    }

    countCollisions(att, thr) {
      let c = 0;
      for (let k = 1; k < att.length; k++) {
        let hit = false;
        for (let i = 0; i < 5 && !hit; i++) for (let j = 0; j < 5; j++) { if (i !== j && dist(att[k][i], att[k][j]) < thr - 1e-6) { hit = true; break; } }
        if (hit) c++;
      }
      return c;
    }

    // ---- 1マクロ分を展開した子状態
    expand(st, mid, players, dw, first) {
      const W = this.W, mm = this.meta[mid], attT = mm.att, starts = attT[0];
      const V = this.roleValues(players, mm, attT, st.cur);
      const perm = this.bestAssignment(V, st.cur, starts, st.holder, mm.roles.handler, mm);
      if (!perm) return null;
      const r = this.realize(attT, mm, perm, st.cur);
      const seg = r.seg, n = seg.length;
      const inv = {}; for (let p = 0; p < 5; p++) inv[perm[p]] = p;
      const holdP = mm.hold.map((s) => (s >= 0 ? inv[s] : -1));
      const finP = inv[mm.roles.finisher];
      const sim = this.newDefense(seg[0], st.holder, st.simD);
      const D = [copyPts(sim.D)];
      for (let k = 1; k < n; k++) { sim.step(seg[k - 1], seg[k], holdP[k]); D.push(copyPts(sim.D)); }
      const base = first ? 0 : st.att.length - 1;
      let best = st.best, end = null;
      for (let k = first ? 0 : 1; k < n; k++) {
        let hp = holdP[k];
        if (hp < 0 && k === n - 1) hp = finP;
        if (hp < 0) continue;
        let d = 1e18; for (let j = 0; j < 5; j++) d = Math.min(d, dist(D[k][j], seg[k][hp]));
        const e = this.epAt(players[hp], seg[k][hp], d);
        const tSec = (base + k) * FRAME_DT;
        const val = e.ep - W.time * tSec;
        if (k === n - 1) end = { ep: e.ep, t_sec: tSec, player: hp, zone: e.zone, fg: e.fg, open_px: d, macro: mid, pos: copy2(seg[k][hp]) };
        if (best === null || val > best.value) best = { value: val, ep: e.ep, t_sec: tSec, player: hp, zone: e.zone, fg: e.fg, open_px: d, macro: mid, pos: copy2(seg[k][hp]) };
      }
      let trans = 0; for (let p = 0; p < 5; p++) trans += dist(st.cur[p], starts[perm[p]]); trans = trans / 5 / 100;
      let totalPath = 0; for (let p = 0; p < 5; p++) totalPath += pathLen(seg, p);
      const pen = W.infeasible * r.infeasible / 100 + W.collide * this.countCollisions(seg, 22) + W.path * totalPath / 100;
      const involved = new Set(st.inv);
      for (let p = 0; p < 5; p++) if (pathLen(seg, p) >= MOVE_PX) involved.add(p);
      holdP.forEach((h) => { if (h >= 0) involved.add(h); });
      return {
        chain: st.chain.concat(mid), cur: copyPts(seg[n - 1]), holder: finP,
        att: first ? seg : st.att.concat(seg.slice(1)),
        dfn: first ? D : st.dfn.concat(D.slice(1)),
        // 連結: 前のマクロの最終フレーム(シュート時点 = -1)と次のマクロの先頭フレームは同じ時刻に重なる。
        // 途中のつなぎ目でボールが空中に消えないよう、-1 を「次のマクロの先頭の保持者 = 前のマクロの最終保持者」に置き換える。
        // （全体の最後のシュート時点の -1 は、そのまま残す）
        hold: first ? holdP : st.hold.slice(0, -1).concat(st.hold[st.hold.length - 1] < 0 ? st.holder : st.hold[st.hold.length - 1], holdP.slice(1)),
        simD: copyPts(sim.D), best, n_good: st.n_good,
        trans: st.trans + (first ? 0 : trans), pen: st.pen + pen,
        style: st.style + (dw !== null ? 1 - Math.abs(dw - mm.drive_score) : 0),
        assign: st.assign.concat({ macro: mid, perm, end, gain: (best ? best.value : 0) - (st.best ? st.best.value : 0) }),
        inv: involved, score: 0,
      };
    }

    score(st, dw) {
      const W = this.W;
      const ends = st.assign.filter((a) => a.end).map((a) => a.end);
      if (!ends.length) return 0;
      const last = ends[ends.length - 1];
      let s = last.ep - W.time * last.t_sec;
      if (ends.length > 1) { let sum = 0; for (let i = 0; i < ends.length - 1; i++) sum += ends[i].ep; s += W.mid * sum / (ends.length - 1); }
      if (dw !== null) s += W.style * st.style / st.chain.length;
      s += W.follow * st.n_good - W.trans * st.trans - st.pen + W.involve * st.inv.size;
      return s;
    }

    selectDiverse(children, k, perKey) {
      const cnt = {}, out = [], rest = [];
      for (const c of children) {
        const e = c.assign.length ? c.assign[c.assign.length - 1].end : null;
        const key = e ? `${e.player}-${e.zone}` : 'none';
        if ((cnt[key] || 0) < perKey) { cnt[key] = (cnt[key] || 0) + 1; out.push(c); } else rest.push(c);
        if (out.length >= k) break;
      }
      for (const c of rest) { if (out.length >= k) break; out.push(c); }
      return out;
    }

    /**
     * @param init   5x2 の駒の中心座標[px]
     * @param players [{id, height_cm, fg:[10]}]（成功率は % でも 0-1 でも可）
     * @param o      { ballHolder=0, driveWeight=null, topK=3, maxDepth=4, beam=12, maxSeconds=24, minMacros=2, diverse=true, defInit=null }
     */
    suggest(init, players, o) {
      o = Object.assign({ ballHolder: 0, driveWeight: null, topK: 3, maxDepth: 4, beam: 12, maxSeconds: 24, minMacros: 2, diverse: true, defInit: null }, o || {});
      const G = this.G, W = this.W, m = this.margin;
      if (!Array.isArray(init) || init.length !== 5) throw new Error('init は 5 人分の座標が必要です');
      players = normalizePlayers(players);
      const dw = (o.driveWeight === null || o.driveWeight === undefined) ? null : Number(o.driveWeight);
      const start = init.map((q) => [Math.min(G.courtX - m, Math.max(m, q[0])), Math.min(G.courtY - m, Math.max(m, q[1]))]);
      const sim0 = this.newDefense(start, o.ballHolder, o.defInit);
      let d0 = 1e18; for (let j = 0; j < 5; j++) d0 = Math.min(d0, dist(sim0.D[j], start[o.ballHolder]));
      const base = this.epAt(players[o.ballHolder], start[o.ballHolder], d0);

      const root = { chain: [], cur: copyPts(start), holder: o.ballHolder, att: [copyPts(start)], dfn: [copyPts(sim0.D)],
                     hold: [o.ballHolder], simD: copyPts(sim0.D), best: null, n_good: 0, trans: 0, pen: 0, style: 0, assign: [], inv: new Set(), score: 0 };
      let frontier = [root];
      const allc = [];
      for (let depth = 0; depth < o.maxDepth; depth++) {
        const children = [];
        for (const st of frontier) {
          const prev = st.chain.length ? st.chain[st.chain.length - 1] : null;
          for (const mid of this.ids) {
            if (st.chain.indexOf(mid) >= 0) continue;
            if (prev && (this.meta[prev].bad_followups || []).indexOf(mid) >= 0) continue;
            const ch = this.expand(st, mid, players, dw, depth === 0);
            if (!ch) continue;
            if (prev && (this.meta[prev].good_followups || []).indexOf(mid) >= 0) ch.n_good += 1;
            if (depth > 0 && ch.assign[ch.assign.length - 1].gain < W.min_gain) continue;
            if ((ch.att.length - 1) * FRAME_DT > o.maxSeconds) continue;
            ch.score = this.score(ch, dw);
            children.push(ch);
          }
        }
        children.sort((a, b) => b.score - a.score);
        frontier = this.selectDiverse(children, o.beam, o.diverse ? 3 : o.beam);
        for (const c of frontier) allc.push(c);
      }
      allc.sort((a, b) => b.score - a.score);
      const seen = new Set(), picked = [], used = new Set();
      for (const st of allc) {
        const key0 = st.chain.join('>');
        if (seen.has(key0) || st.chain.length < o.minMacros) continue;
        seen.add(key0);
        const e = st.assign[st.assign.length - 1].end;
        if (e.ep - base.ep < W.min_improve) continue;
        const key = `${e.player}-${e.zone}`;
        if (o.diverse && used.has(key)) continue;
        used.add(key); picked.push(st);
        if (picked.length >= o.topK) break;
      }
      if (picked.length < o.topK) {
        const have = new Set(picked.map((p) => p.chain.join('>')));
        for (const st of allc) {
          const k0 = st.chain.join('>');
          if (!have.has(k0)) { picked.push(st); have.add(k0); }
          if (picked.length >= o.topK) break;
        }
      }
      return picked.map((st, i) => this.pack(i + 1, st, players, dw, base));
    }

    pack(rank, st, players, dw, base) {
      const G = this.G, b = st.assign[st.assign.length - 1].end, shooter = players[b.player];
      const assigns = st.assign.map((a) => {
        const roles = this.meta[a.macro].roles, inv = {};
        for (let p = 0; p < 5; p++) inv[a.perm[p]] = p;
        const pid = (s) => players[inv[s]].id;
        return { macro: a.macro, name_jp: this.meta[a.macro].name_jp, handler: pid(roles.handler), finisher: pid(roles.finisher),
                 movers: roles.movers.map(pid), spacers: roles.spacers.map(pid), end_ep: Math.round(a.end.ep * 1000) / 1000 };
      });
      const lines = assigns.map((a, i) => {
        const mm = this.meta[a.macro];
        return `${i + 1}. ${mm.name_jp}（${mm.duration_seconds}秒）: ハンドラー=${a.handler} / フィニッシャー=${a.finisher}（このマクロ終了時の得点機会 ${a.end_ep.toFixed(2)}）… ${mm.coach_note || ''}`;
      });
      lines.push(`最大の得点機会: ${b.t_sec.toFixed(1)}秒時点、${shooter.id}（${shooter.height_cm.toFixed(0)}cm）が${AREA_NAMES[b.zone]}から。` +
        `FG%=${(b.fg * 100).toFixed(0)}% / 最寄りの守備者まで${(b.open_px / G.pxPerFt).toFixed(1)}ft（補正 ×${this.openMult(b.open_px).toFixed(2)}）` +
        ` → 期待得点 ${b.ep.toFixed(2)}点/本（開始直後にそのまま打つ場合: ${base.ep.toFixed(2)} → ${(b.ep - base.ep >= 0 ? '+' : '')}${(b.ep - base.ep).toFixed(2)}）`);
      const invIds = Array.from(st.inv).sort().map((p) => players[p].id);
      lines.push(`関与した選手: ${invIds.join(', ')}（${st.inv.size}/5人）`);
      const frames = st.att.map((a, k) => ({ t: Math.round(k * FRAME_DT * 10) / 10, att: a, dfn: st.dfn[k], hold: st.hold[k] }));
      return {
        rank, chain: st.chain.slice(), chain_jp: st.chain.map((c) => this.meta[c].name_jp),
        score: Math.round(this.score(st, dw) * 10000) / 10000,
        duration_seconds: (st.att.length - 1) * FRAME_DT,
        best_shot: { shooter_id: shooter.id, player: b.player, area: b.zone, area_name: AREA_NAMES[b.zone], fg: b.fg, ep: b.ep, open_px: b.open_px, t_sec: b.t_sec, pos: b.pos },
        baseline_ep: base.ep, improvement: b.ep - base.ep, involved: invIds, assignments: assigns,
        explanation: lines.join('\n'), frames,
      };
    }

    // 10エリアの境界を確認するための画像用データ: 格子点ごとのエリア番号
    zoneGrid(step) {
      step = step || 8;
      const G = this.G, rows = [];
      for (let y = step / 2; y < G.courtY; y += step) {
        const row = [];
        for (let x = step / 2; x < G.courtX; x += step) row.push(G.areaOf(x, y));
        rows.push(row);
      }
      return { step, rows };
    }
  }

  const api = { Engine, GEOM_APP, makeAppAreaOf, AREA_NAMES, DEFAULT_W, DEFAULT_DEF, PRESET_V4, FRAME_DT, MOVE_PX, normalizePlayers, PERMS };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.BBEngine = api;
})(typeof globalThis !== 'undefined' ? globalThis : (typeof window !== 'undefined' ? window : this));

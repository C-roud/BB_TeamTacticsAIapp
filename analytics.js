/* =====================================================================
 * analytics.js — 試合モード用のバスケットボール・アナリティクス計算（画面に依存しない）
 *
 * 入力は「ボックススコアのカウントだけ」。1人（または相手チーム全体）の記録は次の形：
 *   { p3m, p3a, p2m, p2a, ftm, fta, orb, drb, tov }
 *   p3m/p3a = 3P成功/試投, p2m/p2a = 2P成功/試投, ftm/fta = FT成功/試投,
 *   orb/drb = オフェンス/ディフェンスリバウンド, tov = ターンオーバー
 *
 * 式（Dean Oliver の Four Factors / Basketball-Reference と同じ定義）:
 *   FGM = 3PM + 2PM            FGA = 3PA + 2PA            PTS = 3*3PM + 2*2PM + FTM
 *   eFG%    = (FGM + 0.5*3PM) / FGA
 *   TS%     = PTS / (2*(FGA + 0.44*FTA))
 *   使用ポゼッション(used) = FGA + 0.44*FTA + TOV
 *   TOV%    = TOV / used
 *   ORB%    = ORB / (ORB + 相手DRB)           DRB% = DRB / (DRB + 相手ORB)
 *   FT Rate = FTA / FGA
 *   Poss(推計) = FGA - ORB + TOV + 0.44*FTA   （相手の記録があれば 自/相手 の平均）
 *   ORtg    = 100 * PTS / Poss                DRtg = 100 * 相手PTS / Poss
 *   USG%(簡易) = 選手のused / チームのused * 100      ← 出場時間を使わない簡易版
 *   個人効率   = 100 * PTS / 選手のused               ← 「使った1回あたり何点取ったか」
 * 分母が 0 のとき、値は null（画面では「—」）。
 * ===================================================================== */
(function (root) {
  'use strict';

  const FIELDS = ['p3m', 'p3a', 'p2m', 'p2a', 'ftm', 'fta', 'orb', 'drb', 'tov'];
  const MAX_COUNT = 999;
  const FT_COEF = 0.44;

  function emptyRecord() {
    const r = {};
    FIELDS.forEach((f) => { r[f] = 0; });
    return r;
  }

  const num = (v) => (Number.isFinite(+v) && +v > 0 ? Math.floor(+v) : 0);
  const div = (a, b) => (b > 0 ? a / b : null);

  /** 数値カウンタを ±1 する。成功数 ≦ 試投数 が常に保たれるようにする。
   *  成功＋ → 試投も＋1（成功は必ず試投に含まれる） / 成功－ → 試投も－1（入力ミスの取り消し）
   *  試投＋ → 試投だけ＋1（= 失敗の記録）          / 試投－ → 失敗分（試投 > 成功）があるときだけ－1 */
  function applyDelta(rec, field, d) {
    if (!FIELDS.includes(field)) return rec;
    const step = d > 0 ? 1 : -1;
    const madeOf = { p3a: 'p3m', p2a: 'p2m', fta: 'ftm' };
    const attOf = { p3m: 'p3a', p2m: 'p2a', ftm: 'fta' };
    if (attOf[field]) {                                   // 成功数
      const att = attOf[field];
      if (step > 0) {
        if (rec[field] >= MAX_COUNT || rec[att] >= MAX_COUNT) return rec;
        rec[field] += 1; rec[att] += 1;
      } else if (rec[field] > 0) {
        rec[field] -= 1; rec[att] = Math.max(rec[field], rec[att] - 1);
      }
    } else if (madeOf[field]) {                           // 試投数
      const made = madeOf[field];
      if (step > 0) { if (rec[field] < MAX_COUNT) rec[field] += 1; }
      else if (rec[field] > rec[made]) rec[field] -= 1;
    } else {                                              // ORB / DRB / TOV
      rec[field] = Math.max(0, Math.min(MAX_COUNT, rec[field] + step));
    }
    return rec;
  }

  /** 複数の記録を合計する */
  function sum(list) {
    const t = emptyRecord();
    list.forEach((r) => FIELDS.forEach((f) => { t[f] += num(r[f]); }));
    return t;
  }

  /** 1つの記録から、基本の派生値（FGM, FGA, PTS, used など）を作る */
  function basics(r) {
    const fgm = num(r.p3m) + num(r.p2m);
    const fga = num(r.p3a) + num(r.p2a);
    const pts = 3 * num(r.p3m) + 2 * num(r.p2m) + num(r.ftm);
    const fta = num(r.fta);
    const tov = num(r.tov);
    const used = fga + FT_COEF * fta + tov;
    return {
      fgm, fga, fta, ftm: num(r.ftm), p3m: num(r.p3m), p3a: num(r.p3a), p2m: num(r.p2m), p2a: num(r.p2a),
      orb: num(r.orb), drb: num(r.drb), tov, pts, used,
      poss: fga - num(r.orb) + tov + FT_COEF * fta,
      isEmpty: FIELDS.every((f) => num(r[f]) === 0),
    };
  }

  function efg(b) { return div(b.fgm + 0.5 * b.p3m, b.fga); }
  function ts(b) { return div(b.pts, 2 * (b.fga + FT_COEF * b.fta)); }

  /** 選手1人のスタッツ。team = チーム合計の記録（USG%の分母） */
  function playerStats(rec, teamRec) {
    const b = basics(rec);
    const t = basics(teamRec);
    return {
      pts: b.pts, fgm: b.fgm, fga: b.fga,
      fgPct: div(b.fgm, b.fga),
      efg: efg(b),
      ts: ts(b),
      reb: b.orb + b.drb,
      used: b.used,
      usg: div(b.used, t.used),                    // 0〜1（簡易USG%）
      eff: b.used > 0 ? 100 * b.pts / b.used : null, // 個人効率（100回あたり得点）
      empty: b.isEmpty,
    };
  }

  /** チーム全体の分析。team / opp はそれぞれ合計記録。opp が未入力なら、相手が必要な指標は null */
  function teamStats(teamRec, oppRec) {
    const a = basics(teamRec);
    const o = basics(oppRec);
    const oppEntered = !o.isEmpty;
    // 自チームのポゼッションと相手のポゼッションは理論上ほぼ等しいので、両方あれば平均する
    const poss = oppEntered ? (a.poss + o.poss) / 2 : a.poss;
    const possPos = poss > 0 ? poss : null;
    const mk = (me, other, otherEntered, possUse) => ({
      pts: me.pts,
      fgm: me.fgm, fga: me.fga,
      fgPct: div(me.fgm, me.fga),
      p3Pct: div(me.p3m, me.p3a),
      p2Pct: div(me.p2m, me.p2a),
      ftPct: div(me.ftm, me.fta),
      efg: efg(me),
      ts: ts(me),
      tovPct: div(me.tov, me.used),
      orbPct: otherEntered ? div(me.orb, me.orb + other.drb) : null,
      drbPct: otherEntered ? div(me.drb, me.drb + other.orb) : null,
      rebPct: otherEntered ? div(me.orb + me.drb, me.orb + me.drb + other.orb + other.drb) : null,
      ftRate: div(me.fta, me.fga),
      p3Rate: div(me.p3a, me.fga),
      poss: possUse,
      ppp: possUse ? me.pts / possUse : null,
      ortg: possUse ? 100 * me.pts / possUse : null,
      tov: me.tov, orb: me.orb, drb: me.drb,
    });
    const us = mk(a, o, oppEntered, possPos);
    const them = mk(o, a, oppEntered, oppEntered ? possPos : null);
    us.drtg = oppEntered && possPos ? 100 * o.pts / possPos : null;
    them.drtg = oppEntered && possPos ? 100 * a.pts / possPos : null;
    us.net = us.ortg !== null && us.drtg !== null ? us.ortg - us.drtg : null;
    them.net = us.net !== null ? -us.net : null;
    return { us, opp: them, oppEntered };
  }

  /** Four Factors の定義（weight は Dean Oliver による重み。higherBetter=false は「低いほど良い」） */
  const FOUR_FACTORS = [
    { key: 'efg', label: 'eFG%', name: '有効シュート効率', weight: 40, higherBetter: true, kind: 'pct' },
    { key: 'tovPct', label: 'TOV%', name: 'ターンオーバー率', weight: 25, higherBetter: false, kind: 'pct' },
    { key: 'orbPct', label: 'ORB%', name: 'オフェンスリバウンド率', weight: 20, higherBetter: true, kind: 'pct' },
    { key: 'ftRate', label: 'FT Rate', name: 'フリースロー試投率(FTA/FGA)', weight: 15, higherBetter: true, kind: 'ratio' },
  ];

  /** Four Factors を 自チーム vs 相手 で比べる。lead: 1=自チーム優勢, -1=劣勢, 0=同等/比較不能 */
  function compareFourFactors(ts_) {
    return FOUR_FACTORS.map((f) => {
      const u = ts_.us[f.key];
      const o = ts_.opp[f.key];
      let lead = 0;
      let diff = null;
      if (u !== null && o !== null) {
        diff = u - o;
        if (Math.abs(diff) > 1e-9) lead = (diff > 0) === f.higherBetter ? 1 : -1;
      }
      return Object.assign({}, f, { us: u, opp: o, diff, lead });
    });
  }

  // ------------------------------------------------------------ 表示用フォーマット
  const fmtPct = (x, d) => (x === null || x === undefined ? '—' : (100 * x).toFixed(d === undefined ? 1 : d) + '%');
  const fmtNum = (x, d) => (x === null || x === undefined ? '—' : x.toFixed(d === undefined ? 1 : d));
  const fmtSigned = (x, d) => (x === null || x === undefined ? '—' : (x > 0 ? '+' : '') + x.toFixed(d === undefined ? 1 : d));

  const api = {
    FIELDS, MAX_COUNT, FOUR_FACTORS,
    emptyRecord, applyDelta, sum, basics, playerStats, teamStats, compareFourFactors,
    fmtPct, fmtNum, fmtSigned,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.BBAnalytics = api;
})(typeof window !== 'undefined' ? window : globalThis);

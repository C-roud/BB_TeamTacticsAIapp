#!/usr/bin/env python
# ===== export_web_data.py : マクロCSV と macro_meta.json → Webアプリ用の macros_data.js =====
# 使い方（setplay_ai ディレクトリで。先に python build_meta.py を実行して macro_meta.json を最新にしておく）:
#   python export_web_data.py --out macros_data.js
#   → 出力された macros_data.js を、Webアプリ(index.html と同じ場所)に置いて GitHub に push する
# 座標は「駒の中心」に直す（CSVの x,y は駒の左上 = left/top なので +15）。--piece-offset 0 で補正なし。
import argparse, glob, json, os, sys, datetime
import numpy as np
import macro_io as mio


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--macro-dir", default="data/macros")
    ap.add_argument("--meta", default="macro_meta.json")
    ap.add_argument("--out", default="macros_data.js")
    ap.add_argument("--piece-offset", type=float, default=15.0, help="CSVの左上座標 → 駒の中心への補正[px]")
    args = ap.parse_args()

    meta = json.load(open(args.meta, encoding="utf-8"))
    out = {}
    for mid, mm in meta.items():
        path = os.path.join(args.macro_dir, mid + ".csv")
        if not os.path.exists(path):
            print(f"[warn] {path} がありません。{mid} をスキップ"); continue
        m = mio.load_macro(path)
        att = (m["att"].astype(float) + args.piece_offset).round(2)          # (n,5,2)
        hold = mio.holder_seq(m["ball"]).tolist()
        roles = mm["roles"]
        out[mid] = {
            "name_jp": mm.get("name_jp", mid),
            "coach_note": mm.get("coach_note", ""),
            "good_followups": mm.get("good_followups", []),
            "bad_followups": mm.get("bad_followups", []),
            "drive_score": mm["drive_score"],
            "duration_seconds": mm["duration_frames"] * 0.5,
            "n_frames": int(att.shape[0]),
            "path_px": [float(v) for v in mio.path_len(m["att"])],
            "roles": {"handler": int(roles["handler"]), "finisher": int(roles["finisher"]),
                      "movers": [int(v) for v in roles["movers"]], "spacers": [int(v) for v in roles["spacers"]]},
            "att": att.tolist(),
            "hold": [int(v) for v in hold],
        }
    data = {"version": 1, "generated": datetime.datetime.now().strftime("%Y-%m-%d %H:%M"), "pieceOffset": args.piece_offset,
            "count": len(out), "macros": out}
    with open(args.out, "w", encoding="utf-8") as fh:
        fh.write("// 自動生成: export_web_data.py（手で編集しないでください）\n")
        fh.write("window.MACRO_DATA = " + json.dumps(data, ensure_ascii=False, separators=(",", ":")) + ";\n")
    size = os.path.getsize(args.out)
    print(f"saved {args.out}: {len(out)} macros, {size / 1024:.1f} KB (piece_offset={args.piece_offset})")


if __name__ == "__main__":
    main()

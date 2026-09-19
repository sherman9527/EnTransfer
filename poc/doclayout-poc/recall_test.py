# poc/doclayout-poc/recall_test.py — C1 measurement: does PP-DocLayout-S find
# the figure regions our pdfjs pipeline misses? Runs headless on the Manning
# book: for every page carrying a "Figure N." caption, count detections in
# figure-ish classes {image(1), chart(18), table(8)} and report recall +
# per-class census. Verdict gates production integration (docs/PDFZH-COMPARE.md C1).
import json
import re
import sys
import time
from pathlib import Path

import numpy as np
import onnxruntime as ort
import pypdfium2 as pdfium
from PIL import Image

ROOT = Path(__file__).resolve().parents[2]
PDF = ROOT / "Manning.Think.Like.a.Software.Engineering.Manager.2024.6.pdf"
MODEL = Path(__file__).resolve().parent / "pp_doclayout_s.onnx"
OUT = Path(__file__).resolve().parent / "recall-report.json"

MEAN = np.array([0.485, 0.456, 0.406], dtype=np.float32)
STD = np.array([0.229, 0.224, 0.225], dtype=np.float32)
CLASSES = ["paragraph_title", "image", "text", "number", "abstract", "content", "figure_title",
           "formula", "table", "table_title", "reference", "doc_title", "footnote", "header",
           "algorithm", "footer", "seal", "chart_title", "chart", "formula_number",
           "header_image", "footer_image", "aside_text"]
FIGURE_LIKE = {1, 18}  # image, chart
# A real caption is line-initial and capitalized ("Figure 2.1: ..."); lowercase
# mid-sentence "figure 2.3" is an in-text cross-reference, NOT a figure on this
# page. Case-sensitive + line-anchored so the recall denominator is honest.
CAPTION_RE = re.compile(r"(?m)^[ \t]*Figure[ \t]+\d+[.\d]*[ \t.:]")


def page_has_caption(page) -> bool:
    tp = page.get_textpage()
    try:
        n = tp.count_chars()
    except AttributeError:
        n = 0
    text = tp.get_text_range(0, n) if n else (tp.get_text_range() or "")
    return bool(CAPTION_RE.search(text))


def detect(session, img_np):
    h, w = img_np.shape[:2]
    im = Image.fromarray(img_np).resize((480, 480), Image.BILINEAR)
    arr = (np.asarray(im, dtype=np.float32) / 255.0 - MEAN) / STD
    chw = np.transpose(arr, (2, 0, 1))[None].astype(np.float32)
    sf = np.array([[480.0 / h, 480.0 / w]], dtype=np.float32)
    ins = {"image": chw, "scale_factor": sf}
    dets, num = session.run(None, ins)
    n = int(np.asarray(num).reshape(-1)[0])
    return dets[:n]


def main():
    in_names = None  # bound by zip above via positional order (image, scale_factor)
    session = ort.InferenceSession(str(MODEL), providers=["CPUExecutionProvider"])
    in_names = [i.name for i in session.get_inputs()]
    assert in_names[0] == "image", f"unexpected input names {in_names}"

    doc = pdfium.PdfDocument(str(PDF))
    t0 = time.time()
    caption_pages, figure_hits, box_dump = [], 0, []
    class_census = {}
    per_page = []
    for pno in range(len(doc)):
        page = doc[pno]
        has_cap = page_has_caption(page)
        if not has_cap:
            continue
        bitmap = page.render(scale=2.0)
        arr = bitmap.to_numpy()[:, :, :3]
        dets = detect(session, arr)
        boxes = []
        fig_like = 0
        for row in dets:
            cid, score, x1, y1, x2, y2 = row
            cid = int(cid)
            if score < 0.3:
                continue
            class_census[CLASSES[cid]] = class_census.get(CLASSES[cid], 0) + 1
            if cid in FIGURE_LIKE or cid == 8:
                fig_like += 1
                boxes.append([CLASSES[cid], round(float(score), 3),
                              [round(float(v) / 2, 1) for v in (x1, y1, x2, y2)]])
        caption_pages.append(pno + 1)
        if fig_like > 0:
            figure_hits += 1
        if len(box_dump) < 10 and boxes:
            box_dump.append({"page": pno + 1, "boxes": boxes[:6]})
        per_page.append({"page": pno + 1, "figure_like_boxes": fig_like})
    report = {
        "captioned_pages": len(caption_pages),
        "pages_with_figure_or_table_box": figure_hits,
        "recall_pct": round(100.0 * figure_hits / max(1, len(caption_pages)), 1),
        "baseline_recall_pct": round(100.0 * 6 / max(1, len(caption_pages)), 1),
        "class_census_top": dict(sorted(class_census.items(), key=lambda kv: -kv[1])[:12]),
        "sample_boxes": box_dump,
        "elapsed_s": round(time.time() - t0, 1),
        "pages": caption_pages,
        "per_page": per_page,
    }
    OUT.write_text(json.dumps(report, ensure_ascii=False, indent=1), encoding="utf8")
    print(f"recall {report['recall_pct']}% vs baseline {report['baseline_recall_pct']}% "
          f"on {report['captioned_pages']} captioned pages in {report['elapsed_s']}s")
    return 0


if __name__ == "__main__":
    sys.exit(main())

---
license: apache-2.0
tags:
  - layout-detection
  - document-layout
  - picodet
  - onnx
  - paddlepaddle
library_name: onnx
base_model: PaddlePaddle/PP-DocLayout-S
---

# PP-DocLayout-S — ONNX export

ONNX export of [PaddlePaddle/PP-DocLayout-S](https://huggingface.co/PaddlePaddle/PP-DocLayout-S),
a lightweight (~4.7 MB) document-layout detector based on PicoDet/GFL,
trained on a mixed Chinese/English corpus of papers, magazines, contracts,
books, exams and research reports. 23 layout classes.

Hosted here for the [RailReaderCore](https://github.com/sjvrensburg/RailReaderCore) project — the
detector intended for future web (WASM/ORT-Web) and mobile RailReader builds
where the ~50 MB PP-DocLayoutV3 is too heavy.

## Files

| File | Size | Notes |
|---|---|---|
| `pp_doclayout_s.onnx` | 4.7 MB | Exported via `paddle2onnx` from the upstream Paddle checkpoint. |

## Inference contract

The export keeps PaddleDetection's GFL-head two-input convention, **not** the
three-input convention used by the PP-DocLayoutV3 RT-DETR export — so this is
*not* a drop-in replacement at the I/O level.

### Inputs

| Name | dtype | Shape | Notes |
|---|---|---|---|
| `image` | `float32` | `[1, 3, 480, 480]` | Bilinear-resize the source image to exactly 480×480 **without** keep-ratio, scale to `[0, 1]`, then ImageNet-normalise: `mean=[0.485, 0.456, 0.406]`, `std=[0.229, 0.224, 0.225]`. |
| `scale_factor` | `float32` | `[1, 2]` | `[480 / orig_h, 480 / orig_w]` — the detection head divides predicted boxes by this, so the output boxes come back in the **original image's** pixel space. |

### Outputs

| Name | dtype | Shape | Notes |
|---|---|---|---|
| Detections | `float32` | `[M, 6]` | Padded out to a fixed M. Each row is `[class_id, score, x1, y1, x2, y2]`. Coordinates are in the original image (un-resized) frame. |
| `num_dets` | `int32`/`int64` | scalar | Number of valid rows in the detection tensor. Trust this — the rest of the rows are padding. |

NMS is baked into the graph at `score_threshold=0.3`.

### Class table (23)

Ordered to match the upstream `inference.yml`:

```
 0  paragraph_title
 1  image
 2  text
 3  number
 4  abstract
 5  content
 6  figure_title
 7  formula
 8  table
 9  table_title
10  reference
11  doc_title
12  footnote
13  header
14  algorithm
15  footer
16  seal
17  chart_title
18  chart
19  formula_number
20  header_image
21  footer_image
22  aside_text
```

## Minimal usage (ONNX Runtime, Python)

```python
import numpy as np
import onnxruntime as ort
from PIL import Image

MEAN = np.array([0.485, 0.456, 0.406], dtype=np.float32)
STD  = np.array([0.229, 0.224, 0.225], dtype=np.float32)

sess = ort.InferenceSession("pp_doclayout_s.onnx", providers=["CPUExecutionProvider"])

img = Image.open("page.png").convert("RGB")
orig_w, orig_h = img.size
resized = img.resize((480, 480), Image.BILINEAR)
arr = (np.asarray(resized, dtype=np.float32) / 255.0 - MEAN) / STD
chw = np.transpose(arr, (2, 0, 1))[None]                         # [1, 3, 480, 480]
sf  = np.array([[480 / orig_h, 480 / orig_w]], dtype=np.float32) # [1, 2]

dets, num_dets = sess.run(None, {"image": chw, "scale_factor": sf})
for row in dets[: int(num_dets[0])]:
    cls_id, score, x1, y1, x2, y2 = row
    if score < 0.3:
        continue
    print(int(cls_id), float(score), float(x1), float(y1), float(x2), float(y2))
```

## License

Apache-2.0, inherited from the upstream
[PaddlePaddle/PP-DocLayout-S](https://huggingface.co/PaddlePaddle/PP-DocLayout-S).

## Source verification

```
sha256:  33688dbee1c23e34b81777e97cb428eb40f24b242c02b5f623484959e830aec8
size:    4917852 bytes
```

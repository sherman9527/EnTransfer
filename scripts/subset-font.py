"""
Subset Noto Sans SC to cover GBK Chinese (21,886 chars) + ASCII + punctuation
+ math/symbol ranges. This eliminates the "□□□" tofu glyphs that appeared when
the model emitted rare / traditional / variant characters outside GB2312.

Runs: C:\\Python310\\python.exe scripts/subset-font.py
"""
import os
from fontTools import subset

chars = set()

# ---- ASCII printable -------------------------------------------------------
for i in range(0x20, 0x7F):
    chars.add(chr(i))

# ---- GBK full character set (GB2312 + extensions, ~21,886 hanzi) ----------
# GBK byte pairs: high 0x81..0xFE, low 0x40..0xFE (excluding 0x7F).
gbk_count = 0
for high in range(0x81, 0xFF):
    for low in range(0x40, 0xFF):
        if low == 0x7F:
            continue
        try:
            c = bytes([high, low]).decode('gbk')
            chars.add(c)
            gbk_count += 1
        except (UnicodeDecodeError, ValueError):
            pass

# ---- CJK Compatibility Ideographs (variant forms the model may emit) ------
for i in range(0xF900, 0xFAFF + 1):
    chars.add(chr(i))

# ---- Common Chinese punctuation -------------------------------------------
extra = '，。、；：？！“”‘’（）《》【】—…·～￥％＃＆＊＋－／＜＝＞＠＼＾＿｀｜～〔〕〖〗〘〙〚〛〜〝〞〟〰〾〿'
chars.update(extra)

# ---- Latin-1 supplement ---------------------------------------------------
for i in range(0xA0, 0x100):
    chars.add(chr(i))
# ---- Latin Extended-A (ą, č, é, ñ, ö, ü, ž … author names in the book) ----
for i in range(0x100, 0x17F + 1):
    chars.add(chr(i))
# ---- General Punctuation (dashes, quotes, ellipsis) -----------------------
for i in range(0x2000, 0x206F + 1):
    chars.add(chr(i))
# ---- Superscripts / subscripts, currency ---------------------------------
for i in range(0x2070, 0x209F + 1):
    chars.add(chr(i))
# ---- Letterlike symbols & Number forms ------------------------------------
for i in range(0x2100, 0x214F + 1):
    chars.add(chr(i))
for i in range(0x2150, 0x218F + 1):
    chars.add(chr(i))
# ---- Arrows (← → ↓ etc.) --------------------------------------------------
for i in range(0x2190, 0x21FF + 1):
    chars.add(chr(i))
# ---- Mathematical Operators (∑ ∫ √ × ÷ ± ∞ ≈ ≠ ≤ ≥ …) --------------------
for i in range(0x2200, 0x22FF + 1):
    chars.add(chr(i))
# ---- Geometric Shapes (■ ● ▪ ◦ bullets, etc.) ----------------------------
for i in range(0x25A0, 0x25FF + 1):
    chars.add(chr(i))
# ---- Enclosed Alphanumerics (① ② (1) etc.) --------------------------------
for i in range(0x2460, 0x24FF + 1):
    chars.add(chr(i))
# ---- CJK Symbols and Punctuation ------------------------------------------
for i in range(0x3000, 0x303F + 1):
    chars.add(chr(i))
# ---- Hiragana + Katakana (technical docs) ---------------------------------
for i in range(0x3040, 0x30FF + 1):
    chars.add(chr(i))
# ---- Enclosed CJK letters/months, CJK compatibility -----------------------
for i in range(0x3200, 0x32FF + 1):
    chars.add(chr(i))
# ---- Halfwidth + Fullwidth Forms ------------------------------------------
for i in range(0xFF00, 0xFFEF + 1):
    chars.add(chr(i))

text = ''.join(sorted(chars))
print(f"GBK hanzi added: {gbk_count}")
print(f"Total character set size: {len(chars)}")

os.makedirs('.scratch', exist_ok=True)
with open('.scratch/charset.txt', 'w', encoding='utf-8') as f:
    f.write(text)

# ---- Subset the font -------------------------------------------------------
options = subset.Options()
options.layout_features = ['*']
options.name_IDs = ['*']
options.name_legacy = True
options.name_languages = ['*']
options.notdef_outline = True
options.recalc_bounds = True
options.recalc_timestamp = True
options.canonical_order = True
options.glyph_names = False
options.no_cff_optimization = False
options.desubroutinize = False  # keep CFF subroutines for smaller file
options.hinting = True
options.drop_tables = ['DSIG', 'FFTM', 'meta']

font = subset.load_font('assets/fonts/NotoSansSC-Regular.ttf', options)
subsetter = subset.Subsetter(options=options)
subsetter.populate(text=text)
subsetter.subset(font)

output_path = 'assets/fonts/NotoSansSC-Subset.ttf'
subset.save_font(font, output_path, options)

orig_size = os.path.getsize('assets/fonts/NotoSansSC-Regular.ttf')
new_size = os.path.getsize(output_path)
print(f"Original: {orig_size/1024/1024:.1f} MB")
print(f"Subset:   {new_size/1024/1024:.1f} MB")
print(f"Reduction: {(1 - new_size/orig_size)*100:.1f}%")
print(f"Saved to: {output_path}")

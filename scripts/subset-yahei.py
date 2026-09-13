"""
Subset Microsoft YaHei (Regular + Bold) to cover GBK Chinese (21,886 chars) +
ASCII + punctuation + Latin Extended-A (ŠšŽžéèñü) + math/symbol ranges.

Also subsets Consolas (ASCII only) for code blocks.

Runs: C:\\Python310\\python.exe scripts/subset-yahei.py
"""
import os
from fontTools import subset

# ---------------------------------------------------------------------------
# Build the character set (same coverage as NotoSansSC subset)
# ---------------------------------------------------------------------------
chars = set()

# ---- ASCII printable -------------------------------------------------------
for i in range(0x20, 0x7F):
    chars.add(chr(i))

# ---- GBK full character set (GB2312 + extensions, ~21,886 hanzi) ----------
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

# ---- CJK Compatibility Ideographs -----------------------------------------
for i in range(0xF900, 0xFAFF + 1):
    chars.add(chr(i))

# ---- Common Chinese punctuation -------------------------------------------
extra = '，。、；：？！“”‘’（）《》【】—…·～￥％＃＆＊＋－／＜＝＞＠＼＾＿｀｜～〔〕〖〗〘〙〚〛〜〝〞〟〰〾〿'
chars.update(extra)

# ---- Latin-1 supplement (incl. ß æ ø) -------------------------------------
for i in range(0xA0, 0x100):
    chars.add(chr(i))
# ---- Latin Extended-A (Šš Žž éèñü œ ł etc. — author names) ---------------
for i in range(0x100, 0x17F + 1):
    chars.add(chr(i))
# ---- Latin Extended Additional (rare diacritics) --------------------------
for i in range(0x1E00, 0x1EFF + 1):
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
# ---- Arrows ----------------------------------------------------------------
for i in range(0x2190, 0x21FF + 1):
    chars.add(chr(i))
# ---- Mathematical Operators ------------------------------------------------
for i in range(0x2200, 0x22FF + 1):
    chars.add(chr(i))
# ---- Geometric Shapes (■ ● ▪ ◦ bullets) -----------------------------------
for i in range(0x25A0, 0x25FF + 1):
    chars.add(chr(i))
# ---- Enclosed Alphanumerics (① ② (1)) -------------------------------------
for i in range(0x2460, 0x24FF + 1):
    chars.add(chr(i))
# ---- CJK Symbols and Punctuation ------------------------------------------
for i in range(0x3000, 0x303F + 1):
    chars.add(chr(i))
# ---- Hiragana + Katakana ---------------------------------------------------
for i in range(0x3040, 0x30FF + 1):
    chars.add(chr(i))
# ---- Enclosed CJK letters/months, CJK compatibility -----------------------
for i in range(0x3200, 0x32FF + 1):
    chars.add(chr(i))
# ---- Halfwidth + Fullwidth Forms -------------------------------------------
for i in range(0xFF00, 0xFFEF + 1):
    chars.add(chr(i))

text = ''.join(sorted(chars))
print(f"GBK hanzi added: {gbk_count}")
print(f"Total character set size: {len(chars)}")

os.makedirs('.scratch', exist_ok=True)
with open('.scratch/charset-yahei.txt', 'w', encoding='utf-8') as f:
    f.write(text)


def make_options():
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
    options.drop_tables = ['DSIG', 'FFTM', 'meta']
    options.hinting = True
    return options


def subset_font(input_path: str, output_path: str, charset_text: str):
    options = make_options()
    font = subset.load_font(input_path, options)
    subsetter = subset.Subsetter(options=options)
    subsetter.populate(text=charset_text)
    subsetter.subset(font)
    subset.save_font(font, output_path, options)
    orig = os.path.getsize(input_path)
    new = os.path.getsize(output_path)
    print(f"  {input_path}")
    print(f"    Original: {orig/1024/1024:.1f} MB -> Subset: {new/1024/1024:.1f} MB ({(1-new/orig)*100:.0f}% reduction)")


# ---- Subset Microsoft YaHei Regular + Bold --------------------------------
print("=== Subsetting Microsoft YaHei Regular ===")
subset_font(
    'assets/fonts/MicrosoftYaHei-Regular.ttf',
    'assets/fonts/MicrosoftYaHei-Regular-subset.ttf',
    text
)

print("=== Subsetting Microsoft YaHei Bold ===")
subset_font(
    'assets/fonts/MicrosoftYaHei-Bold.ttf',
    'assets/fonts/MicrosoftYaHei-Bold-subset.ttf',
    text
)

# ---- Subset Consolas (ASCII only for code blocks) -------------------------
print("=== Subsetting Consolas (ASCII) ===")
ascii_chars = ''.join(chr(i) for i in range(0x20, 0x7F))
# Add common code symbols
ascii_chars += ' \t\n\r'
subset_font(
    'C:/Windows/Fonts/consola.ttf',
    'assets/fonts/Consolas-subset.ttf',
    ascii_chars
)

# ---- Verify special chars in the subsetted Regular font -------------------
print("=== Verification ===")
from fontTools.ttLib import TTFont
test_chars = 'ŠšŽžéèñüæœßłø'
font = TTFont('assets/fonts/MicrosoftYaHei-Regular-subset.ttf')
cmap = font.getBestCmap()
missing = [c for c in test_chars if ord(c) not in cmap]
if missing:
    print(f"  MISSING glyphs for: {missing}")
else:
    print(f"  All test chars present: {test_chars}")

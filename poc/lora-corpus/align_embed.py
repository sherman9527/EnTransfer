# align_embed.py — high-precision EN<->ZH parallel alignment via multilingual
# sentence embeddings (vs the lexical token aligner which capped ~50%).
#
#   python poc/lora-corpus/align_embed.py <en.json> <zh.json> <out.jsonl> [--min=0.55]
#
# Reads harvest-segments JSON ({segments:[{page,text}]}), embeds both sides with
# paraphrase-multilingual-MiniLM, then runs a monotone (order-preserving) DP on
# the cosine-similarity matrix. Only pairs above --min are emitted, as SFT JSONL.
# Prints a random sample so precision is eyeballed, not assumed.
import json, os, sys, random
import numpy as np

os.environ.setdefault('HF_ENDPOINT', 'https://hf-mirror.com')
os.environ.setdefault('HF_HUB_DISABLE_XET', '1')
os.environ.setdefault('TOKENIZERS_PARALLELISM', 'false')

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, '..', '..'))
CACHE = os.path.join(ROOT, 'poc', 'models')

# crude prose filters (skip code / table / index noise so it can't false-align)
def is_prose(s):
    t = s.strip()
    if len(t) < 12: return False
    if any(k in t for k in ['{}', '=>', 'def ', 'import ', 'SELECT ', 'http', '.py', '.parquet', '%sql']): return False
    # index/TOC: many ", <num>" patterns
    if t.count(', ') and sum(ch.isdigit() for ch in t) > len(t) * 0.15: return False
    return True

def main():
    en = json.load(open(sys.argv[1], encoding='utf-8'))['segments']
    zh = json.load(open(sys.argv[2], encoding='utf-8'))['segments']
    out = sys.argv[3]
    minarg = [a for a in sys.argv if a.startswith('--min=')]
    MIN = float(minarg[0].split('=')[1]) if minarg else 0.55

    # Split paragraphs into SENTENCES before aligning. The two books have a ~2:1
    # paragraph-granularity mismatch (a translator often merges two EN paragraphs
    # into one ZH block), so 1:1 alignment at PARAGRAPH level can't find clean
    # pairs; at sentence level the units line up far better.
    import re
    def split_sents(segs, lang):
        outp = []
        for s in segs:
            t = s['text']
            if lang == 'zh':
                parts = re.split(r'(?<=[。！？；])', t)
            else:
                parts = re.split(r'(?<=[.!?])\s+', t)
            for p in parts:
                p = p.strip()
                if len(p) >= (8 if lang == 'zh' else 30):
                    outp.append({'text': p, 'page': s['page']})
        return outp

    en = [e for e in en if is_prose(e['text'])]
    zh = [z for z in zh if is_prose(z['text'])]
    en = split_sents(en, 'en')
    zh = split_sents(zh, 'zh')
    print(f'[align] prose EN={len(en)} ZH={len(zh)}')

    from sentence_transformers import SentenceTransformer
    model_name = os.environ.get('ALIGN_MODEL', 'sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2')
    m = SentenceTransformer(model_name, cache_folder=CACHE)
    E = m.encode([e['text'] for e in en], normalize_embeddings=True, batch_size=64, show_progress_bar=False)
    Z = m.encode([z['text'] for z in zh], normalize_embeddings=True, batch_size=64, show_progress_bar=False)
    S = E @ Z.T  # cosine similarity N x M

    N, M = len(en), len(zh)
    GAP = -0.2
    dp = np.full((N + 1, M + 1), -1e9, dtype=np.float64)
    bt = np.zeros((N + 1, M + 1), dtype=np.int8)  # 1 match,2 skipE,3 skipZ
    dp[0, 0] = 0
    for i in range(N + 1):
        for j in range(M + 1):
            if i == 0 and j == 0: continue
            best, op = -1e9, 0
            if i > 0 and dp[i - 1, j] + GAP > best: best, op = dp[i - 1, j] + GAP, 2
            if j > 0 and dp[i, j - 1] + GAP > best: best, op = dp[i, j - 1] + GAP, 3
            if i > 0 and j > 0:
                s = dp[i - 1, j - 1] + S[i - 1, j - 1]
                if s > best: best, op = s, 1
            dp[i, j], bt[i, j] = best, op
    pairs = []
    i, j = N, M
    while i > 0 or j > 0:
        op = bt[i, j]
        if op == 1:
            sc = float(S[i - 1, j - 1])
            if sc >= MIN: pairs.append((en[i - 1]['text'], zh[j - 1]['text'], round(sc, 3)))
            i -= 1; j -= 1
        elif op == 2: i -= 1
        elif op == 3: j -= 1
        else: break
    pairs.reverse()

    SYSTEM = '你是专业的技术图书英译中译者。将下面的英文翻译成流畅、准确的简体中文，保留术语、标识符、URL 与数字，不翻译代码。'
    with open(out, 'w', encoding='utf-8') as f:
        for e, z, sc in pairs:
            f.write(json.dumps({'messages': [
                {'role': 'system', 'content': SYSTEM},
                {'role': 'user', 'content': e},
                {'role': 'assistant', 'content': z}]}, ensure_ascii=False) + '\n')
    print(f'[align] {len(pairs)} pairs (min {MIN}) -> {out}')
    random.seed(7)
    for e, z, sc in random.sample(pairs, min(8, len(pairs))):
        print(f'\n[{sc}] EN: {e[:80]}\n     ZH: {z[:60]}')

if __name__ == '__main__':
    main()

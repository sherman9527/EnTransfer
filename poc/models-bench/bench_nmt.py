# bench_nmt.py — convert an HF opus-mt checkpoint to CTranslate2 int8 and
# translate the shared EN corpus (poc/speed-v3/corpus.json, 80 paragraphs) so
# quality + speed are directly comparable to the shipped Qwen3-1.7B run.
#
#   python poc/models-bench/bench_nmt.py
#
# Writes poc/models-bench/out-opus-mt.txt (one translation per line, same order
# as corpus.json) and prints wall-clock tok/s. Models live under poc/models/.
import json, os, time, sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, '..', '..'))
SRC = os.path.join(ROOT, 'poc', 'models', 'opus-mt-en-zh')
CT2 = os.path.join(ROOT, 'poc', 'models', 'opus-mt-en-zh-ct2')
CORPUS = os.path.join(ROOT, 'poc', 'speed-v3', 'corpus.json')
OUT = os.path.join(HERE, 'out-opus-mt.txt')


def convert():
    if os.path.isdir(CT2) and os.path.exists(os.path.join(CT2, 'model.bin')):
        print('[ct2] already converted:', CT2)
        return
    import ctranslate2
    print('[ct2] converting HF -> CTranslate2 ...')
    t = time.time()
    converter = ctranslate2.converters.TransformersConverter(SRC)
    converter.convert(CT2)
    print(f'[ct2] converted in {time.time()-t:.1f}s')


def main():
    convert()
    import ctranslate2
    from transformers import AutoTokenizer
    texts = json.load(open(CORPUS, encoding='utf-8'))['texts']
    print(f'[bench] {len(texts)} EN paragraphs from corpus.json')
    tok = AutoTokenizer.from_pretrained(SRC)
    translator = ctranslate2.Translator(CT2, device='cpu', compute_type='int8')
    # opus-mt uses marian: prefix the target lang code token 'zh'
    tgt = ['zh']
    batch_size = 8
    results = []
    t0 = time.time()
    total_chars = 0
    for i in range(0, len(texts), batch_size):
        batch = texts[i:i+batch_size]
        src_tokens = [tok.convert_ids_to_tokens(tok.encode(t, add_special_tokens=False)) for t in batch]
        out = translator.translate_batch(
            src_tokens, target_prefix=[tgt] * len(src_tokens),
            beam_size=2, num_hypotheses=1)
        for res in out:
            d = res[0] if not isinstance(res, dict) else res
            toks = d['tokens']
            # strip the forced target lang-code prefix token(s)
            while toks and toks[0] in ('zh', '<unk>'):
                toks = toks[1:]
            text = tok.decode(tok.convert_tokens_to_ids(toks), skip_special_tokens=True)
            results.append(text)
            total_chars += len(text)
    dt = time.time() - t0
    open(OUT, 'w', encoding='utf-8').write('\n'.join(results))
    print(f'[bench] done in {dt:.1f}s  ({len(texts)/dt:.2f} para/s, ~{total_chars/dt:.0f} zh-char/s) -> {OUT}')
    for i in range(min(5, len(results))):
        print(f'\n--- [{i}] EN: {texts[i][:110]}')
        print(f'    ZH: {results[i][:110]}')


if __name__ == '__main__':
    main()

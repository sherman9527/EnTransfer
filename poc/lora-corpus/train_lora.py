# train_lora.py — QLoRA SFT fine-tune of the shipped base (Qwen3-1.7B) on the
# gold parallel JSONL produced by align_embed.py. READY TO RUN once the training
# data is curated to gold precision (see FINDINGS — auto-align currently caps
# ~40-50%, so this is scaffolding, not a validated training recipe yet).
#
#   python poc/lora-corpus/train_lora.py <train.jsonl> [--out lora-out] [--epochs 3]
#
# Needs the HF weights (Qwen/Qwen3-1.7B) — downloaded to poc/models on first run,
# delete after. For a 6GB GTX1060: 4-bit QLoRA + paged AdamW + grad checkpointing.
# Output = a LoRA adapter; convert+merge to GGUF for the app (see README notes).
import os, sys, argparse

os.environ.setdefault('HF_ENDPOINT', 'https://hf-mirror.com')
os.environ.setdefault('HF_HUB_DISABLE_XET', '1')

BASE = 'Qwen/Qwen3-1.7B'


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('data')
    ap.add_argument('--out', default='poc/lora-corpus/lora-out')
    ap.add_argument('--epochs', type=float, default=3)
    ap.add_argument('--bs', type=int, default=4)
    ap.add_argument('--lr', type=float, default=1e-4)
    a = ap.parse_args()

    import torch
    from datasets import load_dataset
    from peft import LoraConfig
    from transformers import AutoModelForCausalLM, AutoTokenizer, BitsAndBytesConfig
    from trl import SFTTrainer, SFTConfig

    tok = AutoTokenizer.from_pretrained(BASE)
    if tok.pad_token is None:
        tok.pad_token = tok.eos_token
    bnb = BitsAndBytesConfig(load_in_4bit=True, bnb_4bit_quant_type='nf4',
                             bnb_4bit_compute_dtype=torch.bfloat16, bnb_4bit_use_double_quant=True)
    model = AutoModelForCausalLM.from_pretrained(BASE, quantization_config=bnb, device_map='auto', trust_remote_code=True)
    model.config.use_cache = False

    # rows: {"messages":[{role,content},...]} -> chat-formatted single string
    ds = load_dataset('json', data_files=a.data, split='train')

    def fmt(ex):
        return {'text': tok.apply_chat_template(
            [{'role': m['role'], 'content': m['content']} for m in ex['messages']],
            tokenize=False, add_generation_prompt=False)}
    ds = ds.map(fmt, remove_columns=ds.column_names)

    lora = LoraConfig(r=16, lora_alpha=32, target_modules=['q_proj', 'k_proj', 'v_proj', 'o_proj'],
                      lora_dropout=0.05, bias='none', task_type='CAUSAL_LM')
    cfg = SFTConfig(output_dir=a.out, num_train_epochs=a.epochs, per_device_train_batch_size=a.bs,
                    gradient_accumulation_steps=8, learning_rate=a.lr, logging_steps=10,
                    optim='paged_adamw_8bit', gradient_checkpointing=True, fp16=False, bf16=True,
                    max_seq_length=1024, report_to='none')
    trainer = SFTTrainer(model=model, args=cfg, train_dataset=ds, peft_config=lora,
                         processing_class=tok)
    trainer.train()
    trainer.save_model(a.out)
    print(f'[train] adapter saved -> {a.out}')
    print('[train] next: merge into base -> convert to GGUF (Q4_K_M) -> swap into models/ and run eval_gate.py')


if __name__ == '__main__':
    main()

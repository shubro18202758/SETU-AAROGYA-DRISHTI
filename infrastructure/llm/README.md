# Local LLM Runtime

The `llm` service uses Hugging Face Text Generation Inference with:

- Model: `Qwen/Qwen3.5-4B`
- Quantization: `bitsandbytes-nf4`
- GPU memory fraction: `0.36`
- Single shard and small batch/token windows for an 8 GB VRAM workstation

This keeps the model weights near a sub-3 GB target while leaving VRAM headroom for the desktop, CUDA context, and short-context KV cache. Increase token and batch limits only after measuring VRAM usage on the target GPU.

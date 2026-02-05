python -m llama_cpp.server \
  --model llm/llama_cpp/models/model.gguf\
  --host 0.0.0.0 \
  --n_ctx 4096 \
  --port 8000
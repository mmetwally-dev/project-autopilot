// An adapter declares its free models with `free_model_pattern` (regex source)
// in adapters/agents.json. No field -> the adapter has no free models.
export function isFreeModel(adapterMeta, modelId) {
  const src = adapterMeta?.free_model_pattern;
  if (typeof src !== "string" || !src || typeof modelId !== "string") return false;
  try { return new RegExp(src).test(modelId); } catch { return false; }
}

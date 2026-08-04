// Lazy on-device sentence-embedding pipeline (Transformers.js).
//
// WHY AN EMBEDDING MODEL AND NOT A GENERATIVE ONE: see the mood search
// section of the README. Short version: a generative model needs WebGPU to
// be usable, and WebGPU support across the Android WebView range this app
// targets (API 24 through 36) is inconsistent enough that the feature would
// simply not work for a meaningful share of users. A ~25MB quantised
// embedding model runs acceptably on the WASM fallback path everywhere.
//
// Nothing here runs at app startup. The module-level state below stays
// untouched, and the ~25MB model is never fetched, until something calls
// loadEmbedder(). That is the single most important property of this file:
// a user who never opens mood search pays nothing for it.

import { EMBEDDING_DIMENSIONS, EMBEDDING_MODEL_ID } from "./vocabulary";

export type EmbedderStatus =
  | { state: "idle" }
  | { state: "loading"; progress: number | null }
  | { state: "ready" }
  | { state: "failed"; reason: string };

type FeatureExtractor = (
  text: string | string[],
  options: { pooling: "mean"; normalize: boolean }
) => Promise<{ data: unknown; dims: unknown }>;

let extractor: FeatureExtractor | null = null;
let loadPromise: Promise<FeatureExtractor> | null = null;
let cancelled = false;

const listeners = new Set<(status: EmbedderStatus) => void>();
let status: EmbedderStatus = { state: "idle" };

function setStatus(next: EmbedderStatus): void {
  status = next;
  for (const listener of listeners) listener(next);
}

export function getEmbedderStatus(): EmbedderStatus {
  return status;
}

export function subscribeToEmbedderStatus(listener: (status: EmbedderStatus) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * Abandons an in-flight load. The bytes already fetched stay in Cache
 * Storage, so a later retry resumes from a warm cache rather than starting
 * the whole download over. Does not tear down an already-ready model.
 */
export function cancelEmbedderLoad(): void {
  if (status.state !== "loading") return;
  cancelled = true;
  loadPromise = null;
  setStatus({ state: "idle" });
}

export function isEmbedderReady(): boolean {
  return extractor !== null;
}

/**
 * Loads (and caches) the model. Concurrent callers share one in-flight
 * promise, so opening the search box twice while it downloads does not
 * start a second 25MB fetch.
 *
 * Throws on failure rather than returning null: every caller here has a
 * meaningful fallback (plain keyword search) and should handle the failure
 * explicitly rather than silently proceed with a half-working pipeline.
 */
export async function loadEmbedder(): Promise<FeatureExtractor> {
  if (extractor) return extractor;
  if (loadPromise) return loadPromise;

  cancelled = false;
  setStatus({ state: "loading", progress: null });

  loadPromise = (async () => {
    // Dynamic import, not a static one: this is what keeps Transformers.js
    // out of the main bundle so app startup is unaffected.
    const { pipeline } = await import("@huggingface/transformers");

    const created = await pipeline("feature-extraction", EMBEDDING_MODEL_ID, {
      // Pinned to WASM rather than left to the library's device selection.
      // WASM is already the default today, but stating it means a future
      // library version that starts preferring WebGPU cannot silently change
      // behaviour on the older Android WebViews this app supports, where
      // WebGPU may be detected and then fail at inference time.
      device: "wasm",
      dtype: "q8", // int8 quantised, roughly 25MB rather than roughly 90MB
      progress_callback: (report: { status?: string; progress?: number }) => {
        if (cancelled) return;
        if (report?.status === "progress" && typeof report.progress === "number") {
          setStatus({ state: "loading", progress: Math.max(0, Math.min(100, report.progress)) });
        }
      },
    });

    if (cancelled) throw new Error("Model load cancelled");
    return created as unknown as FeatureExtractor;
  })();

  try {
    extractor = await loadPromise;
    setStatus({ state: "ready" });
    return extractor;
  } catch (e) {
    loadPromise = null;
    const reason = e instanceof Error ? e.message : String(e);
    // Not re-thrown as a custom type: callers only ever need "it did not
    // work, use plain search", and the message is for display only.
    setStatus({ state: "failed", reason });
    throw e;
  }
}

/**
 * Validates and copies the pipeline's raw output into a plain Float32Array.
 *
 * This exists because the rest of mood search does arithmetic on these
 * numbers and then filters the user's library with the result. Transformers.js
 * returns a Tensor whose exact shape depends on the model, the pooling
 * option, and the library version, so it is checked here rather than
 * trusted: wrong dimensions, or a NaN anywhere in the vector, would not
 * throw downstream, it would quietly produce meaningless similarities and a
 * plausible-looking but wrong result list.
 */
export function toVector(raw: { data: unknown; dims: unknown }): Float32Array {
  const data = raw?.data;
  if (!(data instanceof Float32Array) && !Array.isArray(data)) {
    throw new Error("Embedding output was not a numeric array");
  }
  const values = data instanceof Float32Array ? data : Float32Array.from(data as number[]);
  if (values.length !== EMBEDDING_DIMENSIONS) {
    throw new Error(`Embedding had ${values.length} dimensions, expected ${EMBEDDING_DIMENSIONS}`);
  }
  for (let i = 0; i < values.length; i++) {
    if (!Number.isFinite(values[i])) throw new Error("Embedding contained a non-finite value");
  }
  return values;
}

/** Embeds one string. Assumes loadEmbedder() has already resolved. */
export async function embed(text: string): Promise<Float32Array> {
  const pipe = extractor ?? (await loadEmbedder());
  const raw = await pipe(text, { pooling: "mean", normalize: true });
  return toVector(raw);
}

/**
 * Cosine similarity. Both inputs are expected to be L2-normalised already
 * (normalize: true above), so this is a plain dot product; the length guard
 * catches a stale cached vector from a different model rather than letting
 * it produce a silently truncated comparison.
 */
export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) return 0;
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += a[i] * b[i];
  return sum;
}

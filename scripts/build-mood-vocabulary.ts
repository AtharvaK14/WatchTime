// Precomputes the mood-search vocabulary embeddings, once, at build time.
//
// Run: npm run build:mood-vocabulary
// Output: public/mood-vocabulary.json (committed; Vite serves it as a static
// asset, so it is bundled into the APK and needs no network at runtime).
//
// Why build time: the vocabulary is fixed and identical for every user, so
// embedding it on device would burn a couple of seconds of a phone's CPU on
// every single session to reproduce a byte-identical result. Only the user's
// live query genuinely has to be embedded at runtime.
//
// Re-run this whenever MOOD_VOCABULARY or EMBEDDING_MODEL_ID changes in
// src/lib/moodSearch/vocabulary.ts. The model check below fails the build
// rather than emitting a file whose vectors came from a different model
// than the app will use at runtime, which would produce meaningless
// similarities that nothing downstream could detect.
//
// This script runs the model through onnxruntime-node, which is a dev-only
// dependency: the app itself ships the WASM build. See the security note in
// the README's mood search section.

import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { pipeline } from "@huggingface/transformers";
import {
  MOOD_VOCABULARY,
  EMBEDDING_MODEL_ID,
  EMBEDDING_DIMENSIONS,
} from "../src/lib/moodSearch/vocabulary";

const OUTPUT = resolve(dirname(fileURLToPath(import.meta.url)), "../public/mood-vocabulary.json");

// Six decimals is far below the precision at which a cosine comparison
// against a 0.38 threshold could change outcome, and roughly halves the
// committed file versus full float printing.
const PRECISION = 6;

async function main() {
  console.log(`Embedding ${MOOD_VOCABULARY.length} vocabulary tags with ${EMBEDDING_MODEL_ID}...`);
  const extract = await pipeline("feature-extraction", EMBEDDING_MODEL_ID, { dtype: "q8" });

  const tags = [];
  for (const tag of MOOD_VOCABULARY) {
    const output = await extract(tag.phrase, { pooling: "mean", normalize: true });
    const vector = Array.from(output.data as Float32Array);
    if (vector.length !== EMBEDDING_DIMENSIONS) {
      throw new Error(
        `Tag "${tag.id}" produced ${vector.length} dimensions but vocabulary.ts declares ` +
          `EMBEDDING_DIMENSIONS = ${EMBEDDING_DIMENSIONS}. Update the constant or the model id.`
      );
    }
    tags.push({
      id: tag.id,
      genreIds: tag.genreIds,
      vector: vector.map((v) => Number(v.toFixed(PRECISION))),
    });
    console.log(`  ${tag.id}`);
  }

  mkdirSync(dirname(OUTPUT), { recursive: true });
  writeFileSync(
    OUTPUT,
    JSON.stringify({ model: EMBEDDING_MODEL_ID, dimensions: EMBEDDING_DIMENSIONS, tags }) + "\n"
  );
  console.log(`Wrote ${OUTPUT} (${tags.length} tags)`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

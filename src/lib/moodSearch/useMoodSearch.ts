// React state for mood search: model lifecycle, one-time index build, and
// the resulting filter.
//
// The whole feature is opt-in and inert until used. Nothing here downloads,
// embeds, or touches the network until prepare() is called, which only
// happens when the user actually submits a mood query.

import { useCallback, useEffect, useRef, useState } from "react";
import {
  cancelEmbedderLoad,
  getEmbedderStatus,
  loadEmbedder,
  subscribeToEmbedderStatus,
  type EmbedderStatus,
} from "./embedder";
import { backfillOverviews, buildTitleEmbeddings, type IndexProgress } from "./titleIndex";
import { buildMoodFilter, type MoodCandidate, type MoodFilter } from "./search";

export type SetupPhase =
  | { state: "idle" }
  | { state: "downloading"; progress: number | null }
  | { state: "indexing"; phase: IndexProgress["phase"]; done: number; total: number }
  | { state: "ready" }
  | { state: "unavailable"; reason: string };

export interface MoodSearchState {
  setup: SetupPhase;
  filter: MoodFilter | null;
  searching: boolean;
  /** True once the user dismisses setup; suppresses the indicator for the session. */
  dismissed: boolean;
  run: (query: string, candidates: MoodCandidate[]) => Promise<void>;
  clear: () => void;
  cancelSetup: () => void;
}

function toSetupPhase(status: EmbedderStatus): SetupPhase {
  switch (status.state) {
    case "idle":
      return { state: "idle" };
    case "loading":
      return { state: "downloading", progress: status.progress };
    case "ready":
      return { state: "ready" };
    case "failed":
      return { state: "unavailable", reason: status.reason };
  }
}

export function useMoodSearch(): MoodSearchState {
  const [setup, setSetup] = useState<SetupPhase>(() => toSetupPhase(getEmbedderStatus()));
  const [filter, setFilter] = useState<MoodFilter | null>(null);
  const [searching, setSearching] = useState(false);
  const [dismissed, setDismissed] = useState(false);

  // Guards against a component that unmounts mid-download (the user
  // navigating away) writing state afterwards, and against a stale slow
  // search overwriting a newer one's result.
  const mounted = useRef(true);
  const runId = useRef(0);
  const cancelledRef = useRef(false);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  // Download progress is reported by the module-level embedder, not by this
  // hook, so two mounted components observe the same single load.
  useEffect(
    () =>
      subscribeToEmbedderStatus((status) => {
        if (!mounted.current) return;
        // An indexing pass already past the download stage must not be
        // reset to "ready" by a late status event.
        setSetup((current) => (current.state === "indexing" ? current : toSetupPhase(status)));
      }),
    []
  );

  const cancelSetup = useCallback(() => {
    cancelledRef.current = true;
    cancelEmbedderLoad();
    setDismissed(true);
    setSearching(false);
    setSetup({ state: "idle" });
  }, []);

  const clear = useCallback(() => {
    setFilter(null);
    setSearching(false);
  }, []);

  const run = useCallback(async (query: string, candidates: MoodCandidate[]) => {
    const trimmed = query.trim();
    if (!trimmed) {
      setFilter(null);
      return;
    }

    const id = ++runId.current;
    cancelledRef.current = false;
    setSearching(true);

    const isStale = () => !mounted.current || runId.current !== id || cancelledRef.current;

    try {
      await loadEmbedder();
      if (isStale()) return;

      // Both passes are no-ops once the library is indexed, so this cost is
      // paid on the first search only, not on every query.
      const onProgress = (p: IndexProgress) => {
        if (!isStale()) setSetup({ state: "indexing", phase: p.phase, done: p.done, total: p.total });
      };
      await backfillOverviews(onProgress, isStale);
      if (isStale()) return;
      await buildTitleEmbeddings(onProgress, isStale);
      if (isStale()) return;

      setSetup({ state: "ready" });
    } catch {
      // Swallowed on purpose. buildMoodFilter below degrades to keyword mode
      // on its own, so a failed model load costs the user the smart ranking,
      // not the search itself.
      if (!isStale()) setSetup({ state: "unavailable", reason: "Smart search is unavailable on this device." });
    }

    if (isStale()) return;
    try {
      const built = await buildMoodFilter(trimmed, candidates);
      if (isStale()) return;
      setFilter(built);
    } finally {
      if (!isStale()) setSearching(false);
    }
  }, []);

  return { setup, filter, searching, dismissed, run, clear, cancelSetup };
}

import { useEffect, type ReactNode } from "react";
import { useIsMobile } from "../lib/useIsMobile";
import { useLockBodyScroll } from "../lib/useLockBodyScroll";
import { useBackHandler } from "../lib/backHandler";
import { useAnimatedDismiss } from "../lib/useAnimatedDismiss";

/** Matches the .filter-sheet.is-leaving animation duration in index.css. */
const FILTER_SHEET_EXIT_MS = 220;

interface Props {
  resultCount: number;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  children: ReactNode;
}

/**
 * One labelled category of filters (status, genre, sort), used by both
 * Library.tsx and Movies.tsx so the two menus are organised identically.
 *
 * The wrapper is `display: contents` outside the sheet, which is what keeps
 * the desktop layout byte-for-byte what it was: the controls stay direct flex
 * children of .filters-row and the heading is hidden. Inside the mobile sheet
 * the wrapper becomes a real block with a heading and a divider above it, so
 * the menu reads as three groups instead of one continuous list.
 *
 * Grouping only — it adds no state and removes no filter.
 */
export function FilterGroup({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="filter-group">
      <h3 className="filter-group-title">{title}</h3>
      <div className="filter-group-body">{children}</div>
    </div>
  );
}

/**
 * Wraps the filter controls shared by Library.tsx and Movies.tsx.
 * Desktop: transparent passthrough, renders children exactly where they
 * were before, no behavior change at all.
 * Mobile: replaces the old pattern of three <select> elements shrunk to
 * share one row (a real usability problem: small touch targets, hard to
 * scan) with a single "Filters" trigger that opens a bottom sheet
 * containing the same, unmodified controls, now full-width and easy to tap.
 */
export default function FilterSheet({ resultCount, open, onOpenChange, children }: Props) {
  const isMobile = useIsMobile();

  if (!isMobile) {
    return <>{children}</>;
  }

  return (
    <>
      <button type="button" className="filter-sheet-trigger" onClick={() => onOpenChange(true)}>
        <span className="filter-sheet-trigger-dot" />
        Filters
      </button>
      {open && (
        <FilterSheetOverlay resultCount={resultCount} onClose={() => onOpenChange(false)}>
          {children}
        </FilterSheetOverlay>
      )}
    </>
  );
}

function FilterSheetOverlay({
  resultCount,
  onClose,
  children,
}: {
  resultCount: number;
  onClose: () => void;
  children: ReactNode;
}) {
  useLockBodyScroll();
  // The sheet slides away rather than being deleted from under the finger.
  // Every dismissal route goes through requestClose so they animate alike.
  const { closing, requestClose } = useAnimatedDismiss(onClose, FILTER_SHEET_EXIT_MS);
  useBackHandler(true, requestClose); // Android back closes the filter sheet

  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") requestClose();
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [requestClose]);

  return (
    <div className={`modal-backdrop ${closing ? "is-leaving" : ""}`} onClick={requestClose}>
      <div className={`filter-sheet ${closing ? "is-leaving" : ""}`} onClick={(e) => e.stopPropagation()}>
        <div className="filter-sheet-handle">
          <div className="sheet-drag-handle-bar" />
        </div>
        <div className="filter-sheet-body">{children}</div>
        <button type="button" className="filter-sheet-apply" onClick={requestClose}>
          Show {resultCount} result{resultCount === 1 ? "" : "s"}
        </button>
      </div>
    </div>
  );
}

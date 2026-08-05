import { useEffect, type ReactNode } from "react";
import { useCompactFilters } from "../lib/useIsMobile";
import { useDraggableSheet } from "../lib/useDraggableSheet";
import { useLockBodyScroll } from "../lib/useLockBodyScroll";
import { useBackHandler } from "../lib/backHandler";

interface Props {
  resultCount: number;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  children: ReactNode;
}

/**
 * Wraps the filter controls shared by Library.tsx and Movies.tsx.
 *
 * Wide: transparent passthrough, renders children inline exactly where they
 * were, no behaviour change at all.
 * Compact: replaces them with a single "Filters" trigger that opens a bottom
 * sheet containing the same, unmodified controls, now full-width and easy to
 * tap.
 *
 * The switch is on available WIDTH rather than device class — see
 * useCompactFilters. Inline, the controls need ~920px of row, so on anything
 * narrower they used to wrap onto a second line beneath the search field
 * instead of sharing it.
 */
export default function FilterSheet({ resultCount, open, onOpenChange, children }: Props) {
  const compact = useCompactFilters();

  if (!compact) {
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
  useBackHandler(true, onClose); // Android back closes the filter sheet
  // Exactly the hook the details panel uses, so both sheets share one
  // implementation of the slide-up, the easing, the fade, the drag tracking
  // and the dismiss threshold. Anything tuned there applies to both.
  const { sheetStyle, handleProps, sheetRef } = useDraggableSheet(onClose);

  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  return (
    // .sheet-backdrop drops the backdrop's 20px padding. backdrop-filter makes
    // that element the containing block for its position:fixed descendants on
    // engines that implement it, so with the padding the sheet's `bottom: 0`
    // resolved against the padding box and sat 20px off the bottom — the same
    // gap that had to be fixed on the details sheet.
    <div className="modal-backdrop sheet-backdrop" onClick={onClose}>
      <div
        ref={sheetRef}
        className="filter-sheet"
        style={sheetStyle}
        onClick={(e) => e.stopPropagation()}
      >
        {/* handleProps only on the grab bar, never the whole sheet, so
            scrolling and tapping the controls below are unaffected. */}
        <div className="filter-sheet-handle" {...handleProps}>
          <div className="sheet-drag-handle-bar" />
        </div>
        <div className="filter-sheet-body">{children}</div>
        <button type="button" className="filter-sheet-apply" onClick={onClose}>
          Show {resultCount} result{resultCount === 1 ? "" : "s"}
        </button>
      </div>
    </div>
  );
}

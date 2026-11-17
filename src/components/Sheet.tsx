import { useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useLockBodyScroll } from "../lib/useLockBodyScroll";
import { useBackHandler } from "../lib/backHandler";
import { useAnimatedDismiss } from "../lib/useAnimatedDismiss";
import { useSwipeDismiss } from "../lib/useSwipeDismiss";
import SegmentedControl from "./SegmentedControl";
import { InfoIcon } from "./icons";

/** Matches the .filter-sheet.is-leaving animation duration in index.css. */
const SHEET_EXIT_MS = 220;

/**
 * A bottom sheet in the Filters sheet's style: floating, rounded, a drag
 * handle, a title, content that scrolls, and one full-width button. Closes on
 * the button, a tap outside, swipe down, Android back and Escape.
 *
 * Portalled to the body, so a transformed ancestor (the tab slide-in) can
 * never pin it inside the page.
 */
export function Sheet({
  title,
  onClose,
  doneLabel = "Done",
  children,
}: {
  title: string;
  onClose: () => void;
  doneLabel?: string;
  /** Content, or a function of close() for content that closes the sheet itself (a picked option). */
  children: ReactNode | ((close: () => void) => ReactNode);
}) {
  useLockBodyScroll();
  const { closing, requestClose } = useAnimatedDismiss(onClose, SHEET_EXIT_MS);
  useBackHandler(true, requestClose);
  const sheetRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  useSwipeDismiss(sheetRef, scrollRef, true, requestClose);

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") requestClose();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [requestClose]);

  return createPortal(
    <div className={`modal-backdrop ${closing ? "is-leaving" : ""}`} onClick={requestClose}>
      <div
        ref={sheetRef}
        className={`filter-sheet app-sheet ${closing ? "is-leaving" : ""}`}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="filter-sheet-handle" aria-hidden="true">
          <div className="sheet-drag-handle-bar" />
        </div>
        <div className="filter-sheet-head">
          <h2>{title}</h2>
        </div>
        <div className="filter-sheet-scroll" ref={scrollRef}>
          <div className="filter-sheet-body">{typeof children === "function" ? children(requestClose) : children}</div>
        </div>
        <div className="filter-sheet-foot">
          <button type="button" className="filter-sheet-apply" onClick={requestClose}>
            {doneLabel}
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}

/**
 * A small ⓘ beside a heading that opens the longer explanation in a sheet,
 * so a settings section can say one line and keep the detail a tap away.
 */
export function InfoButton({ title, children }: { title: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" className="info-button" aria-label={`About ${title}`} onClick={() => setOpen(true)}>
        <InfoIcon size={18} />
      </button>
      {open && (
        <Sheet title={title} onClose={() => setOpen(false)} doneLabel="Got it">
          <div className="info-sheet-text">{children}</div>
        </Sheet>
      )}
    </>
  );
}

/** A section heading with an optional ⓘ for its explanation. */
export function HeadingWithInfo({
  title,
  infoTitle = title,
  info,
}: {
  title: string;
  infoTitle?: string;
  info?: ReactNode;
}) {
  return (
    <div className="heading-with-info">
      <h3>{title}</h3>
      {info && <InfoButton title={infoTitle}>{info}</InfoButton>}
    </div>
  );
}

/**
 * A settings row that shows the current choice and opens a sheet of radio
 * options to change it: the app's own picker in place of the system's
 * native <select> dialog.
 */
export function ChoiceRow<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: { value: T; label: string }[];
  onChange: (value: T) => void;
}) {
  const [open, setOpen] = useState(false);
  const current = options.find((o) => o.value === value)?.label ?? value;
  return (
    <>
      <button type="button" className="choice-row" onClick={() => setOpen(true)} aria-haspopup="dialog">
        <span className="choice-row-label">{label}</span>
        <span className="choice-row-value">{current}</span>
        <span className="choice-row-chevron" aria-hidden="true">
          ›
        </span>
      </button>
      {open && (
        <Sheet title={label} onClose={() => setOpen(false)} doneLabel="Cancel">
          {(close) => (
            <SegmentedControl
              options={options}
              value={value}
              onChange={(next) => {
                onChange(next);
                close();
              }}
            />
          )}
        </Sheet>
      )}
    </>
  );
}

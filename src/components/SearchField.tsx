import type { InputHTMLAttributes } from "react";
import { SearchIcon } from "./icons";

/**
 * The text field of a search bar: a magnifier, the input, and an inline clear.
 *
 * Home's search and Discover's search already shared this shape through CSS
 * alone (.search-field). It is a component now so the pieces added to it —
 * the icon, and the focus treatment in index.css — reach both from one place
 * instead of being copied into each and drifting.
 *
 * Deliberately only the field. The submit button, the suggestion list and
 * everything a search does stay with the caller, because those are what
 * genuinely differ between the two pages.
 */
export default function SearchField({
  clearable,
  onClear,
  ...inputProps
}: Omit<InputHTMLAttributes<HTMLInputElement>, "type"> & {
  /** Whether the clear button shows. */
  clearable: boolean;
  onClear: () => void;
}) {
  return (
    <div className={`search-field${clearable ? " is-clearable" : ""}`}>
      <span className="search-field-icon" aria-hidden="true">
        <SearchIcon size={17} />
      </span>
      {/* enterKeyHint puts "Search" on a phone keyboard's action key, since
          both pages run the search on Enter. */}
      <input type="text" enterKeyHint="search" {...inputProps} />
      {clearable && (
        <button type="button" className="search-clear" onClick={onClear} aria-label="Clear search">
          &times;
        </button>
      )}
    </div>
  );
}

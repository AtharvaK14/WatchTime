import { useState } from "react";
import SearchDock, { SearchDockClear } from "./SearchDock";
import { SearchIcon } from "./icons";

/**
 * Search and filters for the Shows and Movies tabs on a phone: the bottom
 * dock (SearchDock) with a filter button beside the search, and a field that
 * filters the grid as you type. With the keyboard down and a search still
 * typed in, the field stays open so the search in force is always visible.
 */
export default function SearchFilterDock({
  query,
  onQueryChange,
  placeholder,
  filtersActive,
  onOpenFilters,
}: {
  query: string;
  onQueryChange: (query: string) => void;
  placeholder: string;
  /** Any filter differs from the page's default: the filter button carries a dot. */
  filtersActive: boolean;
  onOpenFilters: () => void;
}) {
  const [open, setOpen] = useState(query !== "");

  const close = () => {
    onQueryChange("");
    setOpen(false);
  };

  return (
    <SearchDock
      expanded={open || query !== ""}
      collapsible={query === ""}
      onExpand={() => setOpen(true)}
      onCollapse={close}
      label={placeholder}
      filters={{ active: filtersActive, onOpen: onOpenFilters }}
    >
      <div className="search-dock-field">
        <SearchIcon size={20} />
        <input
          type="text"
          value={query}
          onChange={(e) => onQueryChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") e.currentTarget.blur();
            if (e.key === "Escape") close();
          }}
          placeholder={placeholder}
          aria-label={placeholder}
          enterKeyHint="search"
          autoComplete="off"
        />
        <SearchDockClear hasText={query !== ""} onClear={() => onQueryChange("")} onClose={close} />
      </div>
    </SearchDock>
  );
}

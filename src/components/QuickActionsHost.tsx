import { useState, type ReactNode } from "react";
import { closeQuickMenu, closeWatchHistory, useQuickMenu, useWatchHistoryTarget, type QuickMenuEntry } from "../lib/quickMenu";
import { createPortal } from "react-dom";
import { dismissToast, showErrorToast, showToast, useToasts } from "../lib/toast";
import ActionMenu from "./ActionMenu";
import WatchHistorySheet from "./WatchHistorySheet";
import {
  CheckIcon,
  HistoryIcon,
  InfoIcon,
  ListIcon,
  MinusCircleIcon,
  PlayIcon,
  PlusIcon,
  RepeatIcon,
  StopIcon,
  TrashIcon,
  UnwatchedIcon,
} from "./icons";

/** The glyph beside each kind of action, shared by every menu. */
function actionIcon(id: string): ReactNode {
  switch (id) {
    case "view-details":
    case "episode-details":
      return <InfoIcon />;
    case "season-details":
      return <ListIcon />;
    case "mark-watched":
    case "watched-once":
      return <CheckIcon />;
    case "watched-again":
      return <RepeatIcon />;
    case "remove-last":
      return <MinusCircleIcon />;
    case "mark-unwatched":
    case "not-watched":
      return <UnwatchedIcon />;
    case "resume":
      return <PlayIcon />;
    case "stop":
      return <StopIcon />;
    case "add":
      return <PlusIcon />;
    case "remove":
      return <TrashIcon />;
    case "history":
      return <HistoryIcon />;
    default:
      return null;
  }
}

/**
 * Runs a menu entry: closes the menu at once (selecting is the dismissal),
 * then reports the outcome only after the write has landed - a toast with the
 * entry's message, or the error when it did not save.
 */
async function runEntry(entry: QuickMenuEntry): Promise<void> {
  closeQuickMenu();
  try {
    const message = await entry.run();
    if (message) showToast(message);
  } catch (e) {
    showErrorToast(e);
  }
}

function QuickMenuView() {
  const menu = useQuickMenu();
  // Which entry is asking for confirmation, for THIS menu (by id), so a new
  // menu never opens straight into an old question.
  const [confirming, setConfirming] = useState<{ menuId: number; entry: QuickMenuEntry } | null>(null);
  if (!menu) return null;
  const pending = confirming?.menuId === menu.id ? confirming.entry : null;

  return (
    <ActionMenu
      key={menu.id}
      anchor={menu.anchor}
      label={menu.label}
      title={menu.title}
      subtitle={menu.subtitle}
      items={menu.entries.map((entry) => ({
        id: entry.id,
        label: entry.label,
        danger: entry.danger,
        checked: entry.checked,
        icon: actionIcon(entry.id),
      }))}
      confirm={pending?.confirm ?? null}
      onSelect={(id) => {
        const entry = menu.entries.find((e) => e.id === id);
        if (!entry) return;
        if (entry.confirm) setConfirming({ menuId: menu.id, entry });
        else void runEntry(entry);
      }}
      onConfirm={() => pending && void runEntry(pending)}
      // "Never mind" closes the menu outright rather than stepping back to the
      // list: nothing else was asked for, and nothing has been changed.
      onCancelConfirm={() => {
        setConfirming(null);
        closeQuickMenu();
      }}
      onClose={closeQuickMenu}
      returnFocusTo={menu.target}
      anchorEl={menu.target}
    />
  );
}

function Toasts() {
  const toasts = useToasts();
  // The live region is always present, so the first message is announced too.
  return createPortal(
    <div className="toast-stack" aria-live="polite">
      {toasts.map((t) => (
        <div
          key={t.id}
          className={`toast${t.tone === "error" ? " is-error" : ""}`}
          role={t.tone === "error" ? "alert" : "status"}
          onClick={() => dismissToast(t.id)}
        >
          {t.message}
        </div>
      ))}
    </div>,
    document.body
  );
}

/**
 * Mounted once, in App: the open Quick Actions menu, the watch history sheet
 * its actions open, and the confirmation toasts. Everything is portalled to
 * the body so it sits above any open panel.
 */
export default function QuickActionsHost() {
  const history = useWatchHistoryTarget();
  return (
    <>
      <QuickMenuView />
      {history && <WatchHistorySheet key={`${history.kind}:${history.tmdbId}`} target={history} onClose={closeWatchHistory} />}
      <Toasts />
    </>
  );
}

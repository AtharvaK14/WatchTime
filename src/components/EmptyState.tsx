import type { ComponentType, ReactNode } from "react";
import type { IconProps } from "./icons";

interface Props {
  icon: ComponentType<IconProps>;
  title: string;
  /** One or two sentences explaining why this is empty. Keep it concrete. */
  body?: ReactNode;
  /** The action that resolves the emptiness, where one exists. */
  action?: { label: string; onClick: () => void };
}

/**
 * A composed empty state: icon, headline, explanation, and — wherever the
 * user can actually do something about it — the button that does it.
 *
 * The app previously used a bare `<p className="muted">` for every one of
 * these, which left the most common first-run screens looking like a
 * rendering failure rather than a deliberate state.
 */
export default function EmptyState({ icon: Icon, title, body, action }: Props) {
  return (
    <div className="empty-state">
      <span className="empty-state-icon" aria-hidden="true">
        <Icon size={24} />
      </span>
      <p className="empty-state-title">{title}</p>
      {body && <p className="empty-state-body">{body}</p>}
      {action && (
        <button type="button" className="empty-state-action" onClick={action.onClick}>
          {action.label}
        </button>
      )}
    </div>
  );
}

import { useLockBodyScroll } from "../lib/useLockBodyScroll";
import { useBackHandler } from "../lib/backHandler";
import NotificationChoice from "./NotificationChoice";

/**
 * The onboarding notification question, for an install that finished
 * onboarding - or predates it - without ever being asked.
 *
 * Shown once, in the wizard's own card, only while no answer is stored (see
 * notificationChoiceMade): anyone who ever turned notifications on or off in
 * Settings already has one and never sees this, so nobody's preference is
 * reset or second-guessed. It is for the people the old default left with
 * notifications silently off and no prompt to say they existed.
 *
 * Back closes it for now without recording an answer, since a back press is
 * not a no; it comes back on the next launch until one of the two buttons is
 * pressed.
 */
export default function NotificationPrompt({ onClose }: { onClose: () => void }) {
  useLockBodyScroll();
  useBackHandler(true, onClose);
  return (
    <div className="modal-backdrop wizard-backdrop">
      <div className="modal wizard" role="dialog" aria-modal="true" aria-label="Notifications">
        <NotificationChoice stepLabel="Notifications · optional" onDone={onClose} />
      </div>
    </div>
  );
}

import { signal } from "@preact/signals";
import { parseIpcError } from "../ipc/client";

export type ToastVariant = "info" | "warning" | "error";

export interface ToastAction {
  label: string;
  onClick: () => void;
}

export interface ToastItem {
  id: string;
  message: string;
  variant: ToastVariant;
  action?: ToastAction;
}

export const toastsSignal = signal<ToastItem[]>([]);
const toastTimers = new Map<string, ReturnType<typeof setTimeout>>();

export function dismissToast(id: string): void {
  const timer = toastTimers.get(id);
  if (timer !== undefined) {
    clearTimeout(timer);
    toastTimers.delete(id);
  }
  toastsSignal.value = toastsSignal.value.filter((t) => t.id !== id);
}

export function pushToast(
  message: string,
  variant: ToastVariant = "info",
  action?: ToastAction,
): string {
  const id = `toast_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  const next: ToastItem = { id, message, variant, action };
  toastsSignal.value = [...toastsSignal.value.slice(-3), next];

  const timer = setTimeout(() => {
    toastTimers.delete(id);
    dismissToast(id);
  }, 2800);
  toastTimers.set(id, timer);
  return id;
}

export function notifyIpcError(err: unknown): void {
  const parsed = parseIpcError(err);
  pushToast(parsed.message, parsed.code === "NODE_LOCKED" ? "warning" : "error");
}

export function ToastStack() {
  const items = toastsSignal.value;
  if (items.length === 0) {
    return null;
  }

  return (
    <div class="toast-stack" aria-live="polite">
      {items.map((toast) => (
        <div key={toast.id} class={`toast toast--${toast.variant}`}>
          <span class="toast__message">{toast.message}</span>
          {toast.action && (
            <button
              type="button"
              class="toast__action"
              onClick={() => {
                toast.action?.onClick();
                dismissToast(toast.id);
              }}
            >
              {toast.action.label}
            </button>
          )}
          <button
            type="button"
            class="toast__close"
            aria-label="Dismiss"
            onClick={() => dismissToast(toast.id)}
          >
            ×
          </button>
        </div>
      ))}
    </div>
  );
}

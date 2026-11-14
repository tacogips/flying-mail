import { createSignal } from "solid-js";

export type ToastKind = "info" | "success" | "error";

export interface Toast {
  readonly id: number;
  readonly kind: ToastKind;
  readonly message: string;
}

const TOAST_TTL_MS = 5000;

const [toasts, setToasts] = createSignal<readonly Toast[]>([]);
let nextId = 1;

/** Module-level rather than context-provided: a toast is fire-and-forget
 * feedback that any layer -- including the GraphQL client's error path --
 * needs to raise without threading a provider through. */
export function pushToast(kind: ToastKind, message: string): number {
  const id = nextId;
  nextId += 1;
  setToasts((current) => [...current, { id, kind, message }]);
  if (typeof setTimeout === "function") {
    setTimeout(() => dismissToast(id), TOAST_TTL_MS);
  }
  return id;
}

export function dismissToast(id: number): void {
  setToasts((current) => current.filter((toast) => toast.id !== id));
}

export function clearToasts(): void {
  setToasts([]);
}

export const activeToasts = toasts;

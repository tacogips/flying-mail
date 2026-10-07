export type DraftSaveOutcome =
  | { readonly kind: "saved" }
  | { readonly kind: "conflict" }
  | { readonly kind: "error"; readonly message: string };

export type DraftSaverState =
  | "idle"
  | "pending"
  | "saving"
  | "saved"
  | "error"
  | "conflict"
  | "disposed";

export interface DraftSaver<T> {
  notifyChange(content: T): void;
  flush(): Promise<void>;
  cancel(): Promise<void>;
  dispose(): void;
  state(): DraftSaverState;
}

export function createDraftSaver<T>(options: {
  readonly save: (content: T) => Promise<DraftSaveOutcome>;
  readonly isSame: (a: T, b: T) => boolean;
  readonly debounceMs: number;
  readonly onStateChange?: (state: DraftSaverState) => void;
}): DraftSaver<T> {
  let currentState: DraftSaverState = "idle";
  let savedContent: T | undefined;
  let hasSavedContent = false;
  let pendingContent: T | undefined;
  let hasPendingContent = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let inFlight: Promise<void> | undefined;
  let stoppedByConflict = false;
  let disposed = false;

  const setState = (state: DraftSaverState): void => {
    if (currentState === state) return;
    currentState = state;
    try {
      options.onStateChange?.(state);
    } catch {
      // Observer errors must not interrupt draft persistence.
    }
  };

  const clearTimer = (): void => {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
  };

  const drain = async (): Promise<void> => {
    if (disposed || stoppedByConflict) return;
    while (hasPendingContent && !disposed && !stoppedByConflict) {
      const content = pendingContent as T;
      pendingContent = undefined;
      hasPendingContent = false;
      if (hasSavedContent && options.isSame(content, savedContent as T)) {
        setState("saved");
        continue;
      }

      setState("saving");
      let outcome: DraftSaveOutcome;
      try {
        outcome = await options.save(content);
      } catch (error: unknown) {
        outcome = {
          kind: "error",
          message: error instanceof Error ? error.message : String(error),
        };
      }
      if (disposed) return;
      if (outcome.kind === "conflict") {
        stoppedByConflict = true;
        hasPendingContent = false;
        pendingContent = undefined;
        setState("conflict");
        return;
      }
      if (outcome.kind === "error") {
        setState("error");
        return;
      }
      savedContent = content;
      hasSavedContent = true;
      setState(hasPendingContent ? "pending" : "saved");
    }
  };

  const startDrain = (): Promise<void> => {
    if (inFlight !== undefined) return inFlight;
    const task = drain();
    inFlight = task;
    void task.finally(() => {
      if (inFlight === task) inFlight = undefined;
      if (!disposed && hasPendingContent && !stoppedByConflict)
        void startDrain();
    });
    return task;
  };

  return {
    notifyChange(content) {
      if (disposed || stoppedByConflict) return;
      pendingContent = content;
      hasPendingContent =
        inFlight !== undefined ||
        !(hasSavedContent && options.isSame(content, savedContent as T));
      clearTimer();
      if (!hasPendingContent) {
        setState("saved");
        return;
      }
      setState(inFlight === undefined ? "pending" : "saving");
      timer = setTimeout(
        () => {
          timer = undefined;
          if (hasPendingContent) void startDrain();
        },
        Math.max(0, options.debounceMs),
      );
    },
    async flush() {
      if (disposed || stoppedByConflict) return;
      clearTimer();
      if (hasPendingContent) setState("pending");
      while (inFlight !== undefined || hasPendingContent) {
        if (inFlight !== undefined) await inFlight;
        else await startDrain();
        if (disposed || stoppedByConflict) return;
      }
    },
    async cancel() {
      if (disposed) return;
      clearTimer();
      hasPendingContent = false;
      pendingContent = undefined;
      if (inFlight !== undefined) await inFlight;
      if (!disposed && !stoppedByConflict)
        setState(hasSavedContent ? "saved" : "idle");
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      clearTimer();
      hasPendingContent = false;
      pendingContent = undefined;
      setState("disposed");
    },
    state: () => currentState,
  };
}

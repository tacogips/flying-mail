import { afterEach, describe, expect, it, vi } from "vitest";
import { createDraftSaver, type DraftSaveOutcome } from "./draft-autosave";

const saved: DraftSaveOutcome = { kind: "saved" };

describe("createDraftSaver", () => {
  afterEach(() => vi.useRealTimers());

  it("debounces changes and saves only the latest content", async () => {
    vi.useFakeTimers();
    const save = vi.fn(async (_value: string) => saved);
    const saver = createDraftSaver({
      save,
      isSame: Object.is,
      debounceMs: 2_000,
    });
    saver.notifyChange("one");
    await vi.advanceTimersByTimeAsync(1_000);
    saver.notifyChange("two");
    saver.notifyChange("three");
    await vi.advanceTimersByTimeAsync(1_999);
    expect(save).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await saver.flush();
    expect(save).toHaveBeenCalledTimes(1);
    expect(save).toHaveBeenCalledWith("three");
  });

  it("serializes an in-flight save and keeps only the latest queued change", async () => {
    vi.useFakeTimers();
    let resolveFirst: ((result: DraftSaveOutcome) => void) | undefined;
    const save = vi.fn((value: string) =>
      value === "first"
        ? new Promise<DraftSaveOutcome>((resolve) => {
            resolveFirst = resolve;
          })
        : Promise.resolve(saved),
    );
    const saver = createDraftSaver({ save, isSame: Object.is, debounceMs: 10 });
    saver.notifyChange("first");
    await vi.advanceTimersByTimeAsync(10);
    saver.notifyChange("middle");
    await vi.advanceTimersByTimeAsync(10);
    saver.notifyChange("latest");
    resolveFirst?.(saved);
    await vi.advanceTimersByTimeAsync(0);
    await saver.flush();
    expect(save.mock.calls.map(([value]) => value)).toEqual([
      "first",
      "latest",
    ]);
  });

  it("skips a snapshot equal to the last successful save", async () => {
    vi.useFakeTimers();
    const save = vi.fn(async () => saved);
    const saver = createDraftSaver({ save, isSame: Object.is, debounceMs: 1 });
    saver.notifyChange("same");
    await saver.flush();
    saver.notifyChange("same");
    await vi.advanceTimersByTimeAsync(2);
    expect(save).toHaveBeenCalledTimes(1);
  });

  it("saves a revert to the last snapshot after an in-flight change completes", async () => {
    vi.useFakeTimers();
    let resolveSecond: ((result: DraftSaveOutcome) => void) | undefined;
    const save = vi.fn((value: string) =>
      value === "second"
        ? new Promise<DraftSaveOutcome>((resolve) => {
            resolveSecond = resolve;
          })
        : Promise.resolve(saved),
    );
    const saver = createDraftSaver({ save, isSame: Object.is, debounceMs: 10 });

    saver.notifyChange("first");
    await saver.flush();
    saver.notifyChange("second");
    await vi.advanceTimersByTimeAsync(10);
    saver.notifyChange("first");
    await vi.advanceTimersByTimeAsync(10);
    resolveSecond?.(saved);
    await vi.advanceTimersByTimeAsync(0);
    await saver.flush();

    expect(save.mock.calls.map(([value]) => value)).toEqual([
      "first",
      "second",
      "first",
    ]);
  });

  it("flushes immediately and cancel never starts a queued save", async () => {
    vi.useFakeTimers();
    const save = vi.fn(async (_value: string) => saved);
    const saver = createDraftSaver({
      save,
      isSame: Object.is,
      debounceMs: 10_000,
    });
    saver.notifyChange("flush");
    await saver.flush();
    saver.notifyChange("cancel");
    await saver.cancel();
    expect(save.mock.calls.map(([value]) => value)).toEqual(["flush"]);
  });

  it("stops after conflict and ignores late results after disposal", async () => {
    vi.useFakeTimers();
    const conflictSaver = createDraftSaver({
      save: async () => ({ kind: "conflict" as const }),
      isSame: Object.is,
      debounceMs: 1,
    });
    conflictSaver.notifyChange("conflict");
    await conflictSaver.flush();
    conflictSaver.notifyChange("later");
    await vi.advanceTimersByTimeAsync(2);
    expect(conflictSaver.state()).toBe("conflict");

    let resolveSave: ((result: DraftSaveOutcome) => void) | undefined;
    const saver = createDraftSaver({
      save: () =>
        new Promise((resolve) => {
          resolveSave = resolve;
        }),
      isSame: Object.is,
      debounceMs: 1,
    });
    saver.notifyChange("pending");
    await vi.advanceTimersByTimeAsync(1);
    saver.dispose();
    resolveSave?.(saved);
    await Promise.resolve();
    expect(saver.state()).toBe("disposed");
  });
});

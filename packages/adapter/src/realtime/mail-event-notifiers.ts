import type { MailEventNotifier } from "@flying-mail/application/ports/mail-event-notifier";

export const MAIL_EVENT_HUB_NAME = "mail-events";
export const MAIL_EVENT_HUB_NOTIFY_URL =
  "https://mail-event-hub.internal/notify";

export interface DurableObjectNamespaceLike {
  idFromName(name: string): unknown;
  get(id: unknown): {
    fetch(input: string, init?: RequestInit): Promise<Response>;
  };
}

export function createNoopMailEventNotifier(): MailEventNotifier {
  return { notify() {} };
}

export function createDurableObjectMailEventNotifier(
  namespace: DurableObjectNamespaceLike,
): MailEventNotifier & { settle(): Promise<void> } {
  let inFlight: Promise<void> | null = null;
  let queued = false;
  const stub = namespace.get(namespace.idFromName(MAIL_EVENT_HUB_NAME));

  const drain = (): Promise<void> => {
    if (inFlight !== null) {
      return inFlight;
    }
    inFlight = (async () => {
      do {
        queued = false;
        try {
          const response = await stub.fetch(MAIL_EVENT_HUB_NOTIFY_URL, {
            method: "POST",
          });
          if (!response.ok) {
            console.error("Mail event notify failed", {
              status: response.status,
            });
          }
        } catch {
          console.error("Mail event notify failed", { status: 0 });
        }
      } while (queued);
    })().finally(() => {
      inFlight = null;
      if (queued) {
        void drain();
      }
    });
    return inFlight;
  };

  return {
    notify() {
      queued = true;
      void drain();
    },
    async settle() {
      while (inFlight !== null || queued) {
        if (inFlight !== null) {
          await inFlight;
        } else if (queued) {
          await drain();
        }
      }
    },
  };
}

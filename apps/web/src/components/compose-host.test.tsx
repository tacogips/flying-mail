import { render } from "solid-js/web";
import { createSignal } from "solid-js";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { ComposeRequest } from "../lib/compose-types";
import type { AppStore } from "../store/app-store";
import { StoreProvider } from "../store/store-context";
import { ComposeHost } from "./compose-host";

describe("ComposeHost", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  test("ignores a request to reopen the draft already open", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            data: {
              message: {
                id: "draft-1",
                from: { address: "me@example.com", name: null, kind: "TO" },
                replyTo: null,
                recipients: [],
                subject: "Current draft",
                htmlBody: null,
                textBody: "Current content",
                inReplyTo: null,
                forwardedFromMessageId: null,
                attachments: [],
              },
            },
          }),
          { headers: { "content-type": "application/json" } },
        ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const store = {
      viewer: () => null,
      domains: () => [],
      mailLimits: () => null,
    } as unknown as AppStore;
    const [request, setRequest] = createSignal<ComposeRequest | null>({
      kind: "DRAFT",
      messageId: "draft-1",
    });
    const container = document.createElement("div");
    document.body.append(container);
    const dispose = render(
      () => (
        <StoreProvider store={store}>
          <ComposeHost
            request={request()}
            scope={{}}
            onClose={() => undefined}
            onMailboxChanged={() => undefined}
          />
        </StoreProvider>
      ),
      container,
    );

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(
      container.querySelector<HTMLInputElement>("#compose-subject")?.value,
    ).toBe("Current draft");
    setRequest({ kind: "DRAFT", messageId: "draft-1" });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(
      container.querySelector<HTMLInputElement>("#compose-subject")?.value,
    ).toBe("Current draft");
    dispose();
    container.remove();
  });
});

import { render } from "solid-js/web";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { MailDomainView } from "../../api/schema-types";
import { activeToasts, clearToasts } from "../../lib/toast";
import type { AppStore } from "../../store/app-store";
import { StoreProvider } from "../../store/store-context";
import DomainsPage from "./domains-page";

const pendingDomain: MailDomainView = {
  id: "domain-1",
  name: "example.test",
  status: "PENDING",
  inboundMx: "NOT_CLOUDFLARE",
  catchAll: true,
  verificationToken: "owner-token",
  verifiedAt: null,
  messageCount: 0,
  dnsRecords: [
    {
      type: "TXT",
      name: "_mailcal.example.test",
      value: "flying-mail-verification=owner-token",
      priority: null,
      purpose: "Domain ownership verification",
    },
    {
      type: "TXT",
      name: "example.test",
      value: "v=spf1 include:_spf.mx.cloudflare.net ~all",
      priority: null,
      purpose: "Authorizes Cloudflare to send mail for this domain",
    },
  ],
};

describe("domain settings readiness", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    clearToasts();
  });

  test("shows ownership TXT, inbound MX status, and exposes the Verify server error", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url !== "/graphql") {
        return new Response(JSON.stringify({ data: { mailAddresses: [] } }), {
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(
        JSON.stringify({
          errors: [
            {
              message: "MX records for example.test do not point to Cloudflare",
              extensions: { code: "CONFLICT" },
            },
          ],
        }),
        { headers: { "content-type": "application/json" } },
      );
    });
    vi.stubGlobal("fetch", fetchMock);
    const store = {
      domains: () => [pendingDomain],
      loadReferenceData: async () => undefined,
      loadAdminDomains: async () => undefined,
    } as unknown as AppStore;
    const container = document.createElement("div");
    document.body.append(container);
    const dispose = render(
      () => (
        <StoreProvider store={store}>
          <DomainsPage />
        </StoreProvider>
      ),
      container,
    );

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(container.textContent).toContain("_mailcal.example.test");
    expect(container.textContent).toContain(
      "flying-mail-verification=owner-token",
    );
    expect(container.textContent).not.toContain("v=spf1");
    expect(container.textContent).toContain("MX not on Cloudflare");
    const verifyButton = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent?.includes("verify"),
    );
    verifyButton?.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(activeToasts().map((toast) => toast.message)).toContain(
      "MX records for example.test do not point to Cloudflare",
    );

    dispose();
    container.remove();
  });
});

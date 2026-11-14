import type { OutboundMail } from "@mailcal/application/ports/mail-sender";
import { describe, expect, test } from "vitest";
import { MailDeliveryError } from "./cloudflare-email";
import {
  createCloudflareEmailApiSender,
  MAX_MESSAGE_BYTES,
} from "./cloudflare-email-api";

interface Captured {
  readonly url: string;
  readonly authorization: string | null;
  readonly body: Record<string, unknown>;
}

function recordingFetch(options?: { status?: number; throwOn?: boolean }): {
  readonly calls: Captured[];
  readonly fetch: typeof fetch;
} {
  const calls: Captured[] = [];
  const fake = (async (url: string | URL, init?: RequestInit) => {
    if (options?.throwOn === true) {
      throw new Error("network down");
    }
    const headers = new Headers(init?.headers);
    calls.push({
      url: String(url),
      authorization: headers.get("authorization"),
      body: JSON.parse(String(init?.body)) as Record<string, unknown>,
    });
    const status = options?.status ?? 200;
    return new Response(status === 200 ? "{}" : "provider said no", { status });
  }) as unknown as typeof fetch;
  return { calls, fetch: fake };
}

function sender(overrides: Parameters<typeof recordingFetch>[0] = {}) {
  const { calls, fetch: fakeFetch } = recordingFetch(overrides);
  return {
    calls,
    send: createCloudflareEmailApiSender({
      accountId: "acc-1",
      apiToken: "tok-secret",
      fetch: fakeFetch,
    }).send,
  };
}

const mail: OutboundMail = {
  from: "support@example.com",
  to: ["a@other.com"],
  subject: "Hello",
  text: "Body",
};

describe("createCloudflareEmailApiSender", () => {
  test("posts to the account's send endpoint with the bearer token", async () => {
    const { calls, send } = sender();
    await send(mail);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(
      "https://api.cloudflare.com/client/v4/accounts/acc-1/email/sending/send",
    );
    expect(calls[0]?.authorization).toBe("Bearer tok-secret");
  });

  test("sends as the message's own from, to an arbitrary recipient", async () => {
    // The whole reason this adapter exists: the send_email binding only
    // reaches addresses pre-verified as destinations on the account.
    const { calls, send } = sender();
    await send({
      ...mail,
      from: "billing@other.test",
      to: ["stranger@nowhere.example"],
    });
    expect(calls[0]?.body).toMatchObject({
      from: "billing@other.test",
      to: "stranger@nowhere.example",
      subject: "Hello",
      text: "Body",
    });
  });

  test("keeps To and Cc in one request", async () => {
    const { calls, send } = sender();
    await send({
      ...mail,
      to: ["a@other.com", "b@other.com"],
      cc: ["c@other.com"],
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.body).toMatchObject({
      to: ["a@other.com", "b@other.com"],
      cc: ["c@other.com"],
    });
  });

  test("gives each Bcc recipient its own request, and never names it", async () => {
    const { calls, send } = sender();
    await send({ ...mail, bcc: ["hidden1@other.com", "hidden2@other.com"] });
    expect(calls).toHaveLength(3);
    // A blind recipient must not appear in anyone else's copy, and the
    // other blind recipients must not appear in its own.
    const serialized = calls.map((call) => JSON.stringify(call.body));
    expect(serialized[0]).not.toContain("hidden1@other.com");
    expect(serialized[0]).not.toContain("hidden2@other.com");
    expect(serialized[1]).toContain("hidden1@other.com");
    expect(serialized[1]).not.toContain("hidden2@other.com");
    expect(serialized[2]).toContain("hidden2@other.com");
    expect(serialized[2]).not.toContain("hidden1@other.com");
  });

  test("omits the To/Cc request when the message is Bcc-only", async () => {
    const { calls, send } = sender();
    await send({ ...mail, to: [], bcc: ["hidden@other.com"] });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.body).toMatchObject({ to: "hidden@other.com" });
  });

  test("base64-encodes attachments with their disposition", async () => {
    const { calls, send } = sender();
    await send({
      ...mail,
      attachments: [
        {
          fileName: "note.txt",
          contentType: "text/plain",
          content: new TextEncoder().encode("hello"),
          inline: false,
        },
        {
          fileName: "logo.png",
          contentType: "image/png",
          content: new Uint8Array([1, 2, 3]),
          inline: true,
        },
      ],
    });
    expect(calls[0]?.body["attachments"]).toEqual([
      {
        content: btoa("hello"),
        filename: "note.txt",
        type: "text/plain",
        disposition: "attachment",
      },
      {
        // Base64 of the three raw bytes the fixture carries.
        content: "AQID",
        filename: "logo.png",
        type: "image/png",
        disposition: "inline",
      },
    ]);
  });

  test("encodes a large attachment without overflowing the stack", async () => {
    const { calls, send } = sender();
    const big = new Uint8Array(200_000).fill(65);
    await send({
      ...mail,
      attachments: [
        {
          fileName: "big.bin",
          contentType: "application/octet-stream",
          content: big,
          inline: false,
        },
      ],
    });
    const sent = calls[0]?.body["attachments"] as
      | readonly { content: string }[]
      | undefined;
    expect(atob(sent?.[0]?.content ?? "")).toHaveLength(200_000);
  });

  test("refuses a message over the provider's size cap before requesting", async () => {
    const { calls, send } = sender();
    await expect(
      send({
        ...mail,
        attachments: [
          {
            fileName: "huge.bin",
            contentType: "application/octet-stream",
            content: new Uint8Array(MAX_MESSAGE_BYTES).fill(65),
            inline: false,
          },
        ],
      }),
    ).rejects.toBeInstanceOf(MailDeliveryError);
    expect(calls).toEqual([]);
  });

  test("passes custom headers through", async () => {
    const { calls, send } = sender();
    await send({ ...mail, headers: new Map([["X-Campaign-Id", "abc"]]) });
    expect(calls[0]?.body["headers"]).toEqual({ "X-Campaign-Id": "abc" });
  });

  test("masks a provider rejection, leaking no recipient or subject", async () => {
    const { send } = sender({ status: 422 });
    await expect(send(mail)).rejects.toBeInstanceOf(MailDeliveryError);
    try {
      await send(mail);
    } catch (error) {
      const message = (error as Error).message;
      expect(message).toBe("Email delivery is unavailable");
      expect(message).not.toContain("a@other.com");
      expect(message).not.toContain("Hello");
    }
  });

  test("masks a transport failure", async () => {
    const { send } = sender({ throwOn: true });
    await expect(send(mail)).rejects.toBeInstanceOf(MailDeliveryError);
  });
});

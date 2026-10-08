import { createFakeDependencies } from "@flying-mail/application/test-support/fakes";
import { adminViewer } from "@flying-mail/application/test-support/viewer-fixtures";
import { beforeEach, describe, expect, test } from "vitest";
import {
  createGraphQLHarness,
  errorCodes,
  type GraphQLHarness,
} from "./graphql-test-support";

let harness: GraphQLHarness;

beforeEach(() => {
  harness = createGraphQLHarness(createFakeDependencies());
});

describe("mail event GraphQL surface", () => {
  test("rejects subscriptions through the HTTP transport", async () => {
    const result = await harness.run(
      "subscription { mailEvents { cursor } }",
      null,
    );

    expect(result.errors).toHaveLength(1);
    expect(result.data === undefined || result.data === null).toBe(true);
    expect(errorCodes(result)).toEqual(["BAD_USER_INPUT"]);
    expect(result.errors?.[0]?.message).toContain(
      "Subscriptions are served only over WebSocket",
    );
  });

  test("exposes scope and after on Subscription.mailEvents", async () => {
    const result = await harness.run(
      `query {
        __type(name: "Subscription") {
          fields {
            name
            args { name }
          }
        }
      }`,
      null,
    );

    expect(result.errors).toBeUndefined();
    expect(result.data?.["__type"]).toMatchObject({
      fields: [
        { name: "mailEvents", args: [{ name: "scope" }, { name: "after" }] },
      ],
    });
  });

  test("keeps the existing messages query available", async () => {
    const result = await harness.run(
      "query { messages { nodes { id } } }",
      adminViewer(),
    );

    expect(result.errors).toBeUndefined();
    expect(result.data?.["messages"]).toEqual({ nodes: [] });
  });
});

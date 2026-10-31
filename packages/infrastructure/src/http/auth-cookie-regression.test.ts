import { createFakeDependencies } from "@flying-mail/application/test-support/fakes";
import { createUseCases } from "@flying-mail/application/usecases";
import { describe, expect, test } from "vitest";
import { createApp } from "./app";
import { SESSION_COOKIE_NAME } from "./auth-middleware";

describe("malformed session cookies", () => {
  test.each(["%", "%ZZ", "%C3%28"])(
    "treats invalid encoding %s as unauthenticated without breaking public routes",
    async (value) => {
      const { deps } = createFakeDependencies();
      const app = createApp({
        deps,
        usecases: createUseCases(deps),
        graphiql: false,
      });
      const response = await app.request("/graphql", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          cookie: `${SESSION_COOKIE_NAME}=${value}`,
        },
        body: JSON.stringify({ query: "{ viewer { capabilities } }" }),
      });
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({
        data: { viewer: null },
      });
    },
  );
});

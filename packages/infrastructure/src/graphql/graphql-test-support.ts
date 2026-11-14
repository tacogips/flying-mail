import type { AppDependencies } from "@mailcal/application/dependencies";
import type { Viewer } from "@mailcal/application/policies";
import type { FakeDependencies } from "@mailcal/application/test-support/fakes";
import { createUseCases, type UseCases } from "@mailcal/application/usecases";
import { buildGraphQLContext } from "./context";
import { buildGraphQLSchema, createGraphQLYoga } from "./schema";

/** Shared end-to-end GraphQL test harness, split out of `schema.test.ts` so
 * other transport test files (e.g. the admin user-management suite) can
 * exercise real requests without duplicating the yoga/schema setup or
 * rebuilding the executable schema per file. */

// Executed through yoga's `fetch` rather than graphql-js's `graphql()`:
// `createSchema` builds the schema with the copy of `graphql` that
// `@graphql-tools` resolves, which is not necessarily the one a direct
// import here would get -- and graphql-js rejects a schema from "another
// module or realm". Going through yoga also exercises the real request
// path, including error masking and the depth/selection limit plugins.
const yoga = createGraphQLYoga(buildGraphQLSchema(), { graphiql: false });

export interface ExecutionResult {
  readonly data?: Record<string, unknown> | null;
  readonly errors?: readonly {
    readonly message: string;
    readonly extensions?: Record<string, unknown>;
  }[];
}

export interface GraphQLHarness {
  readonly fake: FakeDependencies;
  readonly deps: AppDependencies;
  readonly usecases: UseCases;
  readonly run: (
    source: string,
    viewer: Viewer | null,
    variables?: Record<string, unknown>,
  ) => Promise<ExecutionResult>;
}

export function errorCodes(result: ExecutionResult): readonly unknown[] {
  return (result.errors ?? []).map((error) => error.extensions?.["code"]);
}

async function execute(
  deps: AppDependencies,
  usecases: UseCases,
  source: string,
  viewer: Viewer | null,
  variables?: Record<string, unknown>,
): Promise<ExecutionResult> {
  const context = buildGraphQLContext({
    viewer,
    token: null,
    deps,
    usecases,
  });
  const response = await yoga.fetch(
    new Request("https://mail.example.com/graphql", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(
        variables === undefined
          ? { query: source }
          : { query: source, variables },
      ),
    }),
    context as unknown as Record<string, unknown>,
  );
  return (await response.json()) as ExecutionResult;
}

/** Wraps an already-built `FakeDependencies` into a runnable harness. The
 * caller owns any additional seeding (domains, messages, etc.) before or
 * after wrapping. */
export function createGraphQLHarness(fake: FakeDependencies): GraphQLHarness {
  const usecases = createUseCases(fake.deps);
  return {
    fake,
    deps: fake.deps,
    usecases,
    run: (source, viewer, variables) =>
      execute(fake.deps, usecases, source, viewer, variables),
  };
}

import type { AppDependencies } from "@flying-mail/application/dependencies";
import type { Capability } from "@flying-mail/domain/entities/api-key";
import type { UseCases } from "@flying-mail/application/usecases";
import type { Viewer } from "@flying-mail/application/policies";
import {
  parseArguments,
  toJsonSchema,
  type FieldSpecMap,
  type InferArgs,
  type JsonSchemaObject,
} from "./tool-schema";

export type McpViewer = Extract<Viewer, { readonly kind: "API_KEY" }>;
export interface McpToolContext {
  readonly viewer: McpViewer;
  readonly usecases: UseCases;
  readonly deps: AppDependencies;
}
export interface McpToolAnnotations {
  readonly readOnlyHint: boolean;
  readonly destructiveHint: boolean;
  readonly idempotentHint: boolean;
  readonly openWorldHint: boolean;
}
export interface McpToolOutcome {
  readonly summary: string;
  readonly structured: Readonly<Record<string, unknown>>;
  readonly containsUntrusted: boolean;
}
export interface McpToolDefinition {
  readonly name: string;
  readonly title: string;
  readonly description: string;
  readonly visibleWith: readonly Capability[];
  readonly annotations: McpToolAnnotations;
  readonly inputSchema: JsonSchemaObject;
  readonly run: (
    rawArgs: unknown,
    ctx: McpToolContext,
  ) => Promise<McpToolOutcome>;
}

export function defineTool<S extends FieldSpecMap>(definition: {
  readonly name: string;
  readonly title: string;
  readonly description: string;
  readonly visibleWith: readonly Capability[];
  readonly annotations: McpToolAnnotations;
  readonly input: S;
  readonly execute: (
    args: InferArgs<S>,
    ctx: McpToolContext,
  ) => Promise<McpToolOutcome>;
}): McpToolDefinition {
  return {
    name: definition.name,
    title: definition.title,
    description: definition.description,
    visibleWith: definition.visibleWith,
    annotations: definition.annotations,
    inputSchema: toJsonSchema(definition.input),
    run: async (rawArgs, ctx) =>
      definition.execute(parseArguments(definition.input, rawArgs), ctx),
  };
}

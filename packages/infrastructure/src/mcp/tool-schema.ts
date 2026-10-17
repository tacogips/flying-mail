import { BadUserInputError } from "@flying-mail/application/errors";

type IdFormat = "id" | "email" | "date-time";
export type FieldSpec =
  | {
      readonly kind: "string";
      readonly description: string;
      readonly required?: true;
      readonly minLength?: number;
      readonly maxLength: number;
      readonly enum?: readonly string[];
      readonly format?: IdFormat;
    }
  | {
      readonly kind: "integer";
      readonly description: string;
      readonly required?: true;
      readonly minimum: number;
      readonly maximum: number;
      readonly default?: number;
    }
  | {
      readonly kind: "boolean";
      readonly description: string;
      readonly required?: true;
      readonly default?: boolean;
    }
  | {
      readonly kind: "string_array";
      readonly description: string;
      readonly required?: true;
      readonly maxItems: number;
      readonly itemMaxLength: number;
      readonly itemFormat?: IdFormat;
    };
export type FieldSpecMap = Readonly<Record<string, FieldSpec>>;

type SpecValue<F extends FieldSpec> = F extends { readonly kind: "string" }
  ? F extends { readonly enum: readonly (infer E extends string)[] }
    ? E
    : string
  : F extends { readonly kind: "integer" }
    ? number
    : F extends { readonly kind: "boolean" }
      ? boolean
      : string[];
type IsRequired<F extends FieldSpec> = F extends { readonly required: true }
  ? true
  : F extends { readonly default: unknown }
    ? true
    : false;
export type InferArgs<S extends FieldSpecMap> = {
  readonly [K in keyof S as IsRequired<S[K]> extends true
    ? K
    : never]: SpecValue<S[K]>;
} & {
  readonly [K in keyof S as IsRequired<S[K]> extends true ? never : K]?:
    | SpecValue<S[K]>
    | undefined;
};

export interface JsonSchemaObject {
  readonly type: "object";
  readonly properties: Readonly<
    Record<string, Readonly<Record<string, unknown>>>
  >;
  readonly required: readonly string[];
  readonly additionalProperties: false;
}

function formatSchema(
  format: IdFormat | undefined,
): Readonly<Record<string, unknown>> {
  if (format === "id") {
    return { pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$" };
  }
  return format === undefined ? {} : { format };
}

export function toJsonSchema(spec: FieldSpecMap): JsonSchemaObject {
  const properties: Record<string, Readonly<Record<string, unknown>>> = {};
  const required: string[] = [];
  for (const [name, field] of Object.entries(spec)) {
    const common = { description: field.description };
    if (field.required === true) required.push(name);
    switch (field.kind) {
      case "string":
        properties[name] = {
          ...common,
          type: "string",
          maxLength: field.maxLength,
          ...(field.minLength === undefined
            ? {}
            : { minLength: field.minLength }),
          ...(field.enum === undefined ? {} : { enum: field.enum }),
          ...formatSchema(field.format),
        };
        break;
      case "integer":
        properties[name] = {
          ...common,
          type: "integer",
          minimum: field.minimum,
          maximum: field.maximum,
          ...(field.default === undefined ? {} : { default: field.default }),
        };
        break;
      case "boolean":
        properties[name] = {
          ...common,
          type: "boolean",
          ...(field.default === undefined ? {} : { default: field.default }),
        };
        break;
      case "string_array":
        properties[name] = {
          ...common,
          type: "array",
          maxItems: field.maxItems,
          items: {
            type: "string",
            maxLength: field.itemMaxLength,
            ...formatSchema(field.itemFormat),
          },
        };
        break;
    }
  }
  return { type: "object", properties, required, additionalProperties: false };
}

function invalid(message: string, field: string): never {
  throw new BadUserInputError(message, field);
}

function matchesFormat(value: string, format: IdFormat | undefined): boolean {
  switch (format) {
    case "id":
      return /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value);
    case "email":
      return (
        value.length <= 320 &&
        !/\s/.test(value) &&
        (value.match(/@/g)?.length ?? 0) === 1
      );
    case "date-time":
      return (
        /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/i.test(
          value,
        ) && Number.isFinite(Date.parse(value))
      );
    default:
      return true;
  }
}

export function parseArguments<S extends FieldSpecMap>(
  spec: S,
  raw: unknown,
): InferArgs<S> {
  const input = raw === undefined || raw === null ? {} : raw;
  if (typeof input !== "object" || Array.isArray(input)) {
    return invalid("Arguments must be an object", "arguments");
  }
  const record = input as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!Object.hasOwn(spec, key)) invalid(`Unknown argument: ${key}`, key);
  }
  const parsed: Record<string, unknown> = {};
  for (const [name, field] of Object.entries(spec)) {
    const value = record[name];
    if (value === undefined) {
      if (field.required === true) invalid(`${name} is required`, name);
      if ("default" in field && field.default !== undefined)
        parsed[name] = field.default;
      continue;
    }
    switch (field.kind) {
      case "string":
        if (
          typeof value !== "string" ||
          value.length > field.maxLength ||
          (field.minLength !== undefined && value.length < field.minLength) ||
          (field.enum !== undefined && !field.enum.includes(value)) ||
          !matchesFormat(value, field.format)
        )
          invalid(`${name} is invalid`, name);
        break;
      case "integer":
        if (
          typeof value !== "number" ||
          !Number.isInteger(value) ||
          value < field.minimum ||
          value > field.maximum
        ) {
          invalid(
            `${name} must be an integer between ${field.minimum} and ${field.maximum}`,
            name,
          );
        }
        break;
      case "boolean":
        if (typeof value !== "boolean")
          invalid(`${name} must be a boolean`, name);
        break;
      case "string_array":
        if (!Array.isArray(value) || value.length > field.maxItems)
          invalid(`${name} must be an array`, name);
        for (const item of value) {
          if (
            typeof item !== "string" ||
            item.length > field.itemMaxLength ||
            !matchesFormat(item, field.itemFormat)
          ) {
            invalid(`${name} contains an invalid value`, name);
          }
        }
        break;
    }
    parsed[name] = value;
  }
  return parsed as InferArgs<S>;
}

import { TemplateSyntaxError } from "@mailcal/application/ports/template-renderer";
import { describe, expect, test } from "vitest";
import { createEtaTemplateRenderer } from "./eta-renderer";

const renderer = createEtaTemplateRenderer();

function render(
  source: string,
  data: Record<string, unknown> = {},
  mode: "html" | "none" = "none",
): string {
  return renderer.render(
    source,
    data as Record<string, string | number | boolean>,
    { escape: mode },
    "subject",
  );
}

describe("literal text", () => {
  test("passes a tagless source through unchanged", () => {
    expect(render("Hello there")).toBe("Hello there");
  });

  test("restores backslashes, quotes and newlines Eta escapes for codegen", () => {
    const source = "100% off\nC:\\path 'quoted' \"double\"";
    expect(render(source)).toBe(source);
  });

  test("keeps a literal backslash-n distinct from a newline", () => {
    expect(render(String.raw`a\nb`)).toBe(String.raw`a\nb`);
    expect(render("a\nb")).toBe("a\nb");
  });
});

describe("interpolation", () => {
  test("reads a declared variable", () => {
    expect(render("Hi <%= it.name %>!", { name: "Ada" })).toBe("Hi Ada!");
  });

  test("renders numbers and booleans", () => {
    expect(render("<%= it.n %>/<%= it.b %>", { n: 7, b: false })).toBe(
      "7/false",
    );
  });

  test("renders an absent key as an empty string, not undefined", () => {
    expect(render("[<%= it.missing %>]")).toBe("[]");
  });

  test("supports a bracket key and a nested path", () => {
    expect(render('<%= it["name"] %>', { name: "Ada" })).toBe("Ada");
    expect(render("<%= it.a.b %>", { a: { b: "deep" } })).toBe("deep");
  });

  test("falls back with || and ??", () => {
    expect(render('<%= it.name || "there" %>')).toBe("there");
    expect(render('<%= it.name || "there" %>', { name: "Ada" })).toBe("Ada");
    // ?? keeps a falsy-but-present value, unlike ||.
    expect(render('<%= it.count ?? "none" %>', { count: 0 })).toBe("0");
    expect(render('<%= it.count || "none" %>', { count: 0 })).toBe("none");
  });

  test("chains several fallbacks left to right", () => {
    expect(render('<%= it.a || it.b || "z" %>', { b: "B" })).toBe("B");
  });
});

describe("escaping", () => {
  const data = { name: '<b>"Ada" & co</b>' };

  test("escapes <%= %> in html mode", () => {
    expect(render("<%= it.name %>", data, "html")).toBe(
      "&lt;b&gt;&quot;Ada&quot; &amp; co&lt;/b&gt;",
    );
  });

  test("never escapes <%~ %>, even in html mode", () => {
    expect(render("<%~ it.name %>", data, "html")).toBe(data.name);
  });

  test("leaves text bodies and subjects verbatim", () => {
    expect(render("<%= it.name %>", data, "none")).toBe(data.name);
  });
});

describe("rejected constructs", () => {
  function expectRejected(source: string, matcher: RegExp): void {
    expect(() => render(source)).toThrow(TemplateSyntaxError);
    expect(() => render(source)).toThrow(matcher);
  }

  test("rejects an execution tag", () => {
    expectRejected("<% if (it.a) { %>x<% } %>", /may only interpolate values/);
  });

  test("rejects a function call", () => {
    expectRejected("<%= it.name.trim() %>", /no meaning|not supported/);
  });

  test("rejects a bare identifier that is not it", () => {
    expectRejected("<%= process %>", /only "it" may be read/);
  });

  test("rejects arithmetic and other operators", () => {
    expectRejected("<%= it.a + it.b %>", /no meaning|supported operators/);
  });

  test("rejects an unclosed tag", () => {
    expectRejected("<%= it.a", /syntax error/);
  });

  test("names the field the bad source came from", () => {
    try {
      renderer.referencedVariables("<% x %>", "textBody");
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(TemplateSyntaxError);
      expect((error as TemplateSyntaxError).field).toBe("textBody");
    }
  });
});

describe("prototype safety", () => {
  test("cannot reach a prototype property", () => {
    expect(render("[<%= it.constructor %>]", { name: "Ada" })).toBe("[]");
    expect(render("[<%= it.__proto__ %>]", { name: "Ada" })).toBe("[]");
  });

  test("cannot reach a string's own members", () => {
    expect(render("[<%= it.name.length %>]", { name: "Ada" })).toBe("[]");
  });
});

describe("referencedVariables", () => {
  test("collects each top-level key once, in order", () => {
    expect(
      renderer.referencedVariables(
        "<%= it.a %> <%= it.b.c %> <%= it.a %>",
        "textBody",
      ),
    ).toEqual(["a", "b"]);
  });

  test("collects keys from both sides of a fallback", () => {
    expect(
      renderer.referencedVariables('<%= it.a || it.b || "x" %>', "subject"),
    ).toEqual(["a", "b"]);
  });

  test("returns nothing for a source with no tags", () => {
    expect(renderer.referencedVariables("plain text", "subject")).toEqual([]);
  });
});

describe("no dynamic code generation", () => {
  test("renders with Function and eval disabled", () => {
    // The Worker runtime forbids both. Proving the renderer never reaches
    // for them is the point of parsing rather than compiling.
    const globals = globalThis as unknown as Record<string, unknown>;
    const originalFunction = globals["Function"];
    const originalEval = globals["eval"];
    const boom = () => {
      throw new Error("dynamic code generation is not allowed");
    };
    globals["Function"] = boom;
    globals["eval"] = boom;
    try {
      expect(render("Hi <%= it.name %>", { name: "Ada" })).toBe("Hi Ada");
    } finally {
      globals["Function"] = originalFunction;
      globals["eval"] = originalEval;
    }
  });
});

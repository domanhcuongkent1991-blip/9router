import { describe, expect, it } from "vitest";

import { cleanJSONSchemaForAntigravity } from "../../open-sse/translator/formats/gemini.js";

describe("Antigravity schema cleanup", () => {
  it("wraps shorthand property type strings as JSON Schema nodes", () => {
    const schema = {
      type: "object",
      properties: {
        type: "object",
        name: { type: "string" },
      },
    };

    expect(cleanJSONSchemaForAntigravity(schema).properties.type).toMatchObject({ type: "object" });
  });

  it("maps shorthand null properties to a supported permissive schema", () => {
    const schema = {
      type: "object",
      properties: {
        empty: "null",
      },
    };

    expect(cleanJSONSchemaForAntigravity(schema).properties.empty).toMatchObject({ type: "string" });
  });
});

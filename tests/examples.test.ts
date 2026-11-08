import { describe, expect, it } from "vitest";
import { configuredGateway } from "../examples/shared/model.js";
import { experiences } from "../examples/experiences/config.js";
import { charts } from "../examples/charts/config.js";

const local = {
  WEB_BUILDER_MODEL: "synthetic-test-only",
  WEB_BUILDER_BASE_URL: "http://127.0.0.1:1/v1",
  WEB_BUILDER_API: "openai-completions",
  WEB_BUILDER_AUTH: "local",
};
describe("example-only operator configuration (no network)", () => {
  it("refuses unconfigured startup and ignores ambient provider variable names", () => {
    expect(() => configuredGateway({})).toThrow(
      "No model is selected by default",
    );
    expect(() =>
      configuredGateway({
        OPENAI_API_KEY: "synthetic-not-a-key",
        OPENAI_BASE_URL: local.WEB_BUILDER_BASE_URL,
      }),
    ).toThrow("No model is selected by default");
  });
  it("requires an explicit key in API-key mode", () => {
    expect(() =>
      configuredGateway({ ...local, WEB_BUILDER_AUTH: "apiKey" }),
    ).toThrow("explicit API key");
  });
  it("rejects unsafe endpoint forms and nonliteral keyless hosts before dispatch", () => {
    for (const endpoint of [
      "not a url",
      "file:///tmp/no-model",
      "http://localhost:1/v1",
      "https://127.0.0.1/v1?key=no",
      "https://user:password@127.0.0.1/v1",
      "https://example.invalid/v1",
    ]) {
      expect(() =>
        configuredGateway({ ...local, WEB_BUILDER_BASE_URL: endpoint }),
      ).toThrow();
    }
  });
  it("selects only the explicitly configured local model without probing it", () => {
    const gateway = configuredGateway(local);
    expect(gateway.model().id).toBe(local.WEB_BUILDER_MODEL);
    expect(gateway.model().baseUrl).toBe(local.WEB_BUILDER_BASE_URL);
    expect(() =>
      configuredGateway({ ...local, WEB_BUILDER_API: "unsupported" }),
    ).toThrow("No model is selected by default");
  });
  it("keeps distinct domain policies/data in example definitions with no package approvals", () => {
    expect(experiences.dependencies).toEqual([]);
    expect(charts.dependencies).toEqual([]);
    expect(experiences.instructions).toContain("Canvas");
    expect(charts.instructions).toContain("SVG");
    expect(JSON.parse(charts.publicContext).rows).toHaveLength(5);
    for (const example of [experiences, charts]) {
      expect(example.presentation.starters.length).toBeGreaterThan(0);
      expect(example.presentation).not.toHaveProperty("instructions");
      expect(example.presentation).not.toHaveProperty("publicContext");
    }
  });
});

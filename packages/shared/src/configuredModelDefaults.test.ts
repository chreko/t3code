import { describe, expect, it } from "vite-plus/test";

import {
  modelFromClaudeSettings,
  mergeOpenCodeConfiguredValues,
  modelFromOpenCodeConfig,
  parseClaudeConfiguredModel,
  resolveClaudeCatalogSlug,
  resolveClaudeConfiguredDefault,
} from "./configuredModelDefaults.ts";

const CATALOG = [
  "claude-fable-5",
  "claude-opus-5",
  "claude-opus-4-8",
  "claude-sonnet-5",
  "claude-sonnet-4-6",
  "claude-haiku-4-5",
] as const;

describe("modelFromClaudeSettings", () => {
  it("reads the model a settings file configures", () => {
    expect(modelFromClaudeSettings('{"model":"opus"}')).toBe("opus");
  });

  it("ignores a settings file that configures no model", () => {
    expect(modelFromClaudeSettings('{"permissions":{}}')).toBe(null);
    expect(modelFromClaudeSettings('{"model":"   "}')).toBe(null);
    expect(modelFromClaudeSettings('{"model":42}')).toBe(null);
  });

  // A hand-edited settings file is routinely malformed; a default model is not
  // worth failing a provider probe over.
  it("treats unreadable json as no configured model", () => {
    expect(modelFromClaudeSettings("{not json")).toBe(null);
    expect(modelFromClaudeSettings("")).toBe(null);
  });
});

describe("resolveClaudeCatalogSlug", () => {
  it("takes a catalog slug verbatim", () => {
    expect(resolveClaudeCatalogSlug("claude-sonnet-5", CATALOG)).toBe("claude-sonnet-5");
  });

  it("maps the family aliases Claude Code accepts", () => {
    expect(resolveClaudeCatalogSlug("opus", CATALOG)).toBe("claude-opus-5");
    expect(resolveClaudeCatalogSlug("sonnet", CATALOG)).toBe("claude-sonnet-5");
    expect(resolveClaudeCatalogSlug("haiku", CATALOG)).toBe("claude-haiku-4-5");
  });

  // Claude Code accepts dated API ids; the catalog carries undated slugs.
  it("matches a dated api id back to its catalog slug", () => {
    expect(resolveClaudeCatalogSlug("claude-opus-4-8-20260101", CATALOG)).toBe("claude-opus-4-8");
  });

  it("ignores a model the catalog does not offer, leaving the app selection alone", () => {
    expect(resolveClaudeCatalogSlug("gpt-5", CATALOG)).toBe(null);
    expect(resolveClaudeCatalogSlug("", CATALOG)).toBe(null);
  });
});

describe("modelFromOpenCodeConfig", () => {
  it("reads the provider-qualified model a config configures", () => {
    expect(modelFromOpenCodeConfig('{"model":"anthropic/claude-sonnet-4-5"}')).toBe(
      "anthropic/claude-sonnet-4-5",
    );
  });

  it("ignores a config with no model, or one that is not provider-qualified", () => {
    expect(modelFromOpenCodeConfig('{"theme":"dark"}')).toBe(null);
    expect(modelFromOpenCodeConfig('{"model":"claude-sonnet-4-5"}')).toBe(null);
    expect(modelFromOpenCodeConfig("{not json")).toBe(null);
  });
});

describe("parseClaudeConfiguredModel", () => {
  // The inverse of resolveClaudeApiModelId, which appends the same suffix.
  it("splits the context window suffix off the model", () => {
    expect(parseClaudeConfiguredModel("opus[1m]")).toEqual({
      base: "opus",
      contextWindow: "1m",
    });
  });

  it("leaves a plain model alone", () => {
    expect(parseClaudeConfiguredModel("claude-opus-5")).toEqual({
      base: "claude-opus-5",
      contextWindow: null,
    });
  });
});

describe("resolveClaudeConfiguredDefault", () => {
  const base = { catalogSlugs: CATALOG, projectSettings: null, userSettings: null };

  it("resolves the model and options a user settings file configures", () => {
    expect(
      resolveClaudeConfiguredDefault({
        ...base,
        userSettings: '{"model":"opus[1m]","effortLevel":"high"}',
      }),
    ).toEqual({
      slug: "claude-opus-5",
      options: [
        { id: "effort", value: "high" },
        { id: "contextWindow", value: "1m" },
      ],
    });
  });

  // Claude Code merges settings per key, so a project file overriding only the
  // model keeps the user file's effort.
  it("lets the project file win per key rather than wholesale", () => {
    expect(
      resolveClaudeConfiguredDefault({
        ...base,
        userSettings: '{"model":"opus","effortLevel":"high"}',
        projectSettings: '{"model":"sonnet"}',
      }),
    ).toEqual({
      slug: "claude-sonnet-5",
      options: [{ id: "effort", value: "high" }],
    });
  });

  it("reports an effort configured without a model, leaving the model alone", () => {
    expect(
      resolveClaudeConfiguredDefault({ ...base, userSettings: '{"effortLevel":"max"}' }),
    ).toEqual({ slug: null, options: [{ id: "effort", value: "max" }] });
  });

  it("configures nothing when neither file names a model or effort", () => {
    expect(resolveClaudeConfiguredDefault({ ...base, userSettings: '{"theme":"dark"}' })).toBe(
      null,
    );
    expect(resolveClaudeConfiguredDefault(base)).toBe(null);
  });
});

describe("mergeOpenCodeConfiguredValues", () => {
  it("lets a project config win over the user config", () => {
    expect(
      mergeOpenCodeConfiguredValues({
        projectConfig: '{"model":"anthropic/claude-opus-4-5"}',
        userConfig: '{"model":"openai/gpt-5"}',
      }),
    ).toEqual({ model: "anthropic/claude-opus-4-5" });
  });

  it("falls back to the user config", () => {
    expect(
      mergeOpenCodeConfiguredValues({
        projectConfig: null,
        userConfig: '{"model":"openai/gpt-5"}',
      }),
    ).toEqual({ model: "openai/gpt-5" });
  });

  it("pins nothing when neither config names a model", () => {
    expect(mergeOpenCodeConfiguredValues({ projectConfig: null, userConfig: null })).toBe(null);
    expect(
      mergeOpenCodeConfiguredValues({ projectConfig: '{"theme":"dark"}', userConfig: null }),
    ).toBe(null);
  });
});

import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@t3tools/contracts";
import { DEFAULT_UNIFIED_SETTINGS } from "@t3tools/contracts/settings";
import { describe, expect, it } from "vite-plus/test";

import { deriveEffectiveComposerModelState } from "./composerDraftStore";

const INSTANCE = ProviderInstanceId.make("claudeAgent");

function claudeProvider(models: ReadonlyArray<string>): ServerProvider {
  return {
    instanceId: INSTANCE,
    driver: ProviderDriverKind.make("claudeAgent"),
    enabled: true,
    installed: true,
    version: null,
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-01-01T00:00:00.000Z",
    models: models.map((slug) => ({ slug, name: slug, isCustom: false, capabilities: {} })),
    slashCommands: [],
    skills: [],
  };
}

// The catalog lists fable first, so "first in the list" and "what the config
// pins" differ — which is the whole point of these cases.
const PROVIDERS = [claudeProvider(["claude-fable-5", "claude-opus-5", "claude-sonnet-5"])];

const BASE = {
  draft: null,
  providers: PROVIDERS,
  selectedProvider: ProviderDriverKind.make("claudeAgent"),
  selectedInstanceId: INSTANCE,
  threadModelSelection: null,
  projectModelSelection: null,
  settings: DEFAULT_UNIFIED_SETTINGS,
} as const;

describe("composer model seeding from provider configuration", () => {
  it("starts on the configured model instead of the first one listed", () => {
    const state = deriveEffectiveComposerModelState({
      ...BASE,
      configuredModelDefault: { slug: "claude-opus-5", options: [] },
    });

    expect(state.selectedModel).toBe("claude-opus-5");
  });

  it("still lists the first model when the configuration pins nothing", () => {
    const state = deriveEffectiveComposerModelState({ ...BASE, configuredModelDefault: null });

    expect(state.selectedModel).toBe("claude-fable-5");
  });

  // Config seeds; an explicit pick sticks.
  it("lets an explicit thread selection win over the configured model", () => {
    const state = deriveEffectiveComposerModelState({
      ...BASE,
      threadModelSelection: { instanceId: INSTANCE, model: "claude-sonnet-5" },
      configuredModelDefault: { slug: "claude-opus-5", options: [] },
    });

    expect(state.selectedModel).toBe("claude-sonnet-5");
  });

  it("seeds the options the configuration pins", () => {
    const state = deriveEffectiveComposerModelState({
      ...BASE,
      configuredModelDefault: {
        slug: "claude-opus-5",
        options: [
          { id: "effort", value: "high" },
          { id: "contextWindow", value: "1m" },
        ],
      },
    });

    expect(state.modelOptions?.[INSTANCE]).toEqual([
      { id: "effort", value: "high" },
      { id: "contextWindow", value: "1m" },
    ]);
  });
});

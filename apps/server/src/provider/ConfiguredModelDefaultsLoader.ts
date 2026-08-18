/**
 * ConfiguredModelDefaultsLoader - reads the model a provider's own
 * configuration pins for a workspace, so a new thread starts on the configured
 * model instead of whichever the provider snapshot happens to list first.
 *
 * The caller supplies the user-level settings path because a Claude instance
 * may point at a relocated config dir (`CLAUDE_CONFIG_DIR`), so it is not
 * always `~/.claude`.
 *
 * @module ConfiguredModelDefaultsLoader
 */

import * as NodeOS from "node:os";

import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import {
  mergeClaudeConfiguredValues,
  mergeOpenCodeConfiguredValues,
  type ClaudeConfiguredValues,
  type OpenCodeConfiguredValues,
} from "@t3tools/shared/configuredModelDefaults";

import { resolveClaudeHomePath } from "./Drivers/ClaudeHome.ts";

export interface LoadClaudeConfiguredDefaultInput {
  readonly workspaceRoot: string;
  /**
   * The instance's configured Claude home. Empty means the default, whose
   * settings live at `~/.claude/settings.json`; a configured home is itself the
   * config dir (that is what `CLAUDE_CONFIG_DIR` points at), so its settings sit
   * directly inside it.
   */
  readonly claudeHomePath: string;
}

export class ConfiguredModelDefaultsLoader extends Context.Service<
  ConfiguredModelDefaultsLoader,
  {
    /**
     * The model and options Claude Code's settings pin for this workspace.
     *
     * Never fails: a missing or unreadable settings file simply pins nothing,
     * which leaves the app's own model selection in charge.
     */
    readonly loadClaude: (
      input: LoadClaudeConfiguredDefaultInput,
    ) => Effect.Effect<ClaudeConfiguredValues | null>;
    /**
     * The model OpenCode's config pins for this workspace, from the project
     * `opencode.json` then the user config under `XDG_CONFIG_HOME`.
     */
    readonly loadOpenCode: (input: {
      readonly workspaceRoot: string;
    }) => Effect.Effect<OpenCodeConfiguredValues | null>;
  }
>()("t3/provider/ConfiguredModelDefaultsLoader") {}

function nonEmpty(value: string | undefined): string | null {
  return value?.trim() || null;
}

export const make = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  // A settings file nobody wrote is the normal case, and an unreadable one is
  // not worth failing over — both mean "pins nothing".
  const readOptionalFile = (filePath: string) =>
    fileSystem.readFileString(filePath).pipe(Effect.orElseSucceed(() => null));

  const loadClaude: ConfiguredModelDefaultsLoader["Service"]["loadClaude"] = Effect.fn(
    "ConfiguredModelDefaultsLoader.loadClaude",
  )(function* (input) {
    const projectSettings = yield* readOptionalFile(
      path.join(input.workspaceRoot, ".claude", "settings.json"),
    );
    const claudeHome = yield* resolveClaudeHomePath({ homePath: input.claudeHomePath }).pipe(
      Effect.provideService(Path.Path, path),
    );
    const userSettingsPath =
      input.claudeHomePath.trim().length > 0
        ? path.join(claudeHome, "settings.json")
        : path.join(claudeHome, ".claude", "settings.json");
    const userSettings = yield* readOptionalFile(userSettingsPath);
    // The raw values cross the wire; the client resolves them against the model
    // list it already holds from the provider snapshot.
    return mergeClaudeConfiguredValues({ projectSettings, userSettings });
  });

  const loadOpenCode: ConfiguredModelDefaultsLoader["Service"]["loadOpenCode"] = Effect.fn(
    "ConfiguredModelDefaultsLoader.loadOpenCode",
  )(function* (input) {
    const projectConfig = yield* readOptionalFile(path.join(input.workspaceRoot, "opencode.json"));
    const configHome =
      nonEmpty(process.env["XDG_CONFIG_HOME"]) ?? path.join(NodeOS.homedir(), ".config");
    const userConfig = yield* readOptionalFile(path.join(configHome, "opencode", "opencode.json"));
    return mergeOpenCodeConfiguredValues({ projectConfig, userConfig });
  });

  return ConfiguredModelDefaultsLoader.of({ loadClaude, loadOpenCode });
});

export const layer = Layer.effect(ConfiguredModelDefaultsLoader, make);

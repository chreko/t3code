/**
 * Resolves the model a provider's own configuration pins for the active
 * workspace, so a composer with no explicit pick starts there instead of on
 * whichever model the provider snapshot happens to list first.
 *
 * The server hands back the raw configured values; the slug is resolved here,
 * against the model list the client already holds.
 */
import { useAtomValue } from "@effect/atom-react";
import type {
  EnvironmentId,
  ProjectConfiguredModelDefaultsResult,
  ProviderDriverKind,
  ServerProvider,
} from "@t3tools/contracts";
import { resolveClaudeConfiguredValues } from "@t3tools/shared/configuredModelDefaults";
import { AsyncResult, Atom } from "effect/reactivity";
import { useMemo } from "react";

import { projectEnvironment } from "~/state/projects";

export interface ConfiguredModelDefault {
  readonly slug: string | null;
  readonly options: ReadonlyArray<{ readonly id: string; readonly value: string }>;
}

const EMPTY_QUERY_ATOM = Atom.make(
  AsyncResult.initial<ProjectConfiguredModelDefaultsResult, never>(false),
).pipe(Atom.withLabel("configured-model-defaults:empty"));

/** The raw values the workspace's provider configs pin, or `null` until they load. */
export function useConfiguredModelDefaults(input: {
  readonly environmentId: EnvironmentId;
  readonly cwd: string | null;
}): ProjectConfiguredModelDefaultsResult | null {
  const queryAtom = useMemo(
    () =>
      input.cwd
        ? projectEnvironment.configuredModelDefaults({
            environmentId: input.environmentId,
            input: { cwd: input.cwd },
          })
        : EMPTY_QUERY_ATOM,
    [input.environmentId, input.cwd],
  );
  const result = useAtomValue(queryAtom);
  return AsyncResult.isSuccess(result) ? result.value : null;
}

/** The configured default for one provider, resolved against the models it lists. */
export function resolveConfiguredModelDefault(input: {
  readonly data: ProjectConfiguredModelDefaultsResult | null;
  readonly provider: ProviderDriverKind;
  readonly models: ReadonlyArray<ServerProvider["models"][number]>;
}): ConfiguredModelDefault | null {
  const { data } = input;
  if (!data) return null;
  if (input.provider === "claudeAgent") {
    return data.claude
      ? resolveClaudeConfiguredValues(
          data.claude,
          input.models.map((model) => model.slug),
        )
      : null;
  }
  if (input.provider === "opencode") {
    // OpenCode slugs models `providerID/modelID`, the same shape its config
    // uses, so a configured model the snapshot does not list is ignored.
    return data.opencode && input.models.some((model) => model.slug === data.opencode?.model)
      ? { slug: data.opencode.model, options: [] }
      : null;
  }
  return null;
}

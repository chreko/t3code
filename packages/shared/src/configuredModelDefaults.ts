/**
 * Reads the default model a provider's own configuration declares, so T3 Code
 * follows the provider's config instead of falling back to whichever model
 * happens to sort first.
 *
 * These helpers are pure: callers supply the file contents and the catalog to
 * resolve against. A configuration that names no model, or names one the
 * provider does not offer, resolves to `null` and leaves the app's own model
 * selection in charge.
 *
 * @module configuredModelDefaults
 */

function parseJsonObject(raw: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    // Hand-edited config files are routinely malformed, and a default model is
    // not worth failing a provider probe over.
    return null;
  }
}

function readModelField(raw: string): string | null {
  const parsed = parseJsonObject(raw);
  if (!parsed) return null;
  const model = parsed["model"];
  if (typeof model !== "string") return null;
  return model.trim() || null;
}

/** The `model` a Claude Code `settings.json` configures, if any. */
export function modelFromClaudeSettings(raw: string): string | null {
  return readModelField(raw);
}

/**
 * The `model` an OpenCode config configures. OpenCode addresses models as
 * `providerID/modelID`, which is also how the provider snapshot slugs them, so
 * a bare model id cannot be resolved and is ignored.
 */
export function modelFromOpenCodeConfig(raw: string): string | null {
  const model = readModelField(raw);
  if (!model) return null;
  const separator = model.indexOf("/");
  return separator > 0 && separator < model.length - 1 ? model : null;
}

// Claude Code accepts family aliases in place of a model id. Each maps to the
// newest catalog entry for that family, which is what the alias means to the
// CLI as well.
const CLAUDE_FAMILY_ALIASES = ["fable", "opus", "sonnet", "haiku"] as const;

/**
 * Resolves a configured Claude model onto a catalog slug, accepting the forms
 * Claude Code takes: a catalog slug, a family alias (`opus`), or a dated API id
 * (`claude-opus-4-8-20260101`). Returns `null` when the catalog cannot offer it.
 */
export function resolveClaudeCatalogSlug(
  configured: string,
  catalogSlugs: ReadonlyArray<string>,
): string | null {
  const normalized = configured.trim().toLowerCase();
  if (!normalized) return null;

  if (catalogSlugs.includes(normalized)) return normalized;

  const alias = CLAUDE_FAMILY_ALIASES.find((family) => family === normalized);
  if (alias) {
    // Catalog order is newest-first per family, so the first match is the one
    // the alias names.
    return catalogSlugs.find((slug) => slug.startsWith(`claude-${alias}-`)) ?? null;
  }

  // A dated api id extends its undated slug, so the longest matching prefix is
  // the intended entry.
  const prefixMatches = catalogSlugs
    .filter((slug) => normalized.startsWith(`${slug}-`))
    .toSorted((left, right) => right.length - left.length);
  return prefixMatches[0] ?? null;
}

/** A model option the provider's configuration pins, in ModelSelection shape. */
export interface ConfiguredModelOption {
  readonly id: string;
  readonly value: string;
}

export interface ClaudeConfiguredDefault {
  /** `null` when the configuration pins options but not a model. */
  readonly slug: string | null;
  readonly options: ReadonlyArray<ConfiguredModelOption>;
}

/**
 * Splits Claude Code's `model` string into its catalog part and the context
 * window it encodes — the inverse of `resolveClaudeApiModelId`, which appends
 * the same `[1m]` suffix.
 */
export function parseClaudeConfiguredModel(configured: string): {
  readonly base: string;
  readonly contextWindow: string | null;
} {
  const match = /^(?<base>.+?)\[(?<window>[^\]]+)\]$/u.exec(configured.trim());
  const base = match?.groups?.["base"] ?? configured.trim();
  const contextWindow = match?.groups?.["window"] ?? null;
  return { base, contextWindow: contextWindow?.trim().toLowerCase() || null };
}

function readEffortField(raw: string): string | null {
  const parsed = parseJsonObject(raw);
  if (!parsed) return null;
  const effort = parsed["effortLevel"];
  if (typeof effort !== "string") return null;
  return effort.trim().toLowerCase() || null;
}

/**
 * The model and options Claude Code's configuration pins, with the project file
 * winning per key — the way Claude Code merges its own settings, so a project
 * file that overrides only the model keeps the user file's effort.
 *
 * Returns `null` when neither file pins anything, leaving the app's own model
 * selection untouched.
 */
/** The raw `model` / `effortLevel` Claude Code's settings pin, before any
 * catalog resolution — this is what crosses the wire, so the client can map it
 * against the model list it already holds. */
export interface ClaudeConfiguredValues {
  readonly model: string | null;
  readonly effort: string | null;
}

/**
 * Merges the settings files per key, with the project file winning — the way
 * Claude Code merges its own settings, so a project file that overrides only
 * the model keeps the user file's effort.
 */
export function mergeClaudeConfiguredValues(input: {
  readonly projectSettings: string | null;
  readonly userSettings: string | null;
}): ClaudeConfiguredValues | null {
  const files = [input.projectSettings, input.userSettings].filter(
    (raw): raw is string => raw !== null,
  );
  const model = files.map(modelFromClaudeSettings).find((value) => value !== null) ?? null;
  const effort = files.map(readEffortField).find((value) => value !== null) ?? null;
  return model === null && effort === null ? null : { model, effort };
}

/** Resolves raw configured values onto a catalog slug and option selections. */
export function resolveClaudeConfiguredValues(
  values: ClaudeConfiguredValues,
  catalogSlugs: ReadonlyArray<string>,
): ClaudeConfiguredDefault | null {
  const parsed = values.model === null ? null : parseClaudeConfiguredModel(values.model);
  const slug = parsed === null ? null : resolveClaudeCatalogSlug(parsed.base, catalogSlugs);

  const options: Array<ConfiguredModelOption> = [];
  if (values.effort) options.push({ id: "effort", value: values.effort });
  // A context window pinned alongside a model the catalog rejects would apply
  // to whatever model the app picked instead, which is not what was configured.
  if (slug !== null && parsed?.contextWindow) {
    options.push({ id: "contextWindow", value: parsed.contextWindow });
  }
  return slug === null && options.length === 0 ? null : { slug, options };
}

export function resolveClaudeConfiguredDefault(input: {
  readonly projectSettings: string | null;
  readonly userSettings: string | null;
  readonly catalogSlugs: ReadonlyArray<string>;
}): ClaudeConfiguredDefault | null {
  const values = mergeClaudeConfiguredValues(input);
  return values === null ? null : resolveClaudeConfiguredValues(values, input.catalogSlugs);
}

/** The model an OpenCode config pins, already `providerID/modelID` shaped. */
export interface OpenCodeConfiguredValues {
  readonly model: string;
}

/**
 * Merges OpenCode's config files, project over user. OpenCode resolves its own
 * config the same way, so a project `opencode.json` wins.
 */
export function mergeOpenCodeConfiguredValues(input: {
  readonly projectConfig: string | null;
  readonly userConfig: string | null;
}): OpenCodeConfiguredValues | null {
  const model =
    [input.projectConfig, input.userConfig]
      .filter((raw): raw is string => raw !== null)
      .map(modelFromOpenCodeConfig)
      .find((value) => value !== null) ?? null;
  return model === null ? null : { model };
}

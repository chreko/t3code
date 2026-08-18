import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import * as ConfiguredModelDefaultsLoader from "./ConfiguredModelDefaultsLoader.ts";

const TestLayer = Layer.empty.pipe(
  Layer.provideMerge(ConfiguredModelDefaultsLoader.layer),
  Layer.provideMerge(NodeServices.layer),
);

const makeTempDir = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  return yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3code-configured-model-" });
});

const writeJson = Effect.fn("writeJson")(function* (filePath: string, contents: string) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  yield* fileSystem.makeDirectory(path.dirname(filePath), { recursive: true }).pipe(Effect.orDie);
  yield* fileSystem.writeFileString(filePath, contents).pipe(Effect.orDie);
});

it.layer(TestLayer)("ConfiguredModelDefaultsLoader", (it) => {
  describe("loadClaude", () => {
    it.effect("reads the model a user settings file pins", () =>
      Effect.gen(function* () {
        const loader = yield* ConfiguredModelDefaultsLoader.ConfiguredModelDefaultsLoader;
        const path = yield* Path.Path;
        const root = yield* makeTempDir;
        const claudeHomePath = path.join(root, "home");
        const userSettingsPath = path.join(claudeHomePath, "settings.json");
        yield* writeJson(userSettingsPath, '{"model":"opus[1m]","effortLevel":"high"}');

        expect(
          yield* loader.loadClaude({
            workspaceRoot: path.join(root, "project"),
            claudeHomePath,
          }),
        ).toEqual({ model: "opus[1m]", effort: "high" });
      }),
    );

    it.effect("lets the workspace settings win over the user settings", () =>
      Effect.gen(function* () {
        const loader = yield* ConfiguredModelDefaultsLoader.ConfiguredModelDefaultsLoader;
        const path = yield* Path.Path;
        const root = yield* makeTempDir;
        const workspaceRoot = path.join(root, "project");
        const claudeHomePath = path.join(root, "home");
        const userSettingsPath = path.join(claudeHomePath, "settings.json");
        yield* writeJson(userSettingsPath, '{"model":"opus"}');
        yield* writeJson(
          path.join(workspaceRoot, ".claude", "settings.json"),
          '{"model":"sonnet"}',
        );

        expect(yield* loader.loadClaude({ workspaceRoot, claudeHomePath })).toEqual({
          model: "sonnet",
          effort: null,
        });
      }),
    );

    it.effect("pins nothing when no settings file exists", () =>
      Effect.gen(function* () {
        const loader = yield* ConfiguredModelDefaultsLoader.ConfiguredModelDefaultsLoader;
        const path = yield* Path.Path;
        const root = yield* makeTempDir;

        expect(
          yield* loader.loadClaude({
            workspaceRoot: path.join(root, "project"),
            claudeHomePath: path.join(root, "home"),
          }),
        ).toBe(null);
      }),
    );
  });
});

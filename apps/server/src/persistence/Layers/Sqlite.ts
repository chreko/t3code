import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";

import { runMigrations } from "../Migrations.ts";
import { ServerConfig } from "../../config.ts";

type RuntimeSqliteLayerConfig = {
  readonly filename: string;
  readonly spanAttributes?: Record<string, unknown>;
};

type Loader = {
  layer: (config: RuntimeSqliteLayerConfig) => Layer.Layer<SqlClient.SqlClient, SqlError>;
};
const defaultSqliteClientLoaders = {
  bun: () => import("@effect/sql-sqlite-bun/SqliteClient"),
  node: () => import("@t3tools/shared/nodeSqliteClient"),
} satisfies Record<string, () => Promise<Loader>>;

const makeRuntimeSqliteLayer = Effect.fn("makeRuntimeSqliteLayer")(function* (
  config: RuntimeSqliteLayerConfig,
) {
  const runtime = process.versions.bun !== undefined ? "bun" : "node";
  const loader = defaultSqliteClientLoaders[runtime];
  const clientModule = yield* Effect.promise<Loader>(loader);
  return clientModule.layer(config);
}, Layer.unwrap);

const setup = Layer.effectDiscard(
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    // CLI and server write from separate processes; wait rather than fail with SQLITE_BUSY.
    yield* sql`PRAGMA busy_timeout = 5000;`;
    yield* sql`PRAGMA foreign_keys = ON;`;
    yield* sql`PRAGMA journal_mode = WAL;`;
    yield* runMigrations();
  }),
);

export const makeSqlitePersistenceLive = Effect.fn("makeSqlitePersistenceLive")(function* (
  dbPath: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  yield* fs.makeDirectory(path.dirname(dbPath), { recursive: true });

  return Layer.provideMerge(
    setup,
    makeRuntimeSqliteLayer({
      filename: dbPath,
      spanAttributes: {
        "db.name": path.basename(dbPath),
        "service.name": "t3-server",
      },
    }),
  );
}, Layer.unwrap);

export class ServerStateInUseError extends Schema.TaggedError<ServerStateInUseError>()(
  "ServerStateInUseError",
  {
    stateDir: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Another T3 Code server is already using ${this.stateDir}. Stop it, or start this one with a different --base-dir.`;
  }
}

/**
 * Hold `<stateDir>/server.lock` exclusively for the calling scope. The
 * orchestration engine keeps its command model in memory, so a second server
 * on the same state never sees the first one's threads and rejects every
 * command for them. SQLite's file lock dies with the process, so a crash leaves
 * no stale lock behind.
 */
export const acquireServerStateLock = Effect.fn("acquireServerStateLock")(function* (
  stateDir: string,
) {
  const path = yield* Path.Path;
  const context = yield* Layer.build(
    makeRuntimeSqliteLayer({ filename: path.join(stateDir, "server.lock") }),
  );
  const sql = Context.get(context, SqlClient.SqlClient);
  // Exclusive locking mode keeps the lock after COMMIT until the connection closes.
  yield* sql`PRAGMA locking_mode = EXCLUSIVE`;
  yield* sql`BEGIN EXCLUSIVE`.pipe(
    Effect.catchIf(
      // node:sqlite reports SQLITE_BUSY (5) as `errcode`, which the shared
      // classifier leaves as UnknownError; bun's arrives as LockTimeoutError.
      (error) =>
        error.reason._tag === "LockTimeoutError" ||
        (Predicate.hasProperty(error.reason.cause, "errcode") && error.reason.cause.errcode === 5),
      (cause) => Effect.fail(new ServerStateInUseError({ stateDir, cause })),
    ),
  );
  yield* sql`COMMIT`;
});

export const SqlitePersistenceMemory = Layer.provideMerge(
  setup,
  makeRuntimeSqliteLayer({ filename: ":memory:" }),
);

export const layerConfig = Layer.unwrap(
  Effect.gen(function* () {
    const { dbPath } = yield* ServerConfig;
    return makeSqlitePersistenceLive(dbPath);
  }),
);

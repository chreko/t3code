import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

import { runMigrations } from "./Migrations.ts";
import { initializeV2Database } from "./initializeV2Database.ts";
import * as ServerConfig from "../config.ts";

// Size the -wal file is cut back to on the first commit after a WAL reset.
export const WAL_SIZE_LIMIT_BYTES = 32 * 1024 * 1024;

const layerSetup = Layer.effectDiscard(
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    // CLI and server write from separate processes; wait rather than fail with SQLITE_BUSY.
    yield* sql`PRAGMA busy_timeout = 5000;`;
    yield* sql`PRAGMA foreign_keys = ON;`;
    yield* sql`PRAGMA journal_mode = WAL;`;
    // FULL fsyncs the WAL on every commit, on the main thread. Every provider
    // event is its own commit, so a slow or busy disk stalls the event loop
    // and clients drop. In WAL mode NORMAL only fsyncs at checkpoints. It
    // cannot corrupt the database and an app crash loses nothing; an OS crash
    // or power loss can roll back commits since the last checkpoint.
    yield* sql`PRAGMA synchronous = NORMAL;`;
    // PASSIVE checkpoints never shrink the -wal file, so it otherwise keeps its
    // largest size until the last connection closes.
    yield* sql.unsafe(`PRAGMA journal_size_limit = ${WAL_SIZE_LIMIT_BYTES};`);
    yield* runMigrations();
    // Without sqlite_stat1 the planner guesses at index selectivity. 0x10012
    // analyzes tables whose indexes lack stats or whose row count changed 10x,
    // under a temporary analysis_limit. Otherwise it only checks table sizes.
    yield* sql`PRAGMA optimize = 0x10012;`;
  }),
);

export const layerFromPath = Effect.fn("makeSqlitePersistenceLive")(function* (dbPath: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  yield* fs.makeDirectory(path.dirname(dbPath), { recursive: true });

  return Layer.provideMerge(
    layerSetup,
    NodeSqliteClient.layer({
      filename: dbPath,
      readerWorker: true,
      spanAttributes: {
        "db.name": path.basename(dbPath),
        "service.name": "t3code-server",
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
    NodeSqliteClient.layer({ filename: path.join(stateDir, "server.lock") }),
  );
  const sql = Context.get(context, SqlClient.SqlClient);
  // Exclusive locking mode keeps the lock after COMMIT until the connection closes.
  yield* sql`PRAGMA locking_mode = EXCLUSIVE`;
  yield* sql`BEGIN EXCLUSIVE`.pipe(
    Effect.catchIf(
      // node:sqlite reports SQLITE_BUSY (5) as `errcode`, which the shared
      // classifier leaves as UnknownError.
      (error) =>
        error.reason._tag === "LockTimeoutError" ||
        (Predicate.hasProperty(error.reason.cause, "errcode") && error.reason.cause.errcode === 5),
      (cause) => Effect.fail(new ServerStateInUseError({ stateDir, cause })),
    ),
  );
  yield* sql`COMMIT`;
});

export const layerMemory = Layer.provideMerge(
  layerSetup,
  NodeSqliteClient.layer({ filename: ":memory:" }),
);

export const layerConfig = Layer.unwrap(
  Effect.gen(function* () {
    const { dbPath } = yield* ServerConfig.ServerConfig;
    yield* initializeV2Database(dbPath);
    return layerFromPath(dbPath);
  }),
);

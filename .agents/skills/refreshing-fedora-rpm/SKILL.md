---
name: refreshing-fedora-rpm
description: Use when the Fedora build branch (local/fedora-build-no-connect) should catch up with upstream main and ship a fresh T3 Code desktop rpm for the Fedora template — "any new essential updates?", "fetch main and merge", "rebuild the rpm", "new package for my template", "update t3code in the template" — or when a merge from origin/main conflicts on this branch.
---

# Refreshing the Fedora RPM

`local/fedora-build-no-connect` is `origin/main` plus a few local commits: T3 Connect
hard-disabled, the configured-model default, terminal middle-click and host-clipboard
paste, a 30 s remote auth timeout, and one cherry-picked upstream PR that shows symlinks
in the path picker (#8281; closed 2026-10-28 in favour of #26168, still open 2026-11-10). The Files-tree pick (#21920) is
retired: it landed upstream as a3cf3f0fe7. On top of it the fork still lists links that
leave the project, with a `linkTarget` that the web and mobile trees open as a host path. Three former patches are retired because upstream
now does the same thing: packaging `homepage`/`maintainer` (c13f7d93ff), Alt+Enter as a
newline (the keybindings resolver in `composer-logic.ts` returns null on `event.altKey`),
and the server state lock (`acquireServerStateLock`), replaced by upstream's
`acquireServerOwnership` in `serverOwnership.ts` (#16102). The rpm is the Electron desktop app, built by electron-builder **on
eschdorf-ai** and fetched back to `dist/`. Nothing builds in this qube: no Rust, no
libsecret headers, 8 GB RAM.

eschdorf-ai runs **Omarchy (Arch)** since 2026-09-14. Anything below that reads like
Debian — `apt`, `dpkg`, `x86_64-linux-gnu` paths — is Kali-era and no longer applies.

Run everything from the repo root, `/home/user/git/t3code`, on that branch. Only
`origin/main` is merged; local `main` is never touched.

## 0. Is anything essential?

```bash
git fetch origin main
git log --oneline HEAD..origin/main | wc -l
git show origin/main:apps/desktop/package.json | grep '"version"'   # vs ours
git log --oneline HEAD..origin/main | sed -E 's/^[0-9a-f]+ //' \
  | grep -iE '^(fix|perf)\((server|desktop|sqlite|client|clients|client-runtime|terminal|git)\)'
```

Essential means at least one of: a version bump (the template then upgrades in place);
a fix for disk growth, data loss, a crash, a hang, or a stuck thread; or a change to a
file the fork patches. Mobile, marketing, CI, and connect/relay commits never count:
this build ships no mobile app and Connect is off. Report what qualifies and why
before merging.

Then list which of the fork's files upstream also touched. That is where conflicts
land, and where upstream may have made a fork patch redundant:

```bash
MB=$(git merge-base HEAD origin/main)
comm -12 <(git diff --name-only $MB..HEAD | sort) <(git diff --name-only $MB..origin/main | sort)
```

## 1. Merge

```bash
git status --short          # must be clean apart from untracked scripts/package-server-deb.sh; otherwise stop and ask
git fetch origin main && git merge origin/main --no-edit
```

Resolve with the `resolving-merge-conflicts` skill; never abort. Before keeping a fork
hunk, check whether upstream now does the same thing. Two patches have been retired
that way, and taking upstream's side is the right resolution when it happens.

- `apps/*/src/cloud/publicConfig.ts`, `DesktopClerk.ts`: keep the hard-disabled constants.
- `ChatComposer.tsx`: resolve hunk by hunk, never `git checkout --theirs` on the whole
  file. The configured model default reaches model selection through
  `useComposerProviderModel` (its `environmentId`/`cwd` inputs, then
  `useConfiguredModelDefaults` and `resolveConfiguredModelDefault`); dropping it compiles
  fine and silently loses the feature.
- Contracts and RPC tables (`rpc.ts`, `project.ts`, `projectCommands.ts`,
  `RpcAuthorization.ts`, `RpcInstrumentation.ts`, `ws.ts`): upstream adding a project RPC
  next to `projects.configuredModelDefaults` conflicts; keep both. Where the conflict ends
  inside a shared closing `})`, the fork side needs its own.
- `apps/web/src/terminal/ghostty/surface.ts` and its test: the fork removed upstream's
  middle-click paste (d1eeb1624: `isMiddleClickPastePlatform`, `pasteTerminalSelection`,
  and the "pastes the terminal selection, and only that, on a Linux middle click" test)
  for its own primary-selection paste (`shouldPastePrimarySelection`); the two cannot
  coexist. The paste shortcut keeps the host read (`options.readClipboardText`) on top of
  whatever upstream does there. The fork's only tests in that file are the
  `shouldPastePrimarySelection` block; upstream deleting its own tests (#22557) wins.
- `scripts/build-desktop-artifact.ts`: upstream's `homepage`/`maintainer` win.
- `apps/server/src/workspace/WorkspaceEntries.ts` and its test: upstream owns this
  function now, so take its side of every hunk, then re-apply the fork's outside-link
  listing to `resolveSymlinkKind`. Upstream returns undefined for anything outside the
  root; the fork instead stats it, records the real path in `linkTargets`, and returns
  the kind, which is what `?? (linkTarget === undefined ? {} : { linkTarget })` on the
  entry needs. Keep upstream's own additions whole: the canonical-ancestor cycle guard
  and `nestedGitRoots`, which the surrounding Effect reads further down. In the test,
  the fork's `path: "outside-link"` expectation and its
  `lists a link that leaves the workspace with the real path it opens` test stay; every
  other hunk is upstream's. The clients (`ProjectEntry.linkTarget` in contracts,
  `FileBrowserPanel`, `FileBreadcrumbs`, mobile `fileTree`/`FileTreeBrowser`) conflict
  only if upstream changed those files. If #26168 lands too, take upstream's side there
  and drop it from the opening paragraph.
- A test file upstream deleted wins the modify/delete if our change was only harness
  wiring; check the wiring still exists in the real code.

Some failure modes show up only in `tsc` or the tests, never as conflict markers:

- automerge duplicating a key outside the conflict region;
- new upstream test stubs of `ElectronShell` missing the fork's `readClipboardText`
  (add `readClipboardText: Effect.succeed("")`), and new upstream test layers missing
  `ConfiguredModelDefaultsLoader` (add `Layer.mock(...ConfiguredModelDefaultsLoader)({})`);
- an upstream Effect bump moving modules out of `effect/unstable/*` (`effect/sql`,
  `effect/reactivity`): `git grep effect/unstable/` finds fork files left behind. One
  stale import in the server turns into hundreds of `unknown`-requirement errors;
- upstream renaming or reshaping what fork code calls. The `projects.configuredModelDefaults`
  handler in `ws.ts` reads the Claude home from the `claudeAgent` provider instance and
  needs an entry in `observability/RpcInstrumentation.ts`;
- a changed meaning with unchanged types: `resolveClaudeHomePath` once returned `$HOME`
  for an empty home and now returns `~/.claude`. `ConfiguredModelDefaultsLoader.test.ts`
  pins the default-home path, so run it.

## 2. Verify, then commit

`vp` is not on PATH and nvm's default Node cannot run the repo's `.ts` tooling:

```bash
export PATH=$HOME/.nvm/versions/node/v24.13.1/bin:$PWD/node_modules/.bin:$PATH
CI=true vp i                # CI=true lets pnpm purge node_modules without a TTY
for d in apps/web packages/contracts apps/server apps/desktop; do
  echo "== $d: $(cd $d && effect-tsgo tsrs --noEmit 2>&1 | grep -c 'error TS') errors"; done
(cd apps/server && vp test run src/orchestration-v2/runtimeLayer.test.ts \
  src/provider/ConfiguredModelDefaultsLoader.test.ts src/ws.test.ts)
(cd apps/web && vp test run --project unit src/components/chat/ src/composer-logic.test.ts src/composerConfiguredModelSeed.test.ts \
  src/terminal/ghostty/surface.test.ts)
```

Pass = all four counts are 0 and both test runs are green. The server run carries the
configured-model loader. The web run carries the Alt+Enter, configured-model (including
the Claude resolver, whose driver kind is `claudeAgent`, not `claude`), and middle-click
paste tests. Root `package.json` pins `engines.node` to an exact Node 26 release; nvm's
24.13.1 still installs, typechecks and tests with only a warning, and nothing enforces
the pin. `tsc` also prints many
`suggestion TS3771xx` lines from the Effect language service; those are not errors, but
its `error TS3770xx` rules are, and they tighten over time: `processEnvInEffect` and
`missingEffectError` both first failed on fork code that had typechecked for months.
Typecheck is `effect-tsgo tsrs --noEmit` since upstream replaced `@tsc-rs/typescript`
with `@effect/tsgo`; `apps/web` and `apps/desktop` declare no `typecheck` script, so
run the binary in each directory rather than through a package script. No
repo-wide checks (`vp check`, `vp run -r ...`). Commit as
`merge: origin/main into the Fedora build`, noting any conflict you resolved.

**A green typecheck and green tests do not mean the rpm runs.** They exercise the pnpm
dev tree, where peer dependencies are linked and every import resolves. electron-builder
packages only `dependencies` and `optionalDependencies`, so a dependency that upstream
(or a bumped transitive package) turned into a peer is dropped from the asar and the
backend dies on first require with `Cannot find module`, in a restart loop that reports
only `code=1`. This shipped 0.1.3: `@cursor/sdk` 1.0.38 made `zod` a peer and no
workspace package declared it. After step 3, before step 4, check the package you built
actually contains what it needs:

```bash
V=$(node -p "require('./apps/desktop/package.json').version")
D=$(mktemp -d) && (cd "$D" && rpm2cpio ~/git/t3code/dist/T3-Code-$V-x86_64.rpm \
  | cpio -id --quiet './opt/T3 Code (Beta)/resources/app.asar')
node -e '
const asar = require("/home/user/git/t3code/node_modules/.pnpm/@electron+asar@4.3.0/node_modules/@electron/asar/lib/asar.js");
const files = asar.listPackage(process.argv[1], { isPack: false });
const top = new Set(files.filter((f) => /^[/\\]node_modules[/\\]/.test(f)).map((f) => f.split(/[/\\]/)[2]));
console.log([...top].sort().join("\n"));
' "$D/opt/T3 Code (Beta)/resources/app.asar'
```

Diff that list against the previous working rpm's; a package that disappeared is the
bug. `zod` must be present. The asar's own `node_modules` is the only copy the backend
can require, so anything missing there is missing at runtime.

## 3. Build on eschdorf-ai

If `ssh eschdorf-ai-claude echo up` times out, wake it with the `eschdorf-ai-power`
skill and retry. Read the version after the merge, since upstream bumps it:

```bash
V=$(node -p "require('./apps/desktop/package.json').version")
~/.claude/skills/run-on-eschdorf-ai/scripts/push-and-package.sh /home/user/git/t3code fedora \
  --exclude release --exclude .t3 --exclude .claude/worktrees \
  --build-cmd 'export CI=true LD_LIBRARY_PATH=$HOME/.local/opt/libxcrypt-compat/usr/lib${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}
               rm -rf release && corepack pnpm install --frozen-lockfile &&
               corepack pnpm exec node scripts/build-desktop-artifact.ts --platform linux --target $PKG_TARGET --arch x64' \
  --artifact 'release/*.$PKG_TARGET'
```

Run it from the repo root (the fetch lands in `./dist/` of the cwd) and in the
background or with a 10-minute tool timeout: push plus build takes about five minutes
and the default two-minute Bash timeout kills the local side. The remote side runs in a
detached tmux session and survives that; the log is `dist/.t3code-rpm-build.log`. Result:
`dist/T3-Code-$V-x86_64.rpm`. `.claude/worktrees` is several GB and the default
excludes do not cover it.

Then point the stable name at the new build (relative target, so the link stays valid
wherever `dist/` is mounted or copied):

```bash
ln -sfn T3-Code-$V-x86_64.rpm dist/T3-Code-latest-x86_64.rpm
```

`dist/T3-Code-latest-x86_64.rpm` always resolves to the newest build; older versioned
files stay alongside it. When upstream has not bumped the version the build overwrites
the same filename and the link already points at it, so there is nothing to move.

`CI=true` is load-bearing too. When the lockfile moves enough, pnpm asks before
purging `node_modules`; in the remote tmux session it has a TTY, so it does not abort,
it waits for an answer forever and the wrapper just keeps printing "still running".
If a build sits there for more than ten minutes, check
`ssh eschdorf-ai-claude tmux capture-pane -p -t pkg-t3code-rpm-build` before waiting longer.

`--frozen-lockfile` failing means the merge left `package.json` and `pnpm-lock.yaml`
disagreeing: fix the merge, do not drop the flag.

**`libcrypt.so.1` on the build box — the export above is load-bearing.** electron-builder
packages the rpm with its own bundled fpm, a Ruby 3.4.3 binary linked against
`libcrypt.so.1`. Arch's libxcrypt ships only `libcrypt.so.2`; `libcrypt.so.1` comes from
`libxcrypt-compat`, which is not installed, and `claude` has no sudo. Without
`LD_LIBRARY_PATH` the build runs for minutes and then dies at the very last step with
`ruby: error while loading shared libraries: libcrypt.so.1`.

The library is already extracted at `~/.local/opt/libxcrypt-compat/usr/lib/`, verified
2026-09-26. If it ever goes missing, the clean fix is one operator command:

```bash
sudo pacman -S libxcrypt-compat     # as chreko, not the claude account
```

The export above then becomes harmless rather than necessary. Without sudo, unpack the
package into that same directory instead — `pacman -Sp libxcrypt-compat` prints its URL,
`curl -fLO` it, and `tar -I zstd -xf <pkg>.tar.zst -C $D usr/lib` extracts it. That
fallback has not been exercised since the Omarchy migration; the extracted directory
predates it.

**libsecret needs nothing.** The build compiles a browser-secret helper against
libsecret, and Arch ships the headers in the main package, so `pkg-config --exists
libsecret-1` already succeeds system-wide. The old Kali `PKG_CONFIG_PATH` export and its
`~/.local/opt/libsecret-dev` directory are gone and are not needed.

## 4. Deliver

1. The template restore set already follows the new build:
   `~/git/qubes-dotfiles/Fedora-Template/Packages/T3-Code-latest-x86_64.rpm` is a symlink to
   `dist/T3-Code-latest-x86_64.rpm`, and the bundle step there copies with a dereferencing
   `cp`. Do not copy rpm files into that directory. Confirm with
   `rpm -qp --qf '%{VERSION}\n' ~/git/qubes-dotfiles/Fedora-Template/Packages/T3-Code-latest-x86_64.rpm`.
2. `qvm-copy dist/T3-Code-$V-x86_64.rpm` and tell the user to pick the template
   (`qubesdb-read /qubes-base-template`, currently `fedora-44-xfce`) in the picker and
   approve the dom0 dialog.
3. In a terminal in the template: `sudo dnf install ~/QubesIncoming/qubes-builder/T3-Code-$V-x86_64.rpm`.
   The package is named `t3code`, so a newer version upgrades in place. Same version as
   last time: `dnf install` says "already installed", use `sudo dnf reinstall`. Then shut
   the template down; AppVMs pick it up on their next start.

## Common mistakes

- `vp run dist:desktop:linux` builds an AppImage, and not on this machine.
- Forgetting to move the `latest` symlink, or pointing it at an absolute path.
- Running the artifact script with bare `node` on the box: `spawn vp ENOENT`. It needs
  `corepack pnpm exec`. There is no `~/.local/opt/node24` any more; the box builds with
  its system Node (v26 at `/usr/bin/node`).
- Skipping step 2 and packaging a merge that does not typecheck.
- Removing the old rpm in the template before installing. `dnf install` upgrades.
- Piping `push-and-package.sh` into `tail` without `set -o pipefail`. The wrapper exits
  1 and dumps the build log on failure, but the pipeline reports `tail`'s status and the
  run looks green.

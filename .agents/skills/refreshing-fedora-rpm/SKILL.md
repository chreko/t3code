---
name: refreshing-fedora-rpm
description: Use when the Fedora build branch (local/fedora-build-no-connect) should catch up with upstream main and ship a fresh T3 Code desktop rpm for the Fedora template — "any new essential updates?", "fetch main and merge", "rebuild the rpm", "new package for my template", "update t3code in the template" — or when a merge from origin/main conflicts on this branch.
---

# Refreshing the Fedora RPM

`local/fedora-build-no-connect` is `origin/main` plus a few local commits: T3 Connect
hard-disabled, a server state lock (`acquireServerStateLock`), the configured-model
default, terminal middle-click and host-clipboard paste, and a 30 s remote auth
timeout. Two former patches are retired because upstream now does the same thing:
packaging `homepage`/`maintainer` (c13f7d93ff) and Alt+Enter as a newline (the
keybindings resolver in `composer-logic.ts` returns null on `event.altKey`). The rpm is the Electron desktop app, built by electron-builder **on
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
  file. The configured-model-default wiring (`useConfiguredModelDefault`) usually
  automerges _around_ the conflict, and taking the file wholesale silently drops it.
- `apps/server/src/server.ts`: upstream imports the Sqlite layer as a namespace
  (`SqlitePersistence`), so the lock call is `SqlitePersistence.acquireServerStateLock`.
- `scripts/build-desktop-artifact.ts`: upstream's `homepage`/`maintainer` win.
- A test file upstream deleted wins the modify/delete if our change was only harness
  wiring; check the wiring still exists in the real code.

Two failure modes need `tsc` to show up, never conflict markers: automerge duplicating
a key outside the conflict region, and new upstream test stubs of `ElectronShell`
missing the fork's `readClipboardText` (add `readClipboardText: Effect.succeed("")`).

## 2. Verify, then commit

`vp` is not on PATH and nvm's default Node cannot run the repo's `.ts` tooling:

```bash
export PATH=$HOME/.nvm/versions/node/v24.13.1/bin:$PWD/node_modules/.bin:$PATH
CI=true vp i                # CI=true lets pnpm purge node_modules without a TTY
for d in apps/web packages/contracts apps/server apps/desktop; do
  echo "== $d: $(cd $d && tsc --noEmit 2>&1 | grep -c 'error TS') errors"; done
(cd apps/server && vp test run src/persistence/Layers/Sqlite.test.ts src/orchestration-v2/runtimeLayer.test.ts)
(cd apps/web && vp test run --project unit src/components/chat/ src/composer-logic.test.ts src/composerConfiguredModelSeed.test.ts)
```

Pass = all four counts are 0 and both test runs are green. The server run carries the
fork's own lock test ("lets only one server at a time hold a state directory"); upstream
deleted `src/server.test.ts` with the new orchestrator (#2829). The web run carries the
Alt+Enter and configured-model tests. `tsc` also prints many
`suggestion TS3771xx` lines from the Effect language service; those are not errors. No
repo-wide checks (`vp check`, `vp run -r ...`). Commit as
`merge: origin/main into the Fedora build`, noting any conflict you resolved.

## 3. Build on eschdorf-ai

If `ssh eschdorf-ai-claude echo up` times out, wake it with the `eschdorf-ai-power`
skill and retry. Read the version after the merge, since upstream bumps it:

```bash
V=$(node -p "require('./apps/desktop/package.json').version")
~/.claude/skills/run-on-eschdorf-ai/scripts/push-and-package.sh /home/user/git/t3code fedora \
  --exclude release --exclude .t3 --exclude .claude/worktrees \
  --build-cmd 'export LD_LIBRARY_PATH=$HOME/.local/opt/libxcrypt-compat/usr/lib${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}
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

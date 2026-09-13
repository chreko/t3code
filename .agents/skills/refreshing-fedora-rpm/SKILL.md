---
name: refreshing-fedora-rpm
description: Use when the Fedora build branch (local/fedora-build-no-connect) should catch up with upstream main and ship a fresh T3 Code desktop rpm for the Fedora template — "fetch main and merge", "rebuild the rpm", "new package for my template", "update t3code in the template" — or when a merge from origin/main conflicts on this branch.
---

# Refreshing the Fedora RPM

`local/fedora-build-no-connect` is `origin/main` plus a few local commits (T3 Connect
hard-disabled, rpm/deb metadata for fpm, configured-model default). The rpm is the
Electron desktop app, built by electron-builder **on eschdorf-ai** and fetched back to
`dist/`. Nothing builds in this qube: no Rust, no libsecret headers, 8 GB RAM.

Run everything from the repo root, `/home/user/git/t3code`, on that branch. Only
`origin/main` is merged; local `main` is never touched.

## 1. Merge

```bash
git status --short          # must be clean apart from untracked scripts/package-server-deb.sh; otherwise stop and ask
git fetch origin main && git merge origin/main --no-edit
```

Conflicts land in the files the local commits touch: `ChatComposer.tsx` (imports: keep
both sides), `apps/*/src/cloud/publicConfig.ts` and `DesktopClerk.ts` (keep the
hard-disabled constants), `scripts/build-desktop-artifact.ts` (keep `homepage` and
`maintainer`). Resolve with the `resolving-merge-conflicts` skill; never abort.

## 2. Verify, then commit

`vp` is not on PATH and nvm's default Node cannot run the repo's `.ts` tooling:

```bash
export PATH=$HOME/.nvm/versions/node/v24.13.1/bin:$PWD/node_modules/.bin:$PATH
vp i                        # fresh clone without node_modules/.bin/vp: corepack pnpm install
for d in apps/web packages/contracts apps/server apps/desktop; do
  echo "== $d: $(cd $d && tsc --noEmit 2>&1 | grep -c 'error TS') errors"; done
(cd apps/server && vp test run src/server.test.ts)
(cd apps/web && vp test run --project unit src/components/chat/)
```

Pass = all four counts are 0 and both test runs are green. `tsc` also prints many
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
  --build-cmd 'export PATH=$HOME/.local/opt/node24/bin:$PATH PKG_CONFIG_PATH=$HOME/.local/opt/libsecret-dev/usr/lib/x86_64-linux-gnu/pkgconfig
               rm -rf release && corepack pnpm install --frozen-lockfile &&
               corepack pnpm exec node scripts/build-desktop-artifact.ts --platform linux --target $PKG_TARGET --arch x64' \
  --artifact 'release/*.$PKG_TARGET'
```

Run it from the repo root (the fetch lands in `./dist/` of the cwd) and in the
background or with a 10-minute tool timeout: push plus build takes about five minutes
and the default two-minute Bash timeout kills the local side. The remote side runs in a
detached tmux session and survives that; the log is `dist/.t3code-rpm-build.log`. Result:
`dist/T3-Code-$V-x86_64.rpm`. Native mode, fpm is never run. `.claude/worktrees` is
several GB and the default excludes do not cover it.

Then point the stable name at the new build (relative target, so the link stays valid
wherever `dist/` is mounted or copied):

```bash
ln -sfn T3-Code-$V-x86_64.rpm dist/T3-Code-latest-x86_64.rpm
```

`dist/T3-Code-latest-x86_64.rpm` always resolves to the newest build; older versioned
files stay alongside it.

`--frozen-lockfile` failing means the merge left `package.json` and `pnpm-lock.yaml`
disagreeing: fix the merge, do not drop the flag.

**libsecret on the build box.** The Linux build compiles a browser-secret C helper against
libsecret. eschdorf-ai (Kali) has the runtime library but `claude` has no sudo for
`libsecret-1-dev`, so the headers live user-locally and `PKG_CONFIG_PATH` above points at
them. If the preflight reports `libsecret development headers and pkg-config` missing,
recreate that directory:

```bash
ssh eschdorf-ai-claude 'set -e; D=$HOME/.local/opt/libsecret-dev; T=$(mktemp -d); cd $T
  apt-get download libsecret-1-dev; rm -rf $D; mkdir -p $D; dpkg -x ./libsecret-1-dev_*.deb $D
  PC=$D/usr/lib/x86_64-linux-gnu/pkgconfig
  sed -i -E "s|^prefix=/usr$|prefix=$D/usr|; /^(Requires|Libs)\.private:/d" $PC/*.pc
  ln -sfn /usr/lib/x86_64-linux-gnu/libsecret-1.so.0 $D/usr/lib/x86_64-linux-gnu/libsecret-1.so
  PKG_CONFIG_PATH=$PC pkg-config --exists libsecret-1 && echo ok; rm -rf $T'
```

The private requires only matter for static linking; the helper links dynamically
against the system `libsecret-1.so.0`. (`sudo apt install libsecret-1-dev` as the
operator account makes all of this unnecessary; the export is then harmless.)

## 4. Deliver

1. Refresh the template restore set so a rebuild ships this build, not the old one:
   `rm ~/git/qubes-backup/Fedora-Template/Packages/T3-Code-*.rpm && cp dist/T3-Code-$V-x86_64.rpm ~/git/qubes-backup/Fedora-Template/Packages/`
   (gitignored there; nothing to commit).
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
  `corepack pnpm exec`, and `~/.local/opt/node24` first on PATH.
- Skipping step 2 and packaging a merge that does not typecheck.
- Removing the old rpm in the template before installing. `dnf install` upgrades.

#!/usr/bin/env bash
# Build a headless T3 Code server .deb from this fork.
#
# Runs on the build box (Debian/Kali), not on the target. Produces a package
# that carries the server bundle, its runtime-external native closure, and a
# pinned Node runtime, so the target needs no Node setup of its own.
#
# Deliberately does not use `t3 service install`: that installs a pinned runtime
# with `npm install t3@<version>` from the public registry, which would run
# upstream instead of this fork (see apps/server/src/cloud/pinnedRuntime.ts).
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

NODE_HOME="${NODE_HOME:-$HOME/.local/opt/node24}"
OUT_DIR="${OUT_DIR:-$REPO_ROOT/dist}"
PREFIX=/opt/t3code-server
DATA_DIR=/var/lib/t3code
SVC_USER=t3code
ARCH=amd64

export PATH="$NODE_HOME/bin:$PATH"

VERSION="${T3CODE_SERVER_VERSION:-$(node -p "require('./apps/server/package.json').version")}"
echo "==> building t3code-server ${VERSION} (${ARCH})"

# 1. Web client, then the server bundle. resolveStaticDir (apps/server/src/config.ts)
#    resolves static assets from <bundle dir>/client at runtime and returns
#    undefined when that is missing, so a package without the client comes up
#    serving a working API and no UI at all.
echo "==> building the web client"
corepack pnpm --filter @t3tools/web run build

echo "==> building the server bundle"
corepack pnpm --filter t3 run build:bundle

[ -f apps/server/dist/bin.mjs ] || { echo "bundle missing: apps/server/dist/bin.mjs" >&2; exit 1; }
[ -f apps/web/dist/index.html ] || { echo "web client missing: apps/web/dist/index.html" >&2; exit 1; }

STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT
ROOT="$STAGE/root"
mkdir -p "$ROOT$PREFIX" "$ROOT/usr/bin" "$ROOT/lib/systemd/system" "$ROOT/etc/default" "$STAGE/root/DEBIAN"

# 2. Bundle + web client, without sourcemaps (they are ~19M of the payload).
echo "==> staging the bundle and web client"
rsync -a --exclude '*.map' apps/server/dist/ "$ROOT$PREFIX/dist/"
rsync -a --exclude '*.map' apps/web/dist/ "$ROOT$PREFIX/dist/client/"
[ -f "$ROOT$PREFIX/dist/client/index.html" ] || { echo "client staging failed" >&2; exit 1; }

# 3. Runtime-external native closure. bin.mjs is self-contained apart from the
#    packages Node loads from disk; see scripts/lib/cli-external-packages.ts.
echo "==> staging the native closure"
node -e '
const fs = require("node:fs");
const server = require("./apps/server/package.json");
const prefixes = ["node-pty","ffi-rs","@yuuang/","@ff-labs/","@msgpackr-extract/","msgpackr-extract","node-gyp-build","node-addon-api","detect-libc"];
const roots = Object.entries(server.dependencies ?? {}).filter(([n]) => prefixes.some((p) => n.startsWith(p)));
const pinned = Object.fromEntries(roots.map(([name, range]) => {
  // Prefer the version pnpm actually resolved so the package matches the lockfile.
  try { return [name, require(`${process.cwd()}/node_modules/${name}/package.json`).version]; }
  catch { return [name, range]; }
}));
fs.writeFileSync(process.argv[1], JSON.stringify({ name: "t3code-server-runtime", version: "0.0.0", private: true, dependencies: pinned }, null, 2));
console.log("    " + Object.entries(pinned).map(([n, v]) => `${n}@${v}`).join("\n    "));
' "$ROOT$PREFIX/package.json"

npm install --prefix "$ROOT$PREFIX" --omit=dev --no-audit --no-fund --loglevel=error

# 4. Pinned Node runtime, so the target needs nothing preinstalled.
echo "==> bundling the node runtime ($("$NODE_HOME/bin/node" --version))"
mkdir -p "$ROOT$PREFIX/bin"
cp "$NODE_HOME/bin/node" "$ROOT$PREFIX/bin/node"

# 5. CLI wrapper. Plain exec so `t3code-server pair`, `auth`, `serve` all work.
cat > "$ROOT/usr/bin/t3code-server" <<EOF
#!/bin/sh
exec $PREFIX/bin/node $PREFIX/dist/bin.mjs "\$@"
EOF
chmod 0755 "$ROOT/usr/bin/t3code-server"

# 6. Defaults file. Loopback by default; the admin opts into a reachable bind.
cat > "$ROOT/etc/default/t3code-server" <<'EOF'
# Interface for the T3 Code server to bind. Loopback until you change it.
# Prefer a trusted private address (a tailnet IP) over 0.0.0.0.
#T3CODE_HOST=100.64.0.2
#T3CODE_PORT=3773
#T3CODE_LOG_LEVEL=Info
EOF

# 7. systemd unit. OOMPolicy=continue is not incidental: agent tool calls are
#    children in this cgroup, and the default would stop the whole server when
#    the kernel kills one of them.
cat > "$ROOT/lib/systemd/system/t3code-server.service" <<EOF
[Unit]
Description=T3 Code server (local fork)
After=network-online.target
Wants=network-online.target
StartLimitIntervalSec=300
StartLimitBurst=5

[Service]
Type=simple
User=$SVC_USER
Group=$SVC_USER
WorkingDirectory=$DATA_DIR
Environment=T3CODE_HOME=$DATA_DIR
EnvironmentFile=-/etc/default/t3code-server
ExecStart=$PREFIX/bin/node $PREFIX/dist/bin.mjs serve
KillMode=mixed
OOMPolicy=continue
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF

# 8. Control metadata. Node is bundled, so the runtime deps are only what the
#    native addons and the checkpointing layer need.
INSTALLED_KB="$(du -sk "$ROOT" | cut -f1)"
cat > "$ROOT/DEBIAN/control" <<EOF
Package: t3code-server
Version: $VERSION
Architecture: $ARCH
Maintainer: T3 Code local build <t3code@localhost>
Section: devel
Priority: optional
Installed-Size: $INSTALLED_KB
Depends: libc6, libstdc++6, git, ca-certificates
Homepage: https://github.com/pingdotgg/t3code
Description: T3 Code headless server (local fork)
 Runs the T3 Code WebSocket/HTTP server without a desktop shell, so agents can
 be driven from the web or mobile clients over the network.
 .
 Ships a pinned Node runtime, so no system Node is required. Built from a local
 fork with T3 Connect disabled.
EOF

cat > "$ROOT/DEBIAN/conffiles" <<'EOF'
/etc/default/t3code-server
EOF

cat > "$ROOT/DEBIAN/postinst" <<EOF
#!/bin/sh
set -e
if [ "\$1" = configure ]; then
  if ! getent passwd $SVC_USER >/dev/null; then
    adduser --system --group --home $DATA_DIR --shell /usr/sbin/nologin \\
      --gecos "T3 Code server" $SVC_USER >/dev/null
  fi
  mkdir -p $DATA_DIR
  chown -R $SVC_USER:$SVC_USER $DATA_DIR
  chmod 0750 $DATA_DIR
  if [ -d /run/systemd/system ]; then
    systemctl daemon-reload
    systemctl enable t3code-server.service >/dev/null 2>&1 || true
    systemctl restart t3code-server.service || true
  fi
fi
exit 0
EOF

cat > "$ROOT/DEBIAN/prerm" <<'EOF'
#!/bin/sh
set -e
if [ "$1" = remove ] && [ -d /run/systemd/system ]; then
  systemctl stop t3code-server.service || true
  systemctl disable t3code-server.service >/dev/null 2>&1 || true
fi
exit 0
EOF

# Data outlives the package on purge: it holds the user's threads and history.
cat > "$ROOT/DEBIAN/postrm" <<EOF
#!/bin/sh
set -e
if [ -d /run/systemd/system ]; then systemctl daemon-reload || true; fi
if [ "\$1" = purge ]; then
  echo "t3code-server: leaving $DATA_DIR in place; remove it by hand if you meant to."
fi
exit 0
EOF

chmod 0755 "$ROOT/DEBIAN/postinst" "$ROOT/DEBIAN/prerm" "$ROOT/DEBIAN/postrm"

# 9. Build.
mkdir -p "$OUT_DIR"
DEB="$OUT_DIR/t3code-server_${VERSION}_${ARCH}.deb"
rm -f "$DEB"
dpkg-deb --build --root-owner-group "$ROOT" "$DEB" >/dev/null
echo "==> $DEB"
ls -lh "$DEB"

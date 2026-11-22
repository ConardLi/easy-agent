#!/bin/sh

set -eu

PACKAGE_NAME="eagent"
MIN_NODE_MAJOR=22
REQUESTED_VERSION="${EAGENT_VERSION:-latest}"

fail() {
  printf 'eagent installer: %s\n' "$1" >&2
  exit 1
}

if ! command -v node >/dev/null 2>&1; then
  fail "Node.js ${MIN_NODE_MAJOR} or newer is required. Install it with nvm or fnm, then run this installer again."
fi

node_version="$(node -p 'process.versions.node' 2>/dev/null)" ||
  fail "Unable to read the installed Node.js version."
node_major="${node_version%%.*}"

case "$node_major" in
  ''|*[!0-9]*) fail "Unable to parse the installed Node.js version: ${node_version}" ;;
esac

if [ "$node_major" -lt "$MIN_NODE_MAJOR" ]; then
  fail "Node.js ${MIN_NODE_MAJOR} or newer is required; found v${node_version}. Upgrade with nvm or fnm, then run this installer again."
fi

if ! command -v npm >/dev/null 2>&1; then
  fail "npm is required but was not found on PATH. Reinstall Node.js with nvm or fnm, then try again."
fi

package_spec="${PACKAGE_NAME}@${REQUESTED_VERSION}"
printf 'Installing %s with npm...\n' "$package_spec"
npm install -g --ignore-scripts "$package_spec"

if ! command -v eagent >/dev/null 2>&1; then
  npm_prefix="$(npm prefix -g 2>/dev/null || true)"
  if [ -n "$npm_prefix" ]; then
    fail "npm installed the package, but eagent is not on PATH. Add ${npm_prefix}/bin to PATH, open a new shell, and run eagent."
  fi
  fail "npm installed the package, but eagent is not on PATH. Add npm's global bin directory to PATH and open a new shell."
fi

installed_version="$(eagent --version 2>/dev/null || true)"
printf '\nInstalled %s successfully.\n' "${installed_version:-$package_spec}"
printf 'Next: run eagent --login to create a profile with one API Key, or set EASY_AGENT_PROTOCOL, EASY_AGENT_MODEL and EASY_AGENT_API_KEY.\n'
printf 'Upgrade: run this installer again.  Uninstall: npm uninstall -g eagent\n'

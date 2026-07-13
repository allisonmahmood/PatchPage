#!/usr/bin/env bash

set -euo pipefail

if [[ "${1:-}" == "--" ]]; then
  shift
fi

image="${1:-}"
expected_version="${2:-}"
expected_revision="${3:-}"

if [[ -z "$image" || -z "$expected_version" || -z "$expected_revision" ]]; then
  echo "usage: scripts/verify-server-image.sh IMAGE VERSION REVISION" >&2
  exit 2
fi

if ! command -v docker >/dev/null 2>&1; then
  echo "server image contract requires Docker, but the docker command is unavailable" >&2
  exit 127
fi

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
suffix="${GITHUB_RUN_ID:-local}-${GITHUB_RUN_ATTEMPT:-1}-$$"
inspect_container="patchpage-server-inspect-${suffix}"
runtime_container="patchpage-server-runtime-${suffix}"
data_volume="patchpage-server-data-${suffix}"
temp_dir="$(mktemp -d)"

cleanup() {
  docker rm -fv "$inspect_container" >/dev/null 2>&1 || true
  docker rm -f "$runtime_container" >/dev/null 2>&1 || true
  docker volume rm -f "$data_volume" >/dev/null 2>&1 || true
  rm -rf "$temp_dir"
}
trap cleanup EXIT

fail() {
  echo "server image contract failed: $*" >&2
  exit 1
}

label_value() {
  docker image inspect --format "{{ index .Config.Labels \"$1\" }}" "$image"
}

[[ "$(label_value org.opencontainers.image.source)" == "https://github.com/allisonmahmood/PatchPage" ]] ||
  fail "OCI source label is not the PatchPage repository"
[[ "$(label_value org.opencontainers.image.licenses)" == "MIT" ]] ||
  fail "OCI licenses label is not MIT"
[[ "$(label_value org.opencontainers.image.version)" == "$expected_version" ]] ||
  fail "OCI version label does not match $expected_version"
[[ "$(label_value org.opencontainers.image.revision)" == "$expected_revision" ]] ||
  fail "OCI revision label does not match $expected_revision"

configured_user="$(docker image inspect --format '{{.Config.User}}' "$image")"
case "$configured_user" in
  "" | root | 0 | 0:0) fail "runtime user is root or unspecified" ;;
esac

volume_config="$(docker image inspect --format '{{json .Config.Volumes}}' "$image")"
[[ "$volume_config" == *'"/data"'* ]] || fail "image does not declare /data as a volume"

image_env="$(docker image inspect --format '{{range .Config.Env}}{{println .}}{{end}}' "$image")"
for expected_env in \
  "NODE_ENV=production" \
  "PATCHPAGE_DB_FILE=/data/patchpage-db.json" \
  "PATCHPAGE_STORAGE_DIR=/data/drafts"; do
  grep -Fxq "$expected_env" <<<"$image_env" || fail "image is missing $expected_env"
done

docker create --name "$inspect_container" "$image" >/dev/null
docker cp "$inspect_container:/app/LICENSE" "$temp_dir/LICENSE"
cmp -s "$repo_root/LICENSE" "$temp_dir/LICENSE" ||
  fail "runtime LICENSE does not exactly match the repository LICENSE"
docker rm -v "$inspect_container" >/dev/null

docker run --rm -i --entrypoint node "$image" --input-type=module - <<'NODE'
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

function fail(message) {
  console.error(`server image contract failed: ${message}`);
  process.exit(1);
}

if (typeof process.getuid !== "function" || process.getuid() === 0) {
  fail("runtime command executes as root");
}

const allowedRootEntries = new Set(["LICENSE", "dist", "node_modules", "package.json"]);
for (const entry of fs.readdirSync("/app")) {
  if (!allowedRootEntries.has(entry)) {
    fail(`unexpected runtime root entry: /app/${entry}`);
  }
}

for (const forbiddenPath of [
  "/Dockerfile",
  "/apps",
  "/packages",
  "/pnpm-lock.yaml",
  "/pnpm-workspace.yaml",
  "/repo",
  "/src",
  "/tests",
  "/tsconfig.base.json",
  "/turbo.json",
  "/workspace",
  "/usr/local/bin/corepack",
  "/usr/local/bin/npm",
  "/usr/local/bin/npx",
  "/usr/local/bin/pnpm",
  "/usr/local/bin/pnpx",
  "/usr/local/bin/yarn",
  "/usr/local/bin/yarnpkg",
  "/usr/local/include/node",
  "/usr/local/lib/node_modules/corepack",
  "/usr/local/lib/node_modules/npm",
]) {
  if (fs.existsSync(forbiddenPath)) {
    fail(`runtime build tooling present: ${forbiddenPath}`);
  }
}
if (fs.existsSync("/opt") && fs.readdirSync("/opt").some((entry) => entry.startsWith("yarn-"))) {
  fail("runtime build tooling present under /opt");
}

const firstPartyRoots = ["/app/dist"];
for (const packageName of [
  "@patchpage/config",
  "@patchpage/core",
  "@patchpage/db",
  "@patchpage/storage",
]) {
  const entrypoint = fs.realpathSync(fileURLToPath(import.meta.resolve(packageName)));
  firstPartyRoots.push(path.dirname(path.dirname(entrypoint)));
}

for (const root of firstPartyRoots) {
  const pending = [root];
  while (pending.length > 0) {
    const current = pending.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const entryPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "src" || entry.name === "test" || entry.name === "tests") {
          fail(`first-party source/test directory present: ${entryPath}`);
        }
        pending.push(entryPath);
        continue;
      }

      if (
        entry.name === "Dockerfile" ||
        entry.name.startsWith("tsconfig") ||
        entry.name.includes(".test.") ||
        entry.name.endsWith(".ts") ||
        entry.name.endsWith(".map")
      ) {
        fail(`first-party build/source material present: ${entryPath}`);
      }
    }
  }
}

const virtualStore = fs.readdirSync("/app/node_modules/.pnpm");
for (const packagePrefix of [
  "@types+pg@",
  "esbuild@",
  "eslint@",
  "npm@",
  "prettier@",
  "tsx@",
  "turbo@",
  "typescript@",
  "vitest@",
]) {
  if (virtualStore.some((entry) => entry.startsWith(packagePrefix))) {
    fail(`development dependency present: ${packagePrefix.slice(0, -1)}`);
  }
}

const writeProbe = "/data/.patchpage-write-contract";
fs.writeFileSync(writeProbe, "ok\n", "utf8");
if (fs.readFileSync(writeProbe, "utf8") !== "ok\n") {
  fail("runtime user could not round-trip a write under /data");
}
fs.unlinkSync(writeProbe);
NODE

start_runtime_container() {
  docker run -d \
    --name "$runtime_container" \
    --mount "type=volume,source=${data_volume},target=/data" \
    -e PATCHPAGE_BOOTSTRAP_API_TOKEN=server-image-contract-token \
    -p 127.0.0.1::3000 \
    "$image" >/dev/null

  host_port="$(
    docker container inspect \
      --format '{{(index (index .NetworkSettings.Ports "3000/tcp") 0).HostPort}}' \
      "$runtime_container"
  )"
  [[ -n "$host_port" ]] || fail "Docker did not publish the server port"
}

wait_for_health() {
  local healthy=""
  for _ in {1..60}; do
    body="$(curl -fsS "http://127.0.0.1:${host_port}/healthz" 2>/dev/null || true)"
    if [[ "$body" == '{"ok":true}' ]]; then
      healthy="true"
      break
    fi
    sleep 1
  done

  if [[ "$healthy" != "true" ]]; then
    docker logs "$runtime_container" >&2 || true
    fail "GET /healthz did not return the exact expected response"
  fi
}

verify_persisted_drivers() {
  docker exec "$runtime_container" node -e '
    const fs = require("node:fs");
    const path = require("node:path");
    const state = JSON.parse(fs.readFileSync("/data/patchpage-db.json", "utf8"));
    if (!Array.isArray(state.drafts) || state.drafts.length === 0) process.exit(1);
    if (!Array.isArray(state.draftVersions) || state.draftVersions.length === 0) process.exit(1);

    const pending = ["/data/drafts"];
    let found = false;
    while (pending.length > 0) {
      const current = pending.pop();
      for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
        const entryPath = path.join(current, entry.name);
        if (entry.isDirectory()) pending.push(entryPath);
        if (entry.isFile() && entry.name.endsWith(".html")) found = true;
      }
    }
    if (!found) process.exit(1);
  ' || fail "JSON metadata or filesystem HTML did not persist under /data"
}

docker volume create "$data_volume" >/dev/null
host_port=""
start_runtime_container
wait_for_health

docker exec "$runtime_container" node -e '
  const fs = require("node:fs");
  const status = fs.readFileSync("/proc/1/status", "utf8");
  const uid = Number(status.match(/^Uid:\s+(\d+)/m)?.[1]);
  if (!Number.isInteger(uid) || uid === 0) process.exit(1);
  JSON.parse(fs.readFileSync("/data/patchpage-db.json", "utf8"));
' || fail "service process is root or JSON metadata is not writable under /data"

upload_status="$(
  curl -sS \
    -o "$temp_dir/upload-response.json" \
    -w '%{http_code}' \
    -X POST "http://127.0.0.1:${host_port}/api/uploads" \
    -H 'Authorization: Bearer server-image-contract-token' \
    -H 'Content-Type: application/json' \
    --data '{"html":"<!doctype html><html><head><title>Image contract</title></head><body>patchpage-persisted-body-marker</body></html>","filename":"image-contract.html"}'
)"
[[ "$upload_status" == "201" ]] || {
  cat "$temp_dir/upload-response.json" >&2
  fail "filesystem-backed upload returned HTTP $upload_status"
}

verify_persisted_drivers

docker rm -f "$runtime_container" >/dev/null
start_runtime_container
wait_for_health
verify_persisted_drivers

draft_id="$(
  docker exec "$runtime_container" node -e '
    const fs = require("node:fs");
    const state = JSON.parse(fs.readFileSync("/data/patchpage-db.json", "utf8"));
    process.stdout.write(state.drafts[0]?.id ?? "");
  '
)"
[[ -n "$draft_id" ]] || fail "persisted JSON metadata has no draft ID after remount"
viewer_body="$(curl -fsS "http://127.0.0.1:${host_port}/d/${draft_id}")" ||
  fail "persisted draft was not readable after remount"
[[ "$viewer_body" == *"patchpage-persisted-body-marker"* ]] ||
  fail "persisted draft content changed after remount"

echo "Verified server image $image ($expected_version, $expected_revision)."

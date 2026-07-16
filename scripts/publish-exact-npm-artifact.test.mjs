import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import { fileURLToPath } from "node:url";
import path from "node:path";
import test from "node:test";
import {
  ExactPublisherError,
  POSTPUBLISH_MAX_ATTEMPTS,
  publishExactNpmArtifact
} from "./publish-exact-npm-artifact.mjs";

const PACKAGE_NAME = "patchpage";
const PACKAGE_VERSION = "1.2.3";
const NPM_VERSION = "11.18.0";
const AUTH_KEY = "//registry.npmjs.org/:_authToken";

function digest(buffer, algorithm, encoding) {
  return createHash(algorithm).update(buffer).digest(encoding);
}

function response(status, body) {
  return {
    status,
    async json() {
      return body;
    }
  };
}

function safeRegistryManifest(tarball, overrides = {}) {
  return {
    name: PACKAGE_NAME,
    version: PACKAGE_VERSION,
    dist: {
      integrity: `sha512-${digest(tarball, "sha512", "base64")}`,
      attestations: {
        url: "https://registry.npmjs.org/-/npm/v1/attestations/patchpage@1.2.3",
        provenance: { predicateType: "https://slsa.dev/provenance/v1" }
      }
    },
    _npmOperationalInternal: { host: "registry-storage", tmp: "tmp/package_opaque" },
    ...overrides
  };
}

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "exact-npm-publisher-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const tarball = Buffer.from("exact reviewed tarball bytes\n", "utf8");
  const filename = "patchpage-1.2.3-run-attempt-1.tgz";
  const tarballPath = path.join(root, filename);
  const npmCliDir = path.join(root, "npm-cli");
  await mkdir(npmCliDir);
  await writeFile(tarballPath, tarball);
  await writeFile(
    path.join(npmCliDir, "package.json"),
    JSON.stringify({ name: "npm", version: NPM_VERSION })
  );
  return {
    npmCliDir,
    options: {
      tarball: tarballPath,
      "expected-filename": filename,
      "expected-sha256": digest(tarball, "sha256", "hex"),
      "expected-name": PACKAGE_NAME,
      "expected-version": PACKAGE_VERSION,
      "expected-npm-version": NPM_VERSION,
      "npm-cli-dir": npmCliDir
    },
    tarball
  };
}

function publishingModules({ onPublish = () => {} } = {}) {
  return {
    pacote: {
      async manifest(tarballPath) {
        return {
          name: PACKAGE_NAME,
          version: PACKAGE_VERSION,
          description: "safe package metadata",
          _resolved: tarballPath,
          _from: `file:${tarballPath}`,
          _integrity: "transport-only"
        };
      }
    },
    async oidc({ opts, config }) {
      assert.equal(config.isDefault("provenance"), false);
      config.set(AUTH_KEY, "opaque-registry-credential", "user");
      assert.equal(opts[AUTH_KEY], "opaque-registry-credential");
    },
    async publish(manifest, tarball, opts) {
      onPublish(manifest, tarball, opts);
    }
  };
}

async function publisherError(promise, category) {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof ExactPublisherError);
    assert.equal(error.category, category);
    return error;
  }
  assert.fail("expected exact publisher failure");
}

test("removes pacote transport metadata and passes the byte-identical Buffer", async (t) => {
  const { options, tarball } = await fixture(t);
  let publishCalls = 0;
  let capturedManifest;
  let capturedTarball;
  const firstReadBuffer = Buffer.from(tarball);
  const confirmationReadBuffer = Buffer.from(tarball);
  const readBuffers = [firstReadBuffer, confirmationReadBuffer];
  const fetchResponses = [
    response(404),
    response(200, { versions: { "1.0.0": {} } }),
    response(200, safeRegistryManifest(tarball))
  ];
  const result = await publishExactNpmArtifact(options, {
    fetch: async (_url, request) => {
      assert.ok(request.signal instanceof AbortSignal);
      return fetchResponses.shift();
    },
    modules: publishingModules({
      onPublish(manifest, publishedTarball, opts) {
        publishCalls += 1;
        capturedManifest = manifest;
        capturedTarball = publishedTarball;
        assert.equal(opts.access, "public");
        assert.equal(opts.provenance, true);
        assert.equal(opts.npmVersion, NPM_VERSION);
      }
    }),
    readTarball: async () => readBuffers.shift(),
    sleep: async () => assert.fail("successful first postpublish query must not sleep")
  });

  assert.deepEqual(result, { status: "published" });
  assert.equal(publishCalls, 1);
  assert.deepEqual(capturedManifest, {
    name: PACKAGE_NAME,
    version: PACKAGE_VERSION,
    description: "safe package metadata"
  });
  assert.strictEqual(capturedTarball, firstReadBuffer);
  assert.notStrictEqual(firstReadBuffer, confirmationReadBuffer);
});

test("rejects a mismatched expected artifact digest before privileged work", async (t) => {
  const { options } = await fixture(t);
  await publisherError(
    publishExactNpmArtifact(
      { ...options, "expected-sha256": "0".repeat(64) },
      {
        fetch: async () => assert.fail("must not query the registry"),
        modules: publishingModules({
          onPublish: () => assert.fail("must not publish")
        })
      }
    ),
    "artifact-validation"
  );
});

for (const [field, value] of [
  ["name", "different-package"],
  ["version", "9.9.9"]
]) {
  test(`rejects a mismatched package ${field} before privileged work`, async (t) => {
    const { options } = await fixture(t);
    const modules = publishingModules({
      onPublish: () => assert.fail("must not publish")
    });
    modules.pacote.manifest = async () => ({
      name: PACKAGE_NAME,
      version: PACKAGE_VERSION,
      [field]: value
    });
    modules.oidc = async () => assert.fail("must not request credentials");

    await publisherError(
      publishExactNpmArtifact(options, {
        fetch: async () => assert.fail("must not query the registry"),
        modules
      }),
      "manifest-validation"
    );
  });
}

test("a matching safe published version skips OIDC and publication", async (t) => {
  const { options, tarball } = await fixture(t);
  const modules = publishingModules({
    onPublish: () => assert.fail("must not publish a safe rerun")
  });
  modules.oidc = async () => assert.fail("must not request credentials for a safe rerun");
  const result = await publishExactNpmArtifact(options, {
    fetch: async () => response(200, safeRegistryManifest(tarball)),
    modules
  });
  assert.deepEqual(result, { status: "already-published" });
});

test("a published version with mismatched integrity fails closed", async (t) => {
  const { options, tarball } = await fixture(t);
  const metadata = safeRegistryManifest(tarball);
  metadata.dist.integrity = "sha512-AAAAAAAA";
  const error = await publisherError(
    publishExactNpmArtifact(options, {
      fetch: async () => response(200, metadata),
      modules: publishingModules({ onPublish: () => assert.fail("must not publish") })
    }),
    "registry-integrity"
  );
  assert.equal(error.message.includes(metadata.dist.integrity), false);
});

test("a published version without provenance fails closed", async (t) => {
  const { options, tarball } = await fixture(t);
  const metadata = safeRegistryManifest(tarball);
  delete metadata.dist.attestations;
  await publisherError(
    publishExactNpmArtifact(options, {
      fetch: async () => response(200, metadata),
      modules: publishingModules({ onPublish: () => assert.fail("must not publish") })
    }),
    "registry-provenance"
  );
});

for (const [label, secretValue] of [
  ["local runner paths", "/Users/private-runner/work/package.tgz"],
  ["private artifact markers", "session-export.json"]
]) {
  test(`${label} in complete registry metadata fail opaquely`, async (t) => {
    const { options, tarball } = await fixture(t);
    const metadata = safeRegistryManifest(tarball, { unexpected: { value: secretValue } });
    const error = await publisherError(
      publishExactNpmArtifact(options, {
        fetch: async () => response(200, metadata),
        modules: publishingModules({ onPublish: () => assert.fail("must not publish") })
      }),
      "registry-metadata"
    );
    assert.equal(error.message.includes(secretValue), false);
  });
}

test("rejects an implicit latest tag that would move backward", async (t) => {
  const { options } = await fixture(t);
  const fetchResponses = [
    response(404),
    response(200, {
      versions: {
        "2.0.0": {},
        "3.0.0-alpha.1": {},
        "4.0.0": { deprecated: "superseded" }
      }
    })
  ];
  const modules = publishingModules({
    onPublish: () => assert.fail("must not publish")
  });
  modules.oidc = async () => assert.fail("must not request credentials");

  await publisherError(
    publishExactNpmArtifact(options, {
      fetch: async () => fetchResponses.shift(),
      modules
    }),
    "latest-tag"
  );
});

test("postpublish polling has a strict attempt bound", async (t) => {
  const { options } = await fixture(t);
  let queries = 0;
  let sleeps = 0;
  let publishes = 0;
  await publisherError(
    publishExactNpmArtifact(options, {
      fetch: async () => {
        queries += 1;
        return response(404);
      },
      modules: publishingModules({ onPublish: () => (publishes += 1) }),
      sleep: async () => {
        sleeps += 1;
      }
    }),
    "postpublish-verification"
  );
  assert.equal(publishes, 1);
  assert.equal(queries, 2 + POSTPUBLISH_MAX_ATTEMPTS);
  assert.equal(sleeps, POSTPUBLISH_MAX_ATTEMPTS - 1);
});

test("the CLI executes through direct and symlinked entrypoints", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "exact-npm-publisher-cli-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const sourceEntrypoint = fileURLToPath(
    new URL("./publish-exact-npm-artifact.mjs", import.meta.url)
  );
  const linkedEntrypoint = path.join(root, "publisher.mjs");
  await symlink(sourceEntrypoint, linkedEntrypoint);

  for (const entrypoint of [sourceEntrypoint, linkedEntrypoint]) {
    const result = spawnSync(process.execPath, [entrypoint], { encoding: "utf8" });
    assert.equal(result.status, 1);
    assert.equal(result.stdout, "");
    assert.equal(result.stderr, "::error::exact npm publisher: invalid-input\n");
  }
});

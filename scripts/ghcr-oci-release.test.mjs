import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";
import {
  compareSemver,
  isSupportedImageRelease,
  MINIMUM_SUPPORTED_IMAGE_VERSION,
  MAX_CONFIG_BYTES,
} from "./ghcr-oci-release.mjs";

const repoRoot = path.resolve(import.meta.dirname, "..");
const cli = path.join(repoRoot, "scripts/ghcr-oci-release.mjs");
const name = "allisonmahmood/patchpage-server";

function sha256(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

function jsonBuffer(value) {
  return Buffer.from(JSON.stringify(value), "utf8");
}

function tarHeader(entryName, size, type = "0") {
  const header = Buffer.alloc(512);
  header.write(entryName, 0, 100, "utf8");
  header.write("0000644\0", 100, 8, "ascii");
  header.write("0000000\0", 108, 8, "ascii");
  header.write("0000000\0", 116, 8, "ascii");
  header.write(size.toString(8).padStart(11, "0") + "\0", 124, 12, "ascii");
  header.write("00000000000\0", 136, 12, "ascii");
  header.fill(" ", 148, 156);
  header.write(type, 156, 1, "ascii");
  header.write("ustar\0", 257, 6, "ascii");
  header.write("00", 263, 2, "ascii");
  let checksum = 0;
  for (const byte of header) checksum += byte;
  header.write(checksum.toString(8).padStart(6, "0") + "\0 ", 148, 8, "ascii");
  return header;
}

function tarEntry(entryName, body = Buffer.alloc(0), type = "0") {
  const data = Buffer.isBuffer(body) ? body : Buffer.from(body);
  const padding = Buffer.alloc((512 - (data.length % 512)) % 512);
  return Buffer.concat([tarHeader(entryName, type === "5" ? 0 : data.length, type), data, padding]);
}

function legacyConfig(v1Config, id, parent) {
  const body = { id };
  if (parent) body.parent = parent;
  Object.assign(body, v1Config);
  return Buffer.from(JSON.stringify(body), "utf8");
}

function emptyMobyContainerConfig() {
  return {
    Hostname: "",
    Domainname: "",
    User: "",
    AttachStdin: false,
    AttachStdout: false,
    AttachStderr: false,
    Tty: false,
    OpenStdin: false,
    StdinOnce: false,
    Env: null,
    Cmd: null,
    Image: "",
    Volumes: null,
    WorkingDir: "",
    Entrypoint: null,
    OnBuild: null,
    Labels: null,
  };
}

function mobyRuntimeConfig(runtimeConfig) {
  return {
    Hostname: "",
    Domainname: "",
    User: "",
    AttachStdin: false,
    AttachStdout: false,
    AttachStderr: false,
    Tty: false,
    OpenStdin: false,
    StdinOnce: false,
    Env: null,
    Cmd: null,
    ArgsEscaped: true,
    Image: "",
    Volumes: null,
    WorkingDir: "",
    Entrypoint: null,
    OnBuild: null,
    Labels: runtimeConfig.Labels,
  };
}

function dockerSaveTar(version, revision, flavor = "local") {
  const layers = [
    Buffer.from(`layer-${flavor}-one\n`, "utf8"),
    Buffer.from(`layer-${flavor}-two\n`, "utf8"),
  ];
  const layerDigests = layers.map((layer) => `sha256:${sha256(layer)}`);
  const configValue = {
    created: "1970-01-01T00:00:00Z",
    architecture: "amd64",
    os: "linux",
    config: {
      Labels: {
        "org.opencontainers.image.version": version,
        "org.opencontainers.image.revision": revision,
        "org.opencontainers.image.flavor": flavor,
      },
    },
    rootfs: {
      type: "layers",
      diff_ids: layerDigests,
    },
  };
  const config = jsonBuffer(configValue);
  const configDigest = `sha256:${sha256(config)}`;
  const manifest = jsonBuffer({
    schemaVersion: 2,
    mediaType: "application/vnd.oci.image.manifest.v1+json",
    config: {
      mediaType: "application/vnd.oci.image.config.v1+json",
      digest: configDigest,
      size: config.length,
    },
    layers: layers.map((layer, index) => ({
        mediaType: "application/vnd.oci.image.layer.v1.tar",
        digest: layerDigests[index],
        size: layer.length,
      })),
  });
  const manifestDigest = `sha256:${sha256(manifest)}`;
  const repoTag = `ghcr.io/${name}:${version}`;
  const configPath = `blobs/sha256/${configDigest.slice("sha256:".length)}`;
  const layerPaths = layerDigests.map((digest) => `blobs/sha256/${digest.slice("sha256:".length)}`);
  const manifestPath = `blobs/sha256/${manifestDigest.slice("sha256:".length)}`;
  const legacyLayerConfigs = [];
  for (let index = 0; index < layerDigests.length; index += 1) {
    const parent = legacyLayerConfigs.at(-1)?.id ?? "";
    const v1Config =
      index === layerDigests.length - 1
        ? {
            created: configValue.created,
            container_config: emptyMobyContainerConfig(),
            config: mobyRuntimeConfig(configValue.config),
            architecture: configValue.architecture,
            os: configValue.os,
          }
        : {
            created: "1970-01-01T00:00:00Z",
            container_config: emptyMobyContainerConfig(),
            os: configValue.os,
          };
    const id = sha256(Buffer.from(`opaque-legacy-id-${flavor}-${index}`, "utf8"));
    const body = legacyConfig(v1Config, id, parent);
    legacyLayerConfigs.push({
      id,
      path: `blobs/sha256/${sha256(body)}`,
      body,
    });
  }
  const tar = Buffer.concat([
    tarEntry("blobs/", Buffer.alloc(0), "5"),
    tarEntry("blobs/sha256/", Buffer.alloc(0), "5"),
    tarEntry("manifest.json", jsonBuffer([{ Config: configPath, RepoTags: [repoTag], Layers: layerPaths }])),
    tarEntry("repositories", jsonBuffer({ [`ghcr.io/${name}`]: { [version]: layerDigests.at(-1).slice("sha256:".length) } })),
    tarEntry("oci-layout", jsonBuffer({ imageLayoutVersion: "1.0.0" })),
    tarEntry("index.json", jsonBuffer({
      schemaVersion: 2,
      manifests: [
        {
          mediaType: "application/vnd.oci.image.manifest.v1+json",
          digest: manifestDigest,
          size: manifest.length,
          annotations: { "org.opencontainers.image.ref.name": version },
        },
      ],
    })),
    tarEntry(configPath, config),
    ...layers.map((layer, index) => tarEntry(layerPaths[index], layer)),
    tarEntry(manifestPath, manifest),
    ...legacyLayerConfigs.map((legacy) => tarEntry(legacy.path, legacy.body)),
    Buffer.alloc(1024),
  ]);
  return { configDigest, manifest, manifestDigest, tar };
}

function image(version, revision, flavor) {
  const labels = {
    "org.opencontainers.image.version": version,
    "org.opencontainers.image.revision": revision,
  };
  if (flavor) labels["org.opencontainers.image.flavor"] = flavor;
  const config = jsonBuffer({
    config: {
      Labels: labels,
    },
  });
  const configDigest = `sha256:${sha256(config)}`;
  const manifest = jsonBuffer({
    schemaVersion: 2,
    mediaType: "application/vnd.oci.image.manifest.v1+json",
    config: {
      mediaType: "application/vnd.oci.image.config.v1+json",
      digest: configDigest,
      size: config.length,
    },
    layers: [
      {
        mediaType: "application/vnd.oci.image.layer.v1.tar",
        digest: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        size: 1,
      },
    ],
  });
  return {
    config,
    configDigest,
    manifest,
    manifestDigest: `sha256:${sha256(manifest)}`,
    revision,
    version,
  };
}
function imageWithConfig(version, revision, config, declaredSize = config.length) {
  const base = image(version, revision);
  const configDigest = `sha256:${sha256(config)}`;
  const manifestValue = JSON.parse(base.manifest.toString("utf8"));
  manifestValue.config = {
    ...manifestValue.config,
    digest: configDigest,
    size: declaredSize,
  };
  const manifest = jsonBuffer(manifestValue);
  return {
    ...base,
    config,
    configDigest,
    manifest,
    manifestDigest: `sha256:${sha256(manifest)}`,
  };
}


async function withRegistry(route, fn) {
  const requests = [];
  const server = http.createServer((request, response) => {
    requests.push(`${request.method} ${request.url}`);
    route(request, response);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  try {
    await fn(`http://127.0.0.1:${port}`, requests);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

function sendJson(response, status, body, headers = {}) {
  response.writeHead(status, {
    "content-type": "application/json",
    ...headers,
  });
  response.end(JSON.stringify(body));
}

function sendManifest(response, entry, headers = {}) {
  response.writeHead(200, {
    "content-type": "application/vnd.oci.image.manifest.v1+json",
    "docker-content-digest": entry.manifestDigest,
    ...headers,
  });
  response.end(entry.manifest);
}

function sendConfig(response, entry, headers = {}) {
  response.writeHead(200, {
    "content-type": "application/octet-stream",
    ...headers,
  });
  response.end(entry.config);
}

function manifestUnknown(response, reference, detail = { name, revision: reference }) {
  return sendJson(response, 404, {
    errors: [{ code: "MANIFEST_UNKNOWN", message: "manifest unknown", detail }],
  });
}

function runCli(args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [cli, ...args], {
      cwd: repoRoot,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("close", (status) => {
      resolve({ status, stdout, stderr });
    });
  });
}

test("compares arbitrarily large stable semver components without precision loss", () => {
  assert.equal(
    compareSemver("9007199254740993.0.0", "9007199254740992.999.999"),
    1,
  );
  assert.equal(
    compareSemver("1.9007199254740992.0", "1.9007199254740993.0"),
    -1,
  );
});
test("ignores legacy image tags while retaining supported missing releases for reconciliation", () => {
  const missingStableTags = ["v0.1.0", "v0.1.1", "v0.2.0"];
  const reconciliationCandidates = missingStableTags.filter((tag) =>
    isSupportedImageRelease(tag.slice(1)),
  );

  assert.equal(MINIMUM_SUPPORTED_IMAGE_VERSION, "0.1.1");
  assert.deepEqual(reconciliationCandidates, ["v0.1.1", "v0.2.0"]);
});


test("ignores an incomplete legacy release while selecting a supported complete release", async () => {
  const oldImage = image("0.1.0", "1111111111111111111111111111111111111111");
  const newImage = image("0.2.0", "2222222222222222222222222222222222222222");
  const byTag = new Map([
    ["0.1.0", oldImage],
    ["0.2.0", newImage],
    [newImage.revision, newImage],
  ]);

  await withRegistry((request, response) => {
    const url = new URL(request.url, "http://registry.test");
    if (request.method === "GET" && url.pathname === `/v2/${name}/tags/list`) {
      if (!url.searchParams.has("last")) {
        return sendJson(
          response,
          200,
          { name, tags: ["0.1.0", oldImage.revision] },
          { link: `</v2/${name}/tags/list?last=${oldImage.revision}&n=2>; rel="next"` },
        );
      }
      return sendJson(response, 200, { name, tags: ["0.2.0", newImage.revision] });
    }

    const manifestMatch = url.pathname.match(
      new RegExp(`^/v2/${name}/manifests/([^/]+)$`),
    );
    if (request.method === "GET" && manifestMatch) {
      const target = decodeURIComponent(manifestMatch[1]);
      const entry = byTag.get(target);
      assert.ok(entry, `unexpected manifest target ${target}`);
      response.writeHead(200, {
        "content-type": "application/vnd.oci.image.manifest.v1+json",
        "docker-content-digest": entry.manifestDigest,
      });
      response.end(entry.manifest);
      return;
    }

    const blobMatch = url.pathname.match(new RegExp(`^/v2/${name}/blobs/(sha256:.+)$`));
    if (request.method === "GET" && blobMatch) {
      const entry = [...byTag.values()].find(
        (candidate) => candidate.configDigest === decodeURIComponent(blobMatch[1]),
      );
      assert.ok(entry, `unexpected blob target ${blobMatch[1]}`);
      response.writeHead(200, { "content-type": "application/octet-stream" });
      response.end(entry.config);
      return;
    }

    response.writeHead(500);
    response.end(`unexpected ${request.method} ${request.url}`);
  }, async (registryUrl, requests) => {
    const result = await runCli(["select-latest", "--registry-url", registryUrl, "--name", name]);

    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), {
      version: "0.2.0",
      revision: newImage.revision,
      manifestDigest: newImage.manifestDigest,
      configDigest: newImage.configDigest,
    });
    assert.ok(
      requests.includes(`GET /v2/${name}/tags/list?n=100`),
      "first tag page was requested",
    );
    assert.ok(
      requests.includes(`GET /v2/${name}/tags/list?last=${oldImage.revision}&n=2`),
      "RFC Link page was followed",
    );
  });
});

test("updates stale and absent latest tags to the highest supported complete release", async (t) => {
  for (const [scenario, initialLatest] of [
    ["stale", true],
    ["absent", false],
  ]) {
    await t.test(scenario, async () => {
      const oldImage = image("0.1.1", "1111111111111111111111111111111111111111");
      const newImage = image("0.2.0", "2222222222222222222222222222222222222222");
      const byTag = new Map([
        ["0.1.1", oldImage],
        [oldImage.revision, oldImage],
        ["0.2.0", newImage],
        [newImage.revision, newImage],
      ]);
      if (initialLatest) byTag.set("latest", oldImage);
      const puts = [];

      await withRegistry((request, response) => {
        const url = new URL(request.url, "http://registry.test");
        if (request.method === "GET" && url.pathname === `/v2/${name}/tags/list`) {
          return sendJson(response, 200, { name, tags: [...byTag.keys()] });
        }

        const manifestMatch = url.pathname.match(
          new RegExp(`^/v2/${name}/manifests/([^/]+)$`),
        );
        if (request.method === "GET" && manifestMatch) {
          const target = decodeURIComponent(manifestMatch[1]);
          const entry = byTag.get(target);
          if (!entry) {
            return manifestUnknown(response, target, { repository: name, reference: target });
          }
          return sendManifest(response, entry);
        }
        if (request.method === "PUT" && manifestMatch) {
          const target = decodeURIComponent(manifestMatch[1]);
          const chunks = [];
          request.on("data", (chunk) => chunks.push(chunk));
          request.on("end", () => {
            const body = Buffer.concat(chunks);
            puts.push({ target, body });
            assert.equal(target, "latest");
            assert.deepEqual(body, newImage.manifest);
            byTag.set("latest", newImage);
            response.writeHead(201, { "docker-content-digest": newImage.manifestDigest });
            response.end();
          });
          return;
        }

        const blobMatch = url.pathname.match(new RegExp(`^/v2/${name}/blobs/(sha256:.+)$`));
        if (request.method === "GET" && blobMatch) {
          const entry = [...byTag.values()].find(
            (candidate) => candidate.configDigest === decodeURIComponent(blobMatch[1]),
          );
          assert.ok(entry, `unexpected blob target ${blobMatch[1]}`);
          return sendConfig(response, entry);
        }

        response.writeHead(500);
        response.end(`unexpected ${request.method} ${request.url}`);
      }, async (registryUrl) => {
        const result = await runCli([
          "reconcile-latest",
          "--registry-url",
          registryUrl,
          "--name",
          name,
        ]);

        assert.equal(result.status, 0, result.stderr);
        assert.deepEqual(JSON.parse(result.stdout), {
          version: "0.2.0",
          revision: newImage.revision,
          manifestDigest: newImage.manifestDigest,
          configDigest: newImage.configDigest,
          latest: "updated",
        });
        assert.equal(puts.length, 1);
      });
    });
  }
});
test("anonymously binds a supported semver and full revision pair to one digest", async () => {
  const version = "0.1.1";
  const revision = "3333333333333333333333333333333333333333";
  const release = image(version, revision);
  const byTag = new Map([
    [version, release],
    [revision, release],
  ]);

  await withRegistry((request, response) => {
    assert.equal(request.headers.authorization, undefined);
    const url = new URL(request.url, "http://registry.test");
    const manifestMatch = url.pathname.match(
      new RegExp(`^/v2/${name}/manifests/([^/]+)$`),
    );
    if (request.method === "GET" && manifestMatch) {
      const target = decodeURIComponent(manifestMatch[1]);
      const entry = byTag.get(target);
      assert.ok(entry, `unexpected manifest target ${target}`);
      return sendManifest(response, entry);
    }

    const blobMatch = url.pathname.match(new RegExp(`^/v2/${name}/blobs/(sha256:.+)$`));
    if (request.method === "GET" && blobMatch) {
      assert.equal(decodeURIComponent(blobMatch[1]), release.configDigest);
      return sendConfig(response, release);
    }

    response.writeHead(500);
    response.end(`unexpected ${request.method} ${request.url}`);
  }, async (registryUrl) => {
    const result = await runCli([
      "inspect-release",
      "--registry-url",
      registryUrl,
      "--name",
      name,
      "--version",
      version,
      "--revision",
      revision,
    ]);

    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), {
      version,
      revision,
      status: "complete",
      manifestDigest: release.manifestDigest,
      configDigest: release.configDigest,
    });
  });
});


test("adopts one existing release tag as canonical and repairs its mate", async () => {
  const version = "0.3.0";
  const revision = "3333333333333333333333333333333333333333";
  const remoteImage = image(version, revision);
  const local = dockerSaveTar(version, revision, "rebuilt");
  const byTag = new Map([[version, remoteImage]]);
  const puts = [];
  const tmp = await mkdtemp(path.join(os.tmpdir(), "patchpage-oci-release-"));
  try {
    const tarPath = path.join(tmp, "image.tar");
    await writeFile(tarPath, local.tar);

    await withRegistry((request, response) => {
      const url = new URL(request.url, "http://registry.test");
      if (request.method === "GET" && url.pathname === `/v2/${name}/tags/list`) {
        return sendJson(response, 200, { name, tags: [version] });
      }

      const manifestMatch = url.pathname.match(
        new RegExp(`^/v2/${name}/manifests/([^/]+)$`),
      );
      if (request.method === "GET" && manifestMatch) {
        const target = decodeURIComponent(manifestMatch[1]);
        const entry = byTag.get(target);
        if (!entry) {
          return sendJson(response, 404, {
            errors: [{ code: "MANIFEST_UNKNOWN", message: "manifest unknown" }],
          });
        }
        response.writeHead(200, {
          "content-type": "application/vnd.oci.image.manifest.v1+json",
          "docker-content-digest": entry.manifestDigest,
        });
        response.end(entry.manifest);
        return;
      }
      if (request.method === "PUT" && manifestMatch) {
        const target = decodeURIComponent(manifestMatch[1]);
        const chunks = [];
        request.on("data", (chunk) => chunks.push(chunk));
        request.on("end", () => {
          const body = Buffer.concat(chunks);
          puts.push({ target, body });
          assert.equal(target, revision);
          assert.deepEqual(body, remoteImage.manifest);
          byTag.set(revision, remoteImage);
          response.writeHead(201, { "docker-content-digest": remoteImage.manifestDigest });
          response.end();
        });
        return;
      }

      const blobMatch = url.pathname.match(new RegExp(`^/v2/${name}/blobs/(sha256:.+)$`));
      if (request.method === "GET" && blobMatch) {
        const entry = remoteImage.configDigest === decodeURIComponent(blobMatch[1])
          ? remoteImage
          : null;
        assert.ok(entry, `unexpected blob target ${blobMatch[1]}`);
        response.writeHead(200, { "content-type": "application/octet-stream" });
        response.end(entry.config);
        return;
      }

      response.writeHead(500);
      response.end(`unexpected ${request.method} ${request.url}`);
    }, async (registryUrl) => {
      const result = await runCli([
        "publish-release",
        "--registry-url",
        registryUrl,
        "--name",
        name,
        "--version",
        version,
        "--revision",
        revision,
        "--image-tar",
        tarPath,
        "--expected-repo-tag",
        `ghcr.io/${name}:${version}`,
        "--expected-config-id",
        local.configDigest,
      ]);

      assert.equal(result.status, 0, result.stderr);
      assert.deepEqual(JSON.parse(result.stdout), {
        version,
        revision,
        manifestDigest: remoteImage.manifestDigest,
        configDigest: remoteImage.configDigest,
        canonical: "remote",
        repaired: [revision],
      });
      assert.equal(puts.length, 1);
    });
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test("re-reads both release tags and rejects divergence after repairing a pair", async () => {
  const version = "0.3.1";
  const revision = "3434343434343434343434343434343434343434";
  const canonicalImage = image(version, revision, "canonical");
  const divergentImage = image(version, revision, "external-writer");
  const local = dockerSaveTar(version, revision, "rebuilt");
  let semverReads = 0;
  let revisionState = null;
  const tmp = await mkdtemp(path.join(os.tmpdir(), "patchpage-oci-release-"));
  try {
    const tarPath = path.join(tmp, "image.tar");
    await writeFile(tarPath, local.tar);

    await withRegistry((request, response) => {
      const url = new URL(request.url, "http://registry.test");
      const manifestMatch = url.pathname.match(
        new RegExp(`^/v2/${name}/manifests/([^/]+)$`),
      );
      if (request.method === "GET" && manifestMatch) {
        const target = decodeURIComponent(manifestMatch[1]);
        if (target === version) {
          semverReads += 1;
          return sendManifest(response, semverReads === 1 ? canonicalImage : divergentImage);
        }
        if (target === revision && revisionState) return sendManifest(response, revisionState);
        return manifestUnknown(response, target);
      }
      if (request.method === "PUT" && manifestMatch) {
        const target = decodeURIComponent(manifestMatch[1]);
        assert.equal(target, revision);
        revisionState = canonicalImage;
        response.writeHead(201, {
          "docker-content-digest": canonicalImage.manifestDigest,
        });
        response.end();
        return;
      }
      const blobMatch = url.pathname.match(new RegExp(`^/v2/${name}/blobs/(sha256:.+)$`));
      if (request.method === "GET" && blobMatch) {
        const digest = decodeURIComponent(blobMatch[1]);
        const entry = [canonicalImage, divergentImage].find(
          (candidate) => candidate.configDigest === digest,
        );
        assert.ok(entry);
        return sendConfig(response, entry);
      }
      response.writeHead(500);
      response.end(`unexpected ${request.method} ${request.url}`);
    }, async (registryUrl) => {
      const result = await runCli([
        "publish-release",
        "--registry-url",
        registryUrl,
        "--name",
        name,
        "--version",
        version,
        "--revision",
        revision,
        "--image-tar",
        tarPath,
        "--expected-repo-tag",
        `ghcr.io/${name}:${version}`,
        "--expected-config-id",
        local.configDigest,
      ]);

      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /post-write|different manifest digests|does not match/);
      assert.ok(semverReads >= 2);
    });
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test("does not treat malformed manifest 404 responses as missing tags", async () => {
  await withRegistry((request, response) => {
    const url = new URL(request.url, "http://registry.test");
    if (request.method === "GET" && url.pathname === `/v2/${name}/tags/list`) {
      return sendJson(response, 200, {
        name,
        tags: ["0.4.0"],
      });
    }
    if (request.method === "GET" && url.pathname === `/v2/${name}/manifests/0.4.0`) {
      response.writeHead(404, { "content-type": "text/plain" });
      response.end("404 not found");
      return;
    }
    response.writeHead(500);
    response.end(`unexpected ${request.method} ${request.url}`);
  }, async (registryUrl) => {
    const result = await runCli(["select-latest", "--registry-url", registryUrl, "--name", name]);

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /invalid or unexpected 404 OCI error/);
  });
});

test("rejects first-package NAME_UNKNOWN allowance for unreviewed repositories", async () => {
  const unreviewedName = "attacker/patchpage-server";
  await withRegistry((request, response) => {
    const url = new URL(request.url, "http://registry.test");
    if (request.method === "GET" && url.pathname === `/v2/${unreviewedName}/tags/list`) {
      return sendJson(response, 404, {
        errors: [
          {
            code: "NAME_UNKNOWN",
            message: "repository name not known to registry",
            detail: { name: unreviewedName },
          },
        ],
      });
    }
    const manifestMatch = url.pathname.match(
      new RegExp(`^/v2/${unreviewedName}/manifests/([^/]+)$`),
    );
    if (request.method === "GET" && manifestMatch) {
      return sendJson(response, 404, {
        errors: [
          {
            code: "NAME_UNKNOWN",
            message: "repository name not known to registry",
            detail: { name: unreviewedName },
          },
        ],
      });
    }
    response.writeHead(500);
    response.end(`unexpected ${request.method} ${request.url}`);
  }, async (registryUrl) => {
    const result = await runCli([
      "inspect-release",
      "--registry-url",
      registryUrl,
      "--name",
      unreviewedName,
      "--version",
      "1.0.0",
      "--revision",
      "1111111111111111111111111111111111111111",
      "--allow-first-package",
      "true",
    ]);

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /allow-first-package.*allisonmahmood\/patchpage-server/);
  });
});

test("requires manifest 404 OCI errors to identify the requested target", async () => {
  const cases = [
    { label: "wrong repository", detail: { name: "other/repo", revision: "0.4.0" } },
    { label: "wrong revision", detail: { name, revision: "9.9.9" } },
    { label: "malformed detail", detail: "manifest unknown" },
  ];

  for (const item of cases) {
    await withRegistry((request, response) => {
      const url = new URL(request.url, "http://registry.test");
      if (request.method === "GET" && url.pathname === `/v2/${name}/tags/list`) {
        return sendJson(response, 200, { name, tags: ["0.4.0"] });
      }
      if (request.method === "GET" && url.pathname === `/v2/${name}/manifests/0.4.0`) {
        return manifestUnknown(response, "0.4.0", item.detail);
      }
      response.writeHead(500);
      response.end(`unexpected ${request.method} ${request.url}`);
    }, async (registryUrl) => {
      const result = await runCli(["select-latest", "--registry-url", registryUrl, "--name", name]);

      assert.notEqual(result.status, 0, item.label);
      assert.match(result.stderr, /invalid or unexpected 404 OCI error|could not be read/, item.label);
    });
  }
});

test("uses least-privilege registry token scopes", async () => {
  const readScopes = [];
  await withRegistry((request, response) => {
    const url = new URL(request.url, "http://registry.test");
    if (request.method === "GET" && url.pathname === `/v2/${name}/tags/list`) {
      if (!request.headers.authorization) {
        response.writeHead(401, {
          "www-authenticate": `Bearer realm="http://${request.headers.host}/token",service="ghcr.io"`,
        });
        response.end();
        return;
      }
      return sendJson(response, 200, { name, tags: [] });
    }
    if (request.method === "GET" && url.pathname === "/token") {
      readScopes.push(url.searchParams.get("scope"));
      return sendJson(response, 200, { token: "read-token" });
    }
    response.writeHead(500);
    response.end(`unexpected ${request.method} ${request.url}`);
  }, async (registryUrl) => {
    const result = await runCli(["select-latest", "--registry-url", registryUrl, "--name", name]);

    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(readScopes, [`repository:${name}:pull`]);
  });

  const writeScopes = [];
  await withRegistry((request, response) => {
    const url = new URL(request.url, "http://registry.test");
    if (request.method === "GET" && url.pathname === `/v2/${name}/tags/list`) {
      if (!request.headers.authorization) {
        response.writeHead(401, {
          "www-authenticate": `Bearer realm="http://${request.headers.host}/token",service="ghcr.io"`,
        });
        response.end();
        return;
      }
      return sendJson(response, 200, { name, tags: [] });
    }
    if (request.method === "GET" && url.pathname === "/token") {
      writeScopes.push(url.searchParams.get("scope"));
      return sendJson(response, 200, { token: "write-token" });
    }
    response.writeHead(500);
    response.end(`unexpected ${request.method} ${request.url}`);
  }, async (registryUrl) => {
    const result = await runCli(["reconcile-latest", "--registry-url", registryUrl, "--name", name]);

    assert.notEqual(result.status, 0);
    assert.deepEqual(writeScopes, [`repository:${name}:pull,push`]);
  });
});

test("rejects credential-bearing registry redirects to another origin", async () => {
  await withRegistry((request, response) => {
    const url = new URL(request.url, "http://registry.test");
    if (request.method === "GET" && url.pathname === `/v2/${name}/tags/list`) {
      response.writeHead(401, {
        "www-authenticate": 'Bearer realm="https://attacker.example/token",service="ghcr.io"',
      });
      response.end();
      return;
    }
    response.writeHead(500);
    response.end(`unexpected ${request.method} ${request.url}`);
  }, async (registryUrl) => {
    const result = await runCli(["select-latest", "--registry-url", registryUrl, "--name", name]);

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /bearer realm changed origin/);
  });

  await withRegistry((request, response) => {
    const url = new URL(request.url, "http://registry.test");
    if (request.method === "GET" && url.pathname === `/v2/${name}/tags/list`) {
      return sendJson(
        response,
        200,
        { name, tags: [] },
        { link: `<https://attacker.example/v2/${name}/tags/list?last=x>; rel="next"` },
      );
    }
    response.writeHead(500);
    response.end(`unexpected ${request.method} ${request.url}`);
  }, async (registryUrl) => {
    const result = await runCli(["select-latest", "--registry-url", registryUrl, "--name", name]);

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Link changed registry origin/);
  });
});

test("rejects upload Location origins outside the registry", async () => {
  const version = "0.5.0";
  const revision = "5555555555555555555555555555555555555555";
  const local = dockerSaveTar(version, revision, "new");
  const tmp = await mkdtemp(path.join(os.tmpdir(), "patchpage-oci-release-"));
  try {
    const tarPath = path.join(tmp, "image.tar");
    await writeFile(tarPath, local.tar);

    await withRegistry((request, response) => {
      const url = new URL(request.url, "http://registry.test");
      const manifestMatch = url.pathname.match(
        new RegExp(`^/v2/${name}/manifests/([^/]+)$`),
      );
      if (request.method === "GET" && manifestMatch) {
        return manifestUnknown(response, decodeURIComponent(manifestMatch[1]));
      }
      if (request.method === "POST" && url.pathname === `/v2/${name}/blobs/uploads/`) {
        response.writeHead(202, { location: "https://attacker.example/upload" });
        response.end();
        return;
      }
      response.writeHead(500);
      response.end(`unexpected ${request.method} ${request.url}`);
    }, async (registryUrl) => {
      const result = await runCli([
        "publish-release",
        "--registry-url",
        registryUrl,
        "--name",
        name,
        "--version",
        version,
        "--revision",
        revision,
        "--image-tar",
        tarPath,
        "--expected-repo-tag",
        `ghcr.io/${name}:${version}`,
        "--expected-config-id",
        local.configDigest,
      ]);

      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /upload Location changed registry origin/);
    });
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test("rejects pagination duplicates and loops", async () => {
  await withRegistry((request, response) => {
    const url = new URL(request.url, "http://registry.test");
    if (request.method === "GET" && url.pathname === `/v2/${name}/tags/list`) {
      return sendJson(response, 200, { name, tags: ["1.0.0", "1.0.0"] });
    }
    response.writeHead(500);
    response.end(`unexpected ${request.method} ${request.url}`);
  }, async (registryUrl) => {
    const result = await runCli(["select-latest", "--registry-url", registryUrl, "--name", name]);

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /duplicate tag/);
  });

  await withRegistry((request, response) => {
    const url = new URL(request.url, "http://registry.test");
    if (request.method === "GET" && url.pathname === `/v2/${name}/tags/list`) {
      return sendJson(
        response,
        200,
        { name, tags: [] },
        { link: `</v2/${name}/tags/list?n=100>; rel="next"` },
      );
    }
    response.writeHead(500);
    response.end(`unexpected ${request.method} ${request.url}`);
  }, async (registryUrl) => {
    const result = await runCli(["select-latest", "--registry-url", registryUrl, "--name", name]);

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /pagination loop/);
  });
});

test("rejects config descriptors above the reviewed maximum before fetching the blob", async () => {
  const version = "0.5.1";
  const revision = "5151515151515151515151515151515151515151";
  const base = image(version, revision);
  const entry = imageWithConfig(version, revision, base.config, MAX_CONFIG_BYTES + 1);
  let configRequested = false;

  await withRegistry((request, response) => {
    const url = new URL(request.url, "http://registry.test");
    if (request.method === "GET" && url.pathname === `/v2/${name}/tags/list`) {
      return sendJson(response, 200, { name, tags: [version] });
    }
    if (request.method === "GET" && url.pathname === `/v2/${name}/manifests/${version}`) {
      return sendManifest(response, entry);
    }
    if (request.method === "GET" && url.pathname === `/v2/${name}/blobs/${entry.configDigest}`) {
      configRequested = true;
      return sendConfig(response, entry);
    }
    response.writeHead(500);
    response.end(`unexpected ${request.method} ${request.url}`);
  }, async (registryUrl) => {
    const result = await runCli(["select-latest", "--registry-url", registryUrl, "--name", name]);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /config descriptor .* exceeds reviewed maximum/);
    assert.equal(configRequested, false);
  });
});

test("aborts a chunked config response as soon as it exceeds the declared size", async () => {
  const version = "0.5.2";
  const revision = "5252525252525252525252525252525252525252";
  const base = image(version, revision);
  const entry = imageWithConfig(version, revision, base.config, base.config.length - 1);

  await withRegistry((request, response) => {
    const url = new URL(request.url, "http://registry.test");
    if (request.method === "GET" && url.pathname === `/v2/${name}/tags/list`) {
      return sendJson(response, 200, { name, tags: [version] });
    }
    if (request.method === "GET" && url.pathname === `/v2/${name}/manifests/${version}`) {
      return sendManifest(response, entry);
    }
    if (request.method === "GET" && url.pathname === `/v2/${name}/blobs/${entry.configDigest}`) {
      response.writeHead(200, {
        "content-type": "application/octet-stream",
        "docker-content-digest": entry.configDigest,
      });
      response.write(entry.config.subarray(0, entry.config.length - 1));
      response.end(entry.config.subarray(entry.config.length - 1));
      return;
    }
    response.writeHead(500);
    response.end(`unexpected ${request.method} ${request.url}`);
  }, async (registryUrl) => {
    const result = await runCli(["select-latest", "--registry-url", registryUrl, "--name", name]);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /config blob .* exceeded declared size .* while streaming/);
  });
});
test("aborts a chunked config response that exceeds the reviewed maximum", async () => {
  const version = "0.5.3";
  const revision = "5353535353535353535353535353535353535353";
  const oversized = Buffer.alloc(MAX_CONFIG_BYTES + 1, 0x20);
  const entry = imageWithConfig(version, revision, oversized, MAX_CONFIG_BYTES);

  await withRegistry((request, response) => {
    const url = new URL(request.url, "http://registry.test");
    if (request.method === "GET" && url.pathname === `/v2/${name}/tags/list`) {
      return sendJson(response, 200, { name, tags: [version] });
    }
    if (request.method === "GET" && url.pathname === `/v2/${name}/manifests/${version}`) {
      return sendManifest(response, entry);
    }
    if (request.method === "GET" && url.pathname === `/v2/${name}/blobs/${entry.configDigest}`) {
      response.writeHead(200, { "content-type": "application/octet-stream" });
      response.write(entry.config.subarray(0, MAX_CONFIG_BYTES));
      response.end(entry.config.subarray(MAX_CONFIG_BYTES));
      return;
    }
    response.writeHead(500);
    response.end(`unexpected ${request.method} ${request.url}`);
  }, async (registryUrl) => {
    const result = await runCli(["select-latest", "--registry-url", registryUrl, "--name", name]);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /config blob .* exceeded declared size 1048576 while streaming/);
  });
});

test("rejects a config stream that ends before its declared size", async () => {
  const version = "0.5.4";
  const revision = "5454545454545454545454545454545454545454";
  const entry = image(version, revision);

  await withRegistry((request, response) => {
    const url = new URL(request.url, "http://registry.test");
    if (request.method === "GET" && url.pathname === `/v2/${name}/tags/list`) {
      return sendJson(response, 200, { name, tags: [version] });
    }
    if (request.method === "GET" && url.pathname === `/v2/${name}/manifests/${version}`) {
      return sendManifest(response, entry);
    }
    if (request.method === "GET" && url.pathname === `/v2/${name}/blobs/${entry.configDigest}`) {
      response.writeHead(200, { "content-type": "application/octet-stream" });
      response.end(entry.config.subarray(0, entry.config.length - 1));
      return;
    }
    response.writeHead(500);
    response.end(`unexpected ${request.method} ${request.url}`);
  }, async (registryUrl) => {
    const result = await runCli(["select-latest", "--registry-url", registryUrl, "--name", name]);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /config blob .* ended at .* expected/);
  });
});

test("accepts a valid chunked config exactly at the reviewed maximum", async () => {
  const version = "0.5.5";
  const revision = "5555555555555555555555555555555555555555";
  const base = image(version, revision);
  const config = Buffer.concat([
    base.config,
    Buffer.alloc(MAX_CONFIG_BYTES - base.config.length, 0x20),
  ]);
  const entry = imageWithConfig(version, revision, config);

  await withRegistry((request, response) => {
    const url = new URL(request.url, "http://registry.test");
    if (request.method === "GET" && url.pathname === `/v2/${name}/tags/list`) {
      return sendJson(response, 200, { name, tags: [version, revision] });
    }
    const manifestMatch = url.pathname.match(
      new RegExp(`^/v2/${name}/manifests/([^/]+)$`),
    );
    if (request.method === "GET" && manifestMatch) return sendManifest(response, entry);
    if (request.method === "GET" && url.pathname === `/v2/${name}/blobs/${entry.configDigest}`) {
      response.writeHead(200, {
        "content-type": "application/octet-stream",
        "docker-content-digest": entry.configDigest,
      });
      for (let offset = 0; offset < entry.config.length; offset += 64 * 1024) {
        response.write(entry.config.subarray(offset, offset + 64 * 1024));
      }
      response.end();
      return;
    }
    response.writeHead(500);
    response.end(`unexpected ${request.method} ${request.url}`);
  }, async (registryUrl) => {
    const result = await runCli(["select-latest", "--registry-url", registryUrl, "--name", name]);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).manifestDigest, entry.manifestDigest);
  });
});


test("rejects manifest and config digest binding failures", async () => {
  const entry = image("0.6.0", "6666666666666666666666666666666666666666");
  await withRegistry((request, response) => {
    const url = new URL(request.url, "http://registry.test");
    if (request.method === "GET" && url.pathname === `/v2/${name}/tags/list`) {
      return sendJson(response, 200, { name, tags: ["0.6.0", entry.revision] });
    }
    const manifestMatch = url.pathname.match(
      new RegExp(`^/v2/${name}/manifests/([^/]+)$`),
    );
    if (request.method === "GET" && manifestMatch) {
      return sendManifest(response, entry, {
        "docker-content-digest": "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      });
    }
    response.writeHead(500);
    response.end(`unexpected ${request.method} ${request.url}`);
  }, async (registryUrl) => {
    const result = await runCli(["select-latest", "--registry-url", registryUrl, "--name", name]);

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /manifest .* Docker-Content-Digest/);
  });

  await withRegistry((request, response) => {
    const url = new URL(request.url, "http://registry.test");
    if (request.method === "GET" && url.pathname === `/v2/${name}/tags/list`) {
      return sendJson(response, 200, { name, tags: ["0.6.0", entry.revision] });
    }
    const manifestMatch = url.pathname.match(
      new RegExp(`^/v2/${name}/manifests/([^/]+)$`),
    );
    if (request.method === "GET" && manifestMatch) return sendManifest(response, entry);
    const blobMatch = url.pathname.match(new RegExp(`^/v2/${name}/blobs/(sha256:.+)$`));
    if (request.method === "GET" && blobMatch) {
      return sendConfig(response, entry, {
        "docker-content-digest": "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      });
    }
    response.writeHead(500);
    response.end(`unexpected ${request.method} ${request.url}`);
  }, async (registryUrl) => {
    const result = await runCli(["select-latest", "--registry-url", registryUrl, "--name", name]);

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /config blob .* returned digest/);
  });

  await withRegistry((request, response) => {
    const url = new URL(request.url, "http://registry.test");
    if (request.method === "GET" && url.pathname === `/v2/${name}/tags/list`) {
      return sendJson(response, 200, { name, tags: ["0.6.0", entry.revision] });
    }
    const manifestMatch = url.pathname.match(
      new RegExp(`^/v2/${name}/manifests/([^/]+)$`),
    );
    if (request.method === "GET" && manifestMatch) return sendManifest(response, entry);
    const blobMatch = url.pathname.match(new RegExp(`^/v2/${name}/blobs/(sha256:.+)$`));
    if (request.method === "GET" && blobMatch) {
      response.writeHead(200, { "content-type": "application/octet-stream" });
      const tampered = Buffer.from(entry.config);
      tampered[0] ^= 0xff;
      response.end(tampered);
      return;
    }
    response.writeHead(500);
    response.end(`unexpected ${request.method} ${request.url}`);
  }, async (registryUrl) => {
    const result = await runCli(["select-latest", "--registry-url", registryUrl, "--name", name]);

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /config blob .* hashes to/);
  });
});

test("rejects Docker schema-2 manifests instead of re-PUTting them as OCI manifests", async () => {
  const version = "0.6.1";
  const revision = "6161616161616161616161616161616161616161";
  const entry = image(version, revision);
  const manifest = jsonBuffer({
    ...JSON.parse(entry.manifest.toString("utf8")),
    mediaType: "application/vnd.docker.distribution.manifest.v2+json",
  });
  const manifestDigest = `sha256:${sha256(manifest)}`;

  await withRegistry((request, response) => {
    const url = new URL(request.url, "http://registry.test");
    if (request.method === "GET" && url.pathname === `/v2/${name}/tags/list`) {
      return sendJson(response, 200, { name, tags: [version] });
    }
    if (request.method === "GET" && url.pathname === `/v2/${name}/manifests/${version}`) {
      response.writeHead(200, {
        "content-type": "application/vnd.docker.distribution.manifest.v2+json",
        "docker-content-digest": manifestDigest,
      });
      response.end(manifest);
      return;
    }
    if (request.method === "GET" && url.pathname === `/v2/${name}/blobs/${entry.configDigest}`) {
      return sendConfig(response, entry);
    }
    if (request.method === "GET" && url.pathname === `/v2/${name}/manifests/${revision}`) {
      return manifestUnknown(response, revision);
    }
    response.writeHead(500);
    response.end(`unexpected ${request.method} ${request.url}`);
  }, async (registryUrl) => {
    const result = await runCli(["select-latest", "--registry-url", registryUrl, "--name", name]);

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /unsupported manifest media type/);
  });
});

test("requires manifest PUT 201 and exact digest acknowledgement", async () => {
  const oldImage = image("0.7.0", "7777777777777777777777777777777777777777");
  const newImage = image("0.8.0", "8888888888888888888888888888888888888888");
  const cases = [
    { label: "wrong status", status: 202, digest: newImage.manifestDigest, error: /HTTP 202/ },
    {
      label: "wrong digest",
      status: 201,
      digest: oldImage.manifestDigest,
      error: /returned digest .* expected/,
    },
  ];

  for (const item of cases) {
    const byTag = new Map([
      ["0.7.0", oldImage],
      [oldImage.revision, oldImage],
      ["0.8.0", newImage],
      [newImage.revision, newImage],
      ["latest", oldImage],
    ]);
    await withRegistry((request, response) => {
      const url = new URL(request.url, "http://registry.test");
      if (request.method === "GET" && url.pathname === `/v2/${name}/tags/list`) {
        return sendJson(response, 200, {
          name,
          tags: ["0.7.0", oldImage.revision, "0.8.0", newImage.revision, "latest"],
        });
      }
      const manifestMatch = url.pathname.match(
        new RegExp(`^/v2/${name}/manifests/([^/]+)$`),
      );
      if (request.method === "GET" && manifestMatch) {
        const entry = byTag.get(decodeURIComponent(manifestMatch[1]));
        assert.ok(entry);
        return sendManifest(response, entry);
      }
      if (request.method === "PUT" && manifestMatch) {
        assert.equal(request.headers["if-match"], undefined);
        assert.equal(request.headers["if-none-match"], undefined);
        response.writeHead(item.status, { "docker-content-digest": item.digest });
        response.end();
        return;
      }
      const blobMatch = url.pathname.match(new RegExp(`^/v2/${name}/blobs/(sha256:.+)$`));
      if (request.method === "GET" && blobMatch) {
        const entry = [...byTag.values()].find(
          (candidate) => candidate.configDigest === decodeURIComponent(blobMatch[1]),
        );
        assert.ok(entry);
        return sendConfig(response, entry);
      }
      response.writeHead(500);
      response.end(`unexpected ${request.method} ${request.url}`);
    }, async (registryUrl) => {
      const result = await runCli(["reconcile-latest", "--registry-url", registryUrl, "--name", name]);

      assert.notEqual(result.status, 0, item.label);
      assert.match(result.stderr, item.error, item.label);
    });
  }
});

test("fails closed on incomplete or divergent release pairs", async () => {
  const oldImage = image("0.9.0", "9999999999999999999999999999999999999999");
  const higherImage = image("1.0.0", "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
  await withRegistry((request, response) => {
    const url = new URL(request.url, "http://registry.test");
    if (request.method === "GET" && url.pathname === `/v2/${name}/tags/list`) {
      return sendJson(response, 200, {
        name,
        tags: ["0.9.0", oldImage.revision, "1.0.0"],
      });
    }
    const manifestMatch = url.pathname.match(
      new RegExp(`^/v2/${name}/manifests/([^/]+)$`),
    );
    if (request.method === "GET" && manifestMatch) {
      const target = decodeURIComponent(manifestMatch[1]);
      if (target === "0.9.0" || target === oldImage.revision) return sendManifest(response, oldImage);
      if (target === "1.0.0") return sendManifest(response, higherImage);
      return manifestUnknown(response, target);
    }
    const blobMatch = url.pathname.match(new RegExp(`^/v2/${name}/blobs/(sha256:.+)$`));
    if (request.method === "GET" && blobMatch) {
      const entry = [oldImage, higherImage].find(
        (candidate) => candidate.configDigest === decodeURIComponent(blobMatch[1]),
      );
      assert.ok(entry);
      return sendConfig(response, entry);
    }
    response.writeHead(500);
    response.end(`unexpected ${request.method} ${request.url}`);
  }, async (registryUrl) => {
    const result = await runCli(["select-latest", "--registry-url", registryUrl, "--name", name]);

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /incomplete/);
  });

  const semverImage = image("1.1.0", "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb");
  const revisionImage = image("1.1.0", "cccccccccccccccccccccccccccccccccccccccc");
  await withRegistry((request, response) => {
    const url = new URL(request.url, "http://registry.test");
    if (request.method === "GET" && url.pathname === `/v2/${name}/tags/list`) {
      return sendJson(response, 200, { name, tags: ["1.1.0", semverImage.revision] });
    }
    const manifestMatch = url.pathname.match(
      new RegExp(`^/v2/${name}/manifests/([^/]+)$`),
    );
    if (request.method === "GET" && manifestMatch) {
      const target = decodeURIComponent(manifestMatch[1]);
      return sendManifest(response, target === "1.1.0" ? semverImage : revisionImage);
    }
    const blobMatch = url.pathname.match(new RegExp(`^/v2/${name}/blobs/(sha256:.+)$`));
    if (request.method === "GET" && blobMatch) {
      const entry = [semverImage, revisionImage].find(
        (candidate) => candidate.configDigest === decodeURIComponent(blobMatch[1]),
      );
      assert.ok(entry);
      return sendConfig(response, entry);
    }
    response.writeHead(500);
    response.end(`unexpected ${request.method} ${request.url}`);
  }, async (registryUrl) => {
    const result = await runCli(["select-latest", "--registry-url", registryUrl, "--name", name]);

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /different manifest digests|different configs/);
  });
});

test("rejects latest revision mismatches and post-write divergence", async () => {
  const oldImage = image("1.2.0", "1212121212121212121212121212121212121212");
  const newImage = image("1.3.0", "1313131313131313131313131313131313131313");
  const mismatchedLatest = image("1.3.0", oldImage.revision);
  await withRegistry((request, response) => {
    const url = new URL(request.url, "http://registry.test");
    if (request.method === "GET" && url.pathname === `/v2/${name}/tags/list`) {
      return sendJson(response, 200, {
        name,
        tags: ["1.2.0", oldImage.revision, "1.3.0", newImage.revision, "latest"],
      });
    }
    const manifestMatch = url.pathname.match(
      new RegExp(`^/v2/${name}/manifests/([^/]+)$`),
    );
    if (request.method === "GET" && manifestMatch) {
      const target = decodeURIComponent(manifestMatch[1]);
      const entry = new Map([
        ["1.2.0", oldImage],
        [oldImage.revision, oldImage],
        ["1.3.0", newImage],
        [newImage.revision, newImage],
        ["latest", mismatchedLatest],
      ]).get(target);
      assert.ok(entry);
      return sendManifest(response, entry);
    }
    const blobMatch = url.pathname.match(new RegExp(`^/v2/${name}/blobs/(sha256:.+)$`));
    if (request.method === "GET" && blobMatch) {
      const entry = [oldImage, newImage, mismatchedLatest].find(
        (candidate) => candidate.configDigest === decodeURIComponent(blobMatch[1]),
      );
      assert.ok(entry);
      return sendConfig(response, entry);
    }
    response.writeHead(500);
    response.end(`unexpected ${request.method} ${request.url}`);
  }, async (registryUrl) => {
    const result = await runCli(["reconcile-latest", "--registry-url", registryUrl, "--name", name]);

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /different manifest digests|revision tag labels do not match|does not match/);
  });

  const byTag = new Map([
    ["1.2.0", oldImage],
    [oldImage.revision, oldImage],
    ["1.3.0", newImage],
    [newImage.revision, newImage],
    ["latest", oldImage],
  ]);
  await withRegistry((request, response) => {
    const url = new URL(request.url, "http://registry.test");
    if (request.method === "GET" && url.pathname === `/v2/${name}/tags/list`) {
      return sendJson(response, 200, {
        name,
        tags: ["1.2.0", oldImage.revision, "1.3.0", newImage.revision, "latest"],
      });
    }
    const manifestMatch = url.pathname.match(
      new RegExp(`^/v2/${name}/manifests/([^/]+)$`),
    );
    if (request.method === "GET" && manifestMatch) {
      const entry = byTag.get(decodeURIComponent(manifestMatch[1]));
      assert.ok(entry);
      return sendManifest(response, entry);
    }
    if (request.method === "PUT" && manifestMatch) {
      assert.equal(request.headers["if-match"], undefined);
      assert.equal(request.headers["if-none-match"], undefined);
      byTag.set("latest", oldImage);
      response.writeHead(201, { "docker-content-digest": newImage.manifestDigest });
      response.end();
      return;
    }
    const blobMatch = url.pathname.match(new RegExp(`^/v2/${name}/blobs/(sha256:.+)$`));
    if (request.method === "GET" && blobMatch) {
      const entry = [...byTag.values()].find(
        (candidate) => candidate.configDigest === decodeURIComponent(blobMatch[1]),
      );
      assert.ok(entry);
      return sendConfig(response, entry);
    }
    response.writeHead(500);
    response.end(`unexpected ${request.method} ${request.url}`);
  }, async (registryUrl) => {
    const result = await runCli(["reconcile-latest", "--registry-url", registryUrl, "--name", name]);

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /post-write latest/);
  });
});

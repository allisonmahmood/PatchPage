import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { gzipSync, zstdCompressSync } from "node:zlib";
import { link, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const repoRoot = path.resolve(import.meta.dirname, "..");
const cli = path.join(repoRoot, "scripts/validate-docker-save-artifact.mjs");
const imageName = "ghcr.io/allisonmahmood/patchpage-server";
const version = "1.2.3";
const revision = "0123456789abcdef0123456789abcdef01234567";
const repoTag = `${imageName}:${version}`;

function sha256(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

function jsonBuffer(value) {
  return Buffer.from(`${JSON.stringify(value)}\n`, "utf8");
}

function tarHeader(name, size, type = "0") {
  const header = Buffer.alloc(512);
  header.write(name, 0, 100, "utf8");
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

function tarEntry(name, body = Buffer.alloc(0), type = "0") {
  const data = Buffer.isBuffer(body) ? body : Buffer.from(body);
  const padding = Buffer.alloc((512 - (data.length % 512)) % 512);
  return Buffer.concat([tarHeader(name, type === "5" ? 0 : data.length, type), data, padding]);
}

const legacyKeyOrder = [
  "id",
  "parent",
  "comment",
  "created",
  "container",
  "container_config",
  "docker_version",
  "author",
  "config",
  "architecture",
  "variant",
  "os",
  "Size",
];

function legacyConfig(v1Config, id, parent) {
  const value = { id };
  if (parent) value.parent = parent;
  Object.assign(value, v1Config);
  const body = {};
  for (const key of legacyKeyOrder) {
    if (Object.hasOwn(value, key)) body[key] = value[key];
  }
  for (const [key, field] of Object.entries(value)) {
    if (!Object.hasOwn(body, key)) body[key] = field;
  }
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
  const config = {
    Hostname: "",
    Domainname: "",
    User: runtimeConfig.User ?? "",
    AttachStdin: false,
    AttachStdout: false,
    AttachStderr: false,
  };
  if (Object.hasOwn(runtimeConfig, "ExposedPorts")) {
    config.ExposedPorts = runtimeConfig.ExposedPorts;
  }
  Object.assign(config, {
    Tty: false,
    OpenStdin: false,
    StdinOnce: false,
    Env: runtimeConfig.Env ?? null,
    Cmd: runtimeConfig.Cmd ?? null,
  });
  if (Object.hasOwn(runtimeConfig, "Healthcheck")) {
    config.Healthcheck = runtimeConfig.Healthcheck;
  }
  Object.assign(config, {
    ArgsEscaped: true,
    Image: "",
    Volumes: runtimeConfig.Volumes ?? null,
    WorkingDir: runtimeConfig.WorkingDir ?? "",
    Entrypoint: runtimeConfig.Entrypoint ?? null,
    OnBuild: runtimeConfig.OnBuild ?? null,
    Labels: runtimeConfig.Labels ?? null,
  });
  for (const key of ["StopSignal", "Shell"]) {
    if (Object.hasOwn(runtimeConfig, key)) config[key] = runtimeConfig[key];
  }
  return config;
}

function fixtureTar({
  extraEntries = [],
  manifestMediaType = "application/vnd.oci.image.manifest.v1+json",
  compression = "gzip",
  layerContents = [Buffer.from("layer-one\n", "utf8"), Buffer.from("layer-two\n", "utf8")],
  mutateStoredLayer = (layer) => layer,
  reverseStoredLayers = false,
  mutateLegacyLayerConfigs = (configs) => configs,
  repositoryLayerId = ({ diffIds }) => diffIds.at(-1).slice("sha256:".length),
  mutateDiffIds = (digests) => digests,
  mutateLayerDigests = (digests) => digests,
  mutateEntries = (entries) => entries,
} = {}) {
  const diffIds = mutateDiffIds(
    layerContents.map((layer) => `sha256:${sha256(layer)}`),
  );
  const storedLayers = layerContents.map(mutateStoredLayer);
  if (reverseStoredLayers) storedLayers.reverse();
  const compress =
    compression === "gzip"
      ? gzipSync
      : compression === "zstd"
        ? zstdCompressSync
        : (layer) => layer;
  const layerMediaType =
    compression === "gzip"
      ? "application/vnd.oci.image.layer.v1.tar+gzip"
      : compression === "zstd"
        ? "application/vnd.oci.image.layer.v1.tar+zstd"
        : "application/vnd.oci.image.layer.v1.tar";
  const layerBodies = storedLayers.map((layer) => compress(layer));
  const layerDigests = mutateLayerDigests(
    layerBodies.map((layer) => `sha256:${sha256(layer)}`),
  );
  const configValue = {
    created: "1970-01-01T00:00:00Z",
    architecture: "amd64",
    os: "linux",
    config: {
      User: "node",
      Env: ["NODE_ENV=production", "PORT=3000"],
      Entrypoint: ["docker-entrypoint.sh"],
      Cmd: ["node", "dist/start.js"],
      WorkingDir: "/app",
      Labels: {
        "org.opencontainers.image.source": "https://github.com/allisonmahmood/PatchPage",
        "org.opencontainers.image.version": version,
        "org.opencontainers.image.revision": revision,
      },
      ExposedPorts: { "3000/tcp": {} },
      Volumes: { "/data": {} },
      Healthcheck: {
        Test: ["CMD", "node", "healthcheck.js"],
        Interval: 1_000_000_000,
        Timeout: 2_000_000_000,
        Retries: 3,
      },
      StopSignal: "SIGTERM",
      Shell: ["/bin/sh", "-c"],
      OnBuild: ["RUN echo verified"],
    },
    rootfs: {
      type: "layers",
      diff_ids: diffIds,
    },
  };
  const config = jsonBuffer(configValue);
  const configDigest = `sha256:${sha256(config)}`;
  const ociManifest = jsonBuffer({
    schemaVersion: 2,
    mediaType: manifestMediaType,
    config: {
      mediaType: "application/vnd.oci.image.config.v1+json",
      digest: configDigest,
      size: config.length,
    },
    layers: layerBodies.map((layer, index) => ({
      mediaType: layerMediaType,
      digest: layerDigests[index],
      size: layer.length,
    })),
  });
  const ociManifestDigest = `sha256:${sha256(ociManifest)}`;
  const manifest = jsonBuffer([
    {
      Config: `blobs/sha256/${configDigest.slice("sha256:".length)}`,
      RepoTags: [repoTag],
      Layers: layerDigests.map((digest) => `blobs/sha256/${digest.slice("sha256:".length)}`),
    },
  ]);
  const legacyLayerConfigs = [];
  for (let index = 0; index < diffIds.length; index += 1) {
    const parent = legacyLayerConfigs.at(-1)?.id ?? "";
    const v1Config =
      index === diffIds.length - 1
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
    const id = sha256(Buffer.from(`opaque-legacy-id-${index}`, "utf8"));
    const body = legacyConfig(v1Config, id, parent);
    legacyLayerConfigs.push({
      id,
      path: `blobs/sha256/${sha256(body)}`,
      body,
    });
  }
  const storedLegacyLayerConfigs = mutateLegacyLayerConfigs(legacyLayerConfigs);
  const repositories = jsonBuffer({
    [imageName]: {
      [version]: repositoryLayerId({
        configs: storedLegacyLayerConfigs,
        diffIds,
      }),
    },
  });
  const index = jsonBuffer({
    schemaVersion: 2,
    manifests: [
      {
        mediaType: manifestMediaType,
        digest: ociManifestDigest,
        size: ociManifest.length,
        annotations: {
          "org.opencontainers.image.ref.name": version,
        },
      },
    ],
  });

  const entries = mutateEntries([
    tarEntry("blobs/", Buffer.alloc(0), "5"),
    tarEntry("blobs/sha256/", Buffer.alloc(0), "5"),
    tarEntry("manifest.json", manifest),
    tarEntry("repositories", repositories),
    tarEntry("oci-layout", jsonBuffer({ imageLayoutVersion: "1.0.0" })),
    tarEntry("index.json", index),
    tarEntry(`blobs/sha256/${configDigest.slice("sha256:".length)}`, config),
    ...layerBodies.map((layer, index) =>
      tarEntry(`blobs/sha256/${layerDigests[index].slice("sha256:".length)}`, layer),
    ),
    tarEntry(`blobs/sha256/${ociManifestDigest.slice("sha256:".length)}`, ociManifest),
    ...storedLegacyLayerConfigs.map((legacy) => tarEntry(legacy.path, legacy.body)),
    ...extraEntries,
  ]);

  const tar = Buffer.concat([
    ...entries,
    Buffer.alloc(1024),
  ]);
  return {
    tar,
    configDigest,
    diffIds,
    legacyLayerConfigs: storedLegacyLayerConfigs,
    layerDigests,
  };
}

function rewriteLegacyConfig(legacy, mutate) {
  const value = JSON.parse(legacy.body.toString("utf8"));
  mutate(value);
  const { id, parent, ...v1Config } = value;
  const body = legacyConfig(v1Config, id, parent);
  return {
    id,
    path: `blobs/sha256/${sha256(body)}`,
    body,
  };
}

function validateTarInTemp(tmp, tar, configDigest) {
  return spawnSync(
    process.execPath,
    [
      cli,
      "--artifact-dir",
      tmp,
      "--expected-filename",
      "image.tar",
      "--expected-sha256",
      sha256(tar),
      "--expected-repo-tag",
      repoTag,
      "--expected-config-id",
      configDigest,
    ],
    { cwd: repoRoot, encoding: "utf8" },
  );
}

async function withImageTar(fn) {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "patchpage-image-artifact-"));
  try {
    await fn(tmp);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

test("validates a compressed two-layer Moby hybrid graph with distinct descriptors and diff IDs", async () => {
  await withImageTar(async (tmp) => {
    const { tar, configDigest, diffIds, layerDigests } = fixtureTar();
    assert.notDeepEqual(layerDigests, diffIds);
    await writeFile(path.join(tmp, "image.tar"), tar);
    const result = validateTarInTemp(tmp, tar, configDigest);

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /validated docker-save artifact/);
  });
});
test("validates a zstd-compressed Moby hybrid layer graph", async () => {
  await withImageTar(async (tmp) => {
    const { tar, configDigest } = fixtureTar({ compression: "zstd" });
    await writeFile(path.join(tmp, "image.tar"), tar);
    const result = validateTarInTemp(tmp, tar, configDigest);

    assert.equal(result.status, 0, result.stderr);
  });
});

test("accepts opaque Moby legacy IDs when the authenticated graph bindings remain intact", async () => {
  await withImageTar(async (tmp) => {
    const { tar, configDigest } = fixtureTar({
      mutateLegacyLayerConfigs: ([root, top]) => {
        const rootId = "1".repeat(64);
        const topId = "2".repeat(64);
        return [
          rewriteLegacyConfig(root, (legacy) => {
            legacy.id = rootId;
            legacy.created = null;
            legacy.Size = 1;
          }),
          rewriteLegacyConfig(top, (legacy) => {
            legacy.id = topId;
            legacy.parent = rootId;
          }),
        ];
      },
    });
    await writeFile(path.join(tmp, "image.tar"), tar);
    const result = validateTarInTemp(tmp, tar, configDigest);

    assert.equal(result.status, 0, result.stderr);
  });
});

test("accepts a leaf that omits optional OCI role fields", async () => {
  await withImageTar(async (tmp) => {
    const { tar, configDigest } = fixtureTar({
      mutateLegacyLayerConfigs: ([root, top]) => [
        root,
        rewriteLegacyConfig(top, (legacy) => {
          delete legacy.config;
          delete legacy.architecture;
        }),
      ],
    });
    await writeFile(path.join(tmp, "image.tar"), tar);
    const result = validateTarInTemp(tmp, tar, configDigest);

    assert.equal(result.status, 0, result.stderr);
  });
});

test("rejects malformed Moby legacy parent graphs and repository bindings", async () => {
  const threeLayers = [
    Buffer.from("layer-one\n", "utf8"),
    Buffer.from("layer-two\n", "utf8"),
    Buffer.from("layer-three\n", "utf8"),
  ];
  const cases = [
    {
      name: "invalid ID",
      fixture: () =>
        fixtureTar({
          mutateLegacyLayerConfigs: ([root, top]) => [
            rewriteLegacyConfig(root, (legacy) => {
              legacy.id = "A".repeat(64);
            }),
            top,
          ],
        }),
      error: /invalid id/,
    },
    {
      name: "invalid parent",
      fixture: () =>
        fixtureTar({
          mutateLegacyLayerConfigs: ([root, top]) => [
            root,
            rewriteLegacyConfig(top, (legacy) => {
              legacy.parent = "not-a-legacy-id";
            }),
          ],
        }),
      error: /invalid parent/,
    },
    {
      name: "multiple roots",
      fixture: () =>
        fixtureTar({
          mutateLegacyLayerConfigs: ([root, top]) => [
            root,
            rewriteLegacyConfig(top, (legacy) => {
              delete legacy.parent;
            }),
          ],
        }),
      error: /exactly one parentless root, found 2/,
    },
    {
      name: "fork",
      fixture: () =>
        fixtureTar({
          layerContents: threeLayers,
          mutateLegacyLayerConfigs: ([root, middle, top]) => [
            root,
            middle,
            rewriteLegacyConfig(top, (legacy) => {
              legacy.parent = root.id;
            }),
          ],
        }),
      error: /graph forks at parent/,
    },
    {
      name: "cycle",
      fixture: () =>
        fixtureTar({
          mutateLegacyLayerConfigs: ([root, top]) => [
            rewriteLegacyConfig(root, (legacy) => {
              legacy.parent = top.id;
            }),
            top,
          ],
        }),
      error: /exactly one parentless root, found 0/,
    },
    {
      name: "missing parent",
      fixture: () =>
        fixtureTar({
          mutateLegacyLayerConfigs: ([root, top]) => [
            root,
            rewriteLegacyConfig(top, (legacy) => {
              legacy.parent = "5".repeat(64);
            }),
          ],
        }),
      error: /references a missing parent/,
    },
    {
      name: "missing node",
      fixture: () =>
        fixtureTar({
          mutateLegacyLayerConfigs: ([root]) => [root],
        }),
      error: /must contain exactly 2 legacy configs, found 1/,
    },
    {
      name: "duplicate ID",
      fixture: () =>
        fixtureTar({
          mutateLegacyLayerConfigs: ([root, top]) => [
            root,
            rewriteLegacyConfig(top, (legacy) => {
              legacy.id = root.id;
            }),
          ],
        }),
      error: /duplicate legacy config id/,
    },
    {
      name: "repository tag points to the synthetic legacy leaf ID",
      fixture: () =>
        fixtureTar({
          repositoryLayerId: ({ configs }) => configs.at(-1).id,
        }),
      error: /repositories .* expected top uncompressed diff ID/,
    },
  ];

  for (const item of cases) {
    await withImageTar(async (tmp) => {
      const { tar, configDigest } = item.fixture();
      await writeFile(path.join(tmp, "image.tar"), tar);
      const result = validateTarInTemp(tmp, tar, configDigest);

      assert.notEqual(result.status, 0, item.name);
      assert.match(result.stderr, item.error, item.name);
    });
  }
});

test("rejects invalid or role-inconsistent Moby legacy V1 fields", async () => {
  const cases = [
    {
      name: "invalid created type",
      mutate: ([root, top]) => [
        rewriteLegacyConfig(root, (legacy) => {
          legacy.created = 0;
        }),
        top,
      ],
      error: /invalid created value/,
    },
    {
      name: "invalid container config type",
      mutate: ([root, top]) => [
        rewriteLegacyConfig(root, (legacy) => {
          legacy.container_config = [];
        }),
        top,
      ],
      error: /invalid container_config/,
    },
    {
      name: "empty operating system",
      mutate: ([root, top]) => [
        rewriteLegacyConfig(root, (legacy) => {
          legacy.os = "";
        }),
        top,
      ],
      error: /invalid os/,
    },
    {
      name: "invalid optional string type",
      mutate: ([root, top]) => [
        rewriteLegacyConfig(root, (legacy) => {
          legacy.comment = false;
        }),
        top,
      ],
      error: /invalid comment/,
    },
    {
      name: "non-leaf runtime config",
      mutate: ([root, top]) => [
        rewriteLegacyConfig(root, (legacy) => {
          legacy.config = { Labels: { attacker: "extra" } };
        }),
        top,
      ],
      error: /non-leaf legacy config .* must not contain config/,
    },
    {
      name: "non-leaf architecture",
      mutate: ([root, top]) => [
        rewriteLegacyConfig(root, (legacy) => {
          legacy.architecture = "amd64";
        }),
        top,
      ],
      error: /non-leaf legacy config .* must not contain architecture/,
    },
    {
      name: "non-leaf variant",
      mutate: ([root, top]) => [
        rewriteLegacyConfig(root, (legacy) => {
          legacy.variant = "v1";
        }),
        top,
      ],
      error: /non-leaf legacy config .* must not contain variant/,
    },
    {
      name: "final architecture",
      mutate: ([root, top]) => [
        root,
        rewriteLegacyConfig(top, (legacy) => {
          legacy.architecture = "arm64";
        }),
      ],
      error: /leaf architecture does not match OCI image config/,
    },
    {
      name: "final variant",
      mutate: ([root, top]) => [
        root,
        rewriteLegacyConfig(top, (legacy) => {
          legacy.variant = "v1";
        }),
      ],
      error: /leaf variant does not match OCI image config/,
    },
    ...[
      ["User", "attacker"],
      ["Env", ["ATTACKER=1"]],
      ["Entrypoint", ["/attacker-entrypoint"]],
      ["Cmd", ["attacker-command"]],
      ["WorkingDir", "/attacker"],
      ["Labels", { attacker: "extra" }],
      ["ExposedPorts", { "9000/tcp": {} }],
      ["Volumes", { "/attacker": {} }],
      ["Healthcheck", { Test: ["NONE"] }],
      ["StopSignal", "SIGKILL"],
      ["Shell", ["/bin/bash", "-c"]],
      ["OnBuild", ["RUN attacker"]],
    ].map(([field, value]) => ({
      name: `final runtime config ${field}`,
      mutate: ([root, top]) => [
        root,
        rewriteLegacyConfig(top, (legacy) => {
          legacy.config[field] = value;
        }),
      ],
      error: new RegExp(`leaf runtime config ${field} does not match OCI image config`),
    })),
    {
      name: "operating system",
      mutate: ([root, top]) => [
        rewriteLegacyConfig(root, (legacy) => {
          legacy.os = "windows";
        }),
        top,
      ],
      error: /operating system does not match OCI image config/,
    },
    ...[
      ["zero", 0],
      ["fractional", 1.5],
      ["unsafe", Number.MAX_SAFE_INTEGER + 1],
    ].map(([name, value]) => ({
      name: `${name} Size`,
      mutate: ([root, top]) => [
        rewriteLegacyConfig(root, (legacy) => {
          legacy.Size = value;
        }),
        top,
      ],
      error: /invalid Size/,
    })),
    {
      name: "lowercase size key",
      mutate: ([root, top]) => [
        rewriteLegacyConfig(root, (legacy) => {
          legacy.size = 1;
        }),
        top,
      ],
      error: /unexpected key size/,
    },
  ];

  for (const item of cases) {
    await withImageTar(async (tmp) => {
      const { tar, configDigest } = fixtureTar({
        mutateLegacyLayerConfigs: item.mutate,
      });
      await writeFile(path.join(tmp, "image.tar"), tar);
      const result = validateTarInTemp(tmp, tar, configDigest);

      assert.notEqual(result.status, 0, item.name);
      assert.match(result.stderr, item.error, item.name);
    });
  }
});

test("rejects tampered, reordered, and compression-bomb layer content", async () => {
  const cases = [
    {
      name: "tampered uncompressed content",
      fixture: () =>
        fixtureTar({
          mutateStoredLayer: (layer, index) =>
            index === 0 ? Buffer.from("tampered-layer\n", "utf8") : layer,
        }),
      error: /rootfs\.diff_ids\[0\].*does not match uncompressed layer/,
    },
    {
      name: "reordered descriptors",
      fixture: () => fixtureTar({ reverseStoredLayers: true }),
      error: /rootfs\.diff_ids\[0\].*does not match uncompressed layer/,
    },
    {
      name: "wrong compressed layer digest",
      fixture: () =>
        fixtureTar({
          mutateLayerDigests: (digests) => [
            `sha256:${"f".repeat(64)}`,
            ...digests.slice(1),
          ],
        }),
      error: /blob .* hashes to sha256:.* not sha256:ffff/,
    },
    {
      name: "wrong nonfinal diff ID",
      fixture: () =>
        fixtureTar({
          mutateDiffIds: (diffIds) => [
            `sha256:${"e".repeat(64)}`,
            ...diffIds.slice(1),
          ],
        }),
      error: /rootfs\.diff_ids\[0\].*does not match uncompressed layer/,
    },
    {
      name: "compression bomb",
      fixture: () =>
        fixtureTar({
          layerContents: [
            Buffer.alloc(2 * 1024 * 1024),
            Buffer.from("ordinary-layer\n", "utf8"),
          ],
        }),
      error: /bounded decompression limit/,
    },
  ];

  for (const item of cases) {
    await withImageTar(async (tmp) => {
      const { tar, configDigest } = item.fixture();
      await writeFile(path.join(tmp, "image.tar"), tar);
      const result = validateTarInTemp(tmp, tar, configDigest);

      assert.notEqual(result.status, 0, item.name);
      assert.match(result.stderr, item.error, item.name);
    });
  }
});


test("rejects a non-OCI manifest media type in the Docker-save graph", async () => {
  await withImageTar(async (tmp) => {
    const { tar, configDigest } = fixtureTar({
      manifestMediaType: "application/vnd.docker.distribution.manifest.v2+json",
    });
    await writeFile(path.join(tmp, "image.tar"), tar);
    const result = validateTarInTemp(tmp, tar, configDigest);

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /OCI manifest mediaType/);
  });
});

test("rejects unsafe docker-save tar paths and entry types", async () => {
  const cases = [
    {
      name: "absolute",
      fixture: () => fixtureTar({ extraEntries: [tarEntry("/absolute", "bad\n")] }),
      error: /absolute path/,
    },
    {
      name: "parent traversal",
      fixture: () => fixtureTar({
      extraEntries: [tarEntry("../escape", "bad\n")],
      }),
      error: /escapes the archive root/,
    },
    {
      name: "duplicate",
      fixture: () => fixtureTar({ extraEntries: [tarEntry("manifest.json", "bad\n")] }),
      error: /duplicate entry/,
    },
    {
      name: "link",
      fixture: () => fixtureTar({ extraEntries: [tarEntry("link", "target", "2")] }),
      error: /entry is a link/,
    },
    {
      name: "device",
      fixture: () => fixtureTar({ extraEntries: [tarEntry("device", "", "3")] }),
      error: /device\/FIFO/,
    },
  ];

  for (const item of cases) {
    await withImageTar(async (tmp) => {
      const { tar, configDigest } = item.fixture();
      await writeFile(path.join(tmp, "image.tar"), tar);
      const result = validateTarInTemp(tmp, tar, configDigest);

      assert.notEqual(result.status, 0, item.name);
      assert.match(result.stderr, item.error, item.name);
    });
  }
});

test("rejects arbitrary, noncanonical, or extra Moby legacy config blobs", async () => {
  const arbitrary = Buffer.from("not-json\n", "utf8");
  const array = Buffer.from("[]", "utf8");
  const unexpectedKey = legacyConfig(
    {
      created: "1970-01-01T00:00:00Z",
      container_config: emptyMobyContainerConfig(),
      os: "linux",
      rootfs: {},
    },
    "2".repeat(64),
    "",
  );
  const noncanonical = Buffer.from(
    `${legacyConfig(
      {
        created: "1970-01-01T00:00:00Z",
        container_config: emptyMobyContainerConfig(),
        os: "linux",
      },
      "3".repeat(64),
      "",
    ).toString("utf8")}\n`,
    "utf8",
  );
  const cases = [
    {
      name: "arbitrary blob",
      fixture: () =>
        fixtureTar({
          extraEntries: [tarEntry(`blobs/sha256/${sha256(arbitrary)}`, arbitrary)],
        }),
      error: /legacy config blob .* is not JSON/,
    },
    {
      name: "array blob",
      fixture: () =>
        fixtureTar({
          extraEntries: [tarEntry(`blobs/sha256/${sha256(array)}`, array)],
        }),
      error: /must be a JSON object/,
    },
    {
      name: "unexpected V1 key",
      fixture: () =>
        fixtureTar({
          extraEntries: [tarEntry(`blobs/sha256/${sha256(unexpectedKey)}`, unexpectedKey)],
        }),
      error: /unexpected key rootfs/,
    },
    {
      name: "noncanonical V1 bytes",
      fixture: () =>
        fixtureTar({
          extraEntries: [tarEntry(`blobs/sha256/${sha256(noncanonical)}`, noncanonical)],
        }),
      error: /not canonical Moby V1 JSON/,
    },
    {
      name: "extra Moby-shaped root",
      fixture: () => {
        const v1Config = {
          created: "1970-01-01T00:00:00Z",
          container_config: emptyMobyContainerConfig(),
          os: "linux",
        };
        const body = legacyConfig(
          v1Config,
          sha256(Buffer.from("extra-legacy-id", "utf8")),
          "",
        );
        return fixtureTar({
          extraEntries: [tarEntry(`blobs/sha256/${sha256(body)}`, body)],
        });
      },
      error: /must contain exactly 2 legacy configs, found 3/,
    },
    {
      name: "extra Moby-shaped final config",
      fixture: () =>
        fixtureTar({
          mutateLegacyLayerConfigs: (configs) => [
            ...configs,
            rewriteLegacyConfig(configs.at(-1), (legacy) => {
              legacy.id = "4".repeat(64);
            }),
          ],
        }),
      error: /must contain exactly 2 legacy configs, found 3/,
    },
  ];

  for (const item of cases) {
    await withImageTar(async (tmp) => {
      const { tar, configDigest } = item.fixture();
      await writeFile(path.join(tmp, "image.tar"), tar);
      const result = validateTarInTemp(tmp, tar, configDigest);

      assert.notEqual(result.status, 0, item.name);
      assert.match(result.stderr, item.error, item.name);
    });
  }
});

test("rejects extra files or symlinks in the downloaded artifact directory", async () => {
  await withImageTar(async (tmp) => {
    const { tar, configDigest } = fixtureTar();
    await writeFile(path.join(tmp, "image.tar"), tar);
    await writeFile(path.join(tmp, "extra.tar"), tar);
    const result = validateTarInTemp(tmp, tar, configDigest);

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /exactly one entry/);
  });

  await withImageTar(async (tmp) => {
    const { tar, configDigest } = fixtureTar();
    const targetDir = await mkdtemp(path.join(os.tmpdir(), "patchpage-image-target-"));
    try {
      const target = path.join(targetDir, "target.tar");
      await writeFile(target, tar);
      await symlink(target, path.join(tmp, "image.tar"));
      const result = validateTarInTemp(tmp, tar, configDigest);

      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /regular file|symlink/);
    } finally {
      await rm(targetDir, { recursive: true, force: true });
    }
  });

  await withImageTar(async (tmp) => {
    const { tar, configDigest } = fixtureTar();
    const targetDir = await mkdtemp(path.join(os.tmpdir(), "patchpage-image-target-"));
    try {
      const target = path.join(targetDir, "target.tar");
      await writeFile(target, tar);
      await link(target, path.join(tmp, "image.tar"));
      const result = validateTarInTemp(tmp, tar, configDigest);

      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /hardlinked/);
    } finally {
      await rm(targetDir, { recursive: true, force: true });
    }
  });
});

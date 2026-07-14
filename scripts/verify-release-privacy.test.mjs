import assert from "node:assert/strict";
import { gzipSync } from "node:zlib";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import {
  formatFailures,
  reviewedIdentityForTests,
  verifyReleasePrivacy
} from "./verify-release-privacy.mjs";

const cli = path.join(import.meta.dirname, "verify-release-privacy.mjs");

function email(local) {
  return `${local}${String.fromCharCode(64)}example.invalid`;
}

function syntheticPath(...segments) {
  return `/${segments.join("/")}`;
}

function fileUrlPath(...segments) {
  return `file://${syntheticPath(...segments)}`;
}

function windowsPath(drive, ...segments) {
  return `${drive}:${String.fromCharCode(92)}${segments.join(String.fromCharCode(92))}`;
}

function windowsEnvPath(name, ...segments) {
  return `%${name}%${String.fromCharCode(92)}${segments.join(String.fromCharCode(92))}`;
}

const PRIVATE_KIND = `${"sess"}${"ion"}`;

function privateTextArtifactName() {
  return `${"trans"}${"ript"}.txt`;
}

function privateKind(kind) {
  return [PRIVATE_KIND, `${"conver"}${"sation"}`, `${"roll"}${"out"}`][kind];
}

function privateStructuredArtifactName() {
  return `${PRIVATE_KIND}-export.jsonl`;
}

function privateIdentifierKey(kind) {
  return `${privateKind(kind)}${"Id"}`;
}

function privateCategory(source, suffix) {
  return `${source}-${PRIVATE_KIND}-${suffix}`;
}

function localField(name) {
  return `_${name}`;
}

function jsonBuffer(value) {
  return Buffer.from(`${JSON.stringify(value)}\n`, "utf8");
}

function binarySignatureBlob({ artifactValue, emailValue, homePath, tempPath }) {
  return Buffer.concat([
    Buffer.from([0, 255, 254]),
    Buffer.from(` contact ${emailValue}`, "ascii"),
    Buffer.from([0]),
    Buffer.from(` workspace ${homePath}`, "ascii"),
    Buffer.from([255]),
    Buffer.from(` build ${tempPath}`, "ascii"),
    Buffer.from([0]),
    Buffer.from(` export ${artifactValue}`, "ascii"),
    Buffer.from([254, 0])
  ]);
}

function paxRecord(key, value) {
  const payload = `${key}=${value}\n`;
  let length = Buffer.byteLength(payload, "utf8") + 3;
  while (true) {
    const record = `${length} ${payload}`;
    const nextLength = Buffer.byteLength(record, "utf8");
    if (nextLength === length) return Buffer.from(record, "utf8");
    length = nextLength;
  }
}

function paxBody(records) {
  return paxBodyEntries(Object.entries(records));
}

function paxBodyEntries(records) {
  return Buffer.concat(records.map(([key, value]) => paxRecord(key, value)));
}

function gnuLongBody(value) {
  return Buffer.concat([Buffer.from(value, "utf8"), Buffer.from([0])]);
}

function tarHeader(name, size, type = "0", linkName = "", owner = {}, headerPatch = null) {
  const header = Buffer.alloc(512);
  header.write(name, 0, 100, "utf8");
  header.write("0000644\0", 100, 8, "ascii");
  header.write((owner.uid ?? 0).toString(8).padStart(7, "0") + "\0", 108, 8, "ascii");
  header.write((owner.gid ?? 0).toString(8).padStart(7, "0") + "\0", 116, 8, "ascii");
  header.write(size.toString(8).padStart(11, "0") + "\0", 124, 12, "ascii");
  header.write("00000000000\0", 136, 12, "ascii");
  header.fill(" ", 148, 156);
  header.write(type, 156, 1, "ascii");
  header.write(linkName, 157, 100, "utf8");
  header.write("ustar\0", 257, 6, "ascii");
  header.write("00", 263, 2, "ascii");
  header.write(owner.uname ?? "", 265, 32, "utf8");
  header.write(owner.gname ?? "", 297, 32, "utf8");
  headerPatch?.(header);

  let checksum = 0;
  for (const byte of header) checksum += byte;
  header.write(checksum.toString(8).padStart(6, "0") + "\0 ", 148, 8, "ascii");
  return header;
}

function tarEntry(
  name,
  body = Buffer.alloc(0),
  type = "0",
  linkName = "",
  owner = {},
  headerPatch = null,
  paddingPatch = null
) {
  const data = Buffer.isBuffer(body) ? body : Buffer.from(body);
  const entrySize = ["1", "2", "5"].includes(type) ? 0 : data.length;
  const bodyData = entrySize === 0 ? Buffer.alloc(0) : data;
  const padding = Buffer.alloc((512 - (bodyData.length % 512)) % 512);
  paddingPatch?.(padding);
  return Buffer.concat([
    tarHeader(name, entrySize, type, linkName, owner, headerPatch),
    bodyData,
    padding
  ]);
}

function tarArchive(entries, trailer = Buffer.alloc(1024)) {
  return Buffer.concat([
    ...entries.map(({ body, headerPatch, linkName, name, owner, paddingPatch, type }) =>
      tarEntry(name, body, type, linkName, owner, headerPatch, paddingPatch)
    ),
    trailer
  ]);
}

function gzipReleaseArtifact(body) {
  const archive = gzipSync(body, { level: 9 });
  archive[9] = 255;
  return archive;
}

function tgz(entries, trailer) {
  return gzipReleaseArtifact(tarArchive(entries, trailer));
}

function gzipWithMetadata(body, { comment, filename }) {
  const archive = gzipReleaseArtifact(body);
  const header = Buffer.from(archive.subarray(0, 10));
  const metadata = [];
  if (filename !== undefined) {
    header[3] |= 0x08;
    metadata.push(Buffer.from(filename, "utf8"), Buffer.from([0]));
  }
  if (comment !== undefined) {
    header[3] |= 0x10;
    metadata.push(Buffer.from(comment, "utf8"), Buffer.from([0]));
  }
  return Buffer.concat([header, ...metadata, archive.subarray(10)]);
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024,
    ...options
  });
  assert.equal(
    result.status,
    0,
    `${command} ${args.join(" ")} failed\n${result.stdout}\n${result.stderr}`
  );
  return result;
}

async function writeJson(file, value) {
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`);
}

async function fixtureRepo(t, options = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "patchpage-privacy-test-"));
  t.after(() => rm(root, { force: true, recursive: true }));

  const approvedName = "Release Maintainer";
  const approvedEmail = email("approved");
  const packageAuthor = options.packageAuthor ?? approvedName;
  const allowlist = reviewedIdentityForTests({
    gitEmail: approvedEmail,
    gitName: approvedName,
    packageAuthor: approvedName,
    reviewedCommitters: options.reviewedCommitters
  });

  await mkdir(path.join(root, "packages/cli"), { recursive: true });
  await writeJson(path.join(root, "packages/cli/package.json"), {
    name: "patchpage",
    version: "1.2.3",
    author: packageAuthor
  });
  await writeFile(path.join(root, "README.md"), "PatchPage fixture\n");

  run("git", ["init", "-q"], { cwd: root });
  run("git", ["add", "."], { cwd: root });
  run(
    "git",
    [
      "-c",
      `user.name=${approvedName}`,
      "-c",
      `user.email=${approvedEmail}`,
      "commit",
      "-m",
      "fixture",
      "-q"
    ],
    { cwd: root }
  );

  if (options.extraCommitAuthor || options.extraCommitter) {
    const author = options.extraCommitAuthor ?? {
      email: approvedEmail,
      name: approvedName
    };
    const committer = options.extraCommitter ?? {
      email: approvedEmail,
      name: approvedName
    };
    await writeFile(path.join(root, "release.txt"), "release\n");
    run("git", ["add", "release.txt"], { cwd: root });
    run(
      "git",
      [
        "-c",
        `user.name=${committer.name}`,
        "-c",
        `user.email=${committer.email}`,
        "commit",
        "-m",
        "release",
        "-q"
      ],
      {
        cwd: root,
        env: {
          ...process.env,
          GIT_AUTHOR_EMAIL: author.email,
          GIT_AUTHOR_NAME: author.name
        }
      }
    );
  }

  const artifactDir = path.join(root, ".artifacts");
  await mkdir(artifactDir);
  const packJsonPath = path.join(artifactDir, "pack.json");
  const tarballPath = path.join(artifactDir, "patchpage-1.2.3.tgz");

  const pack = {
    id: "patchpage@1.2.3",
    name: "patchpage",
    version: "1.2.3",
    filename: "patchpage-1.2.3.tgz",
    files: [
      { path: "dist/index.js", size: 18, mode: 0o644 },
      { path: "package.json", size: 80, mode: 0o644 }
    ],
    integrity: "sha512-fixture"
  };
  Object.assign(pack, options.packExtras);
  if (options.packFilePath) pack.files.push({ path: options.packFilePath, size: 1 });
  await writeJson(packJsonPath, [pack]);

  const packedPackage = {
    name: "patchpage",
    version: "1.2.3",
    author: options.packedAuthor ?? approvedName,
    ...options.packedPackageExtras
  };
  await writeFile(
    tarballPath,
    tgz([
      {
        name: "package/package.json",
        body: jsonBuffer(packedPackage)
      },
      {
        name: "package/dist/index.js",
        body: options.tarText ?? Buffer.from("console.log('ok');\n")
      },
      ...(options.extraTarEntries ?? [])
    ])
  );

  return { allowlist, approvedEmail, approvedName, packJsonPath, root, tarballPath };
}

async function addTrackedFile(root, relativePath, body) {
  const absolutePath = path.join(root, relativePath);
  await mkdir(path.dirname(absolutePath), { recursive: true });
  await writeFile(absolutePath, body);
  run("git", ["add", relativePath], { cwd: root });
}

function categories(failures) {
  return failures.map((failure) => failure.category).sort();
}

function verifyFixture(fixture, options = {}) {
  return verifyReleasePrivacy({
    allowlist: fixture.allowlist,
    packJsonPath: fixture.packJsonPath,
    repoRoot: fixture.root,
    tarballPath: fixture.tarballPath,
    ...options
  });
}

test("checks staged privacy sources without exempting later additions", async (t) => {
  const fixture = await fixtureRepo(t);
  const sourcePaths = [
    "scripts/verify-release-privacy.mjs",
    "scripts/verify-release-privacy.test.mjs"
  ];
  const originals = new Map();

  for (const relativePath of sourcePaths) {
    const body = await readFile(path.join(import.meta.dirname, path.basename(relativePath)));
    originals.set(relativePath, body);
    await addTrackedFile(fixture.root, relativePath, body);
  }

  assert.deepEqual(await verifyFixture(fixture), []);

  const privateArtifact = syntheticPath("home", "staged-source-check", `${"trans"}${"ript"}.jsonl`);
  for (const relativePath of sourcePaths) {
    const original = originals.get(relativePath);
    await addTrackedFile(
      fixture.root,
      relativePath,
      Buffer.concat([original, Buffer.from(`\n// ${privateArtifact}\n`)])
    );

    const failures = await verifyFixture(fixture);
    assert.deepEqual(categories(failures), [
      "tracked-text-home-path",
      privateCategory("tracked-text", "export")
    ]);
    assert.equal(formatFailures(failures).includes(privateArtifact), false);

    await addTrackedFile(fixture.root, relativePath, original);
    assert.deepEqual(await verifyFixture(fixture), []);
  }
});

test("accepts approved personal identity as author and committer", async (t) => {
  const fixture = await fixtureRepo(t);

  const failures = await verifyFixture(fixture);

  assert.deepEqual(failures, []);
});

test("rejects malformed tar end markers with opaque errors", async (t) => {
  const cases = [
    {
      message: /tar archive is missing the canonical end marker/,
      trailer: Buffer.alloc(512)
    },
    {
      message: /tar archive is missing the canonical end marker/,
      trailer: Buffer.alloc(0)
    },
    {
      message: /tar archive has nonzero trailing data/,
      trailer: Buffer.concat([Buffer.alloc(1024), Buffer.from([1])])
    }
  ];

  for (const testCase of cases) {
    const fixture = await fixtureRepo(t);
    await writeFile(
      fixture.tarballPath,
      tgz(
        [
          {
            name: "package/package.json",
            body: jsonBuffer({
              name: "patchpage",
              version: "1.2.3",
              author: fixture.approvedName
            })
          },
          {
            name: "package/dist/index.js",
            body: Buffer.from("console.log('ok');\n")
          }
        ],
        testCase.trailer
      )
    );

    await assert.rejects(() => verifyFixture(fixture), testCase.message);
  }
});

test("rejects nonzero tar alignment padding without leaking bytes", async (t) => {
  const hiddenValue = email("tar-padding");
  const fixture = await fixtureRepo(t, {
    extraTarEntries: [
      {
        name: "package/dist/padded.js",
        body: Buffer.from("x"),
        paddingPatch(padding) {
          padding.write(hiddenValue, 0, "utf8");
        }
      }
    ]
  });

  const result = spawnSync(
    process.execPath,
    [
      cli,
      "--repo-root",
      fixture.root,
      "--pack-json",
      fixture.packJsonPath,
      "--tarball",
      fixture.tarballPath
    ],
    { encoding: "utf8" }
  );
  const output = `${result.stdout}\n${result.stderr}`;

  assert.notEqual(result.status, 0);
  assert.match(output, /tar entry #[0-9]+ has nonzero alignment padding/);
  assert.equal(output.includes(hiddenValue), false);
});

test("rejects prohibited values in ignored raw tar header bytes", async (t) => {
  const leakedHeaderEmail = `a${String.fromCharCode(64)}b.invalid`;
  const fixture = await fixtureRepo(t, {
    extraTarEntries: [
      {
        name: "package/dist/raw-header.js",
        body: Buffer.from("console.log('ok');\n"),
        headerPatch(header) {
          header.write(leakedHeaderEmail, 500, 12, "utf8");
        }
      }
    ]
  });

  const failures = await verifyFixture(fixture);

  assert.deepEqual(categories(failures), ["tar-header-email"]);

  const result = spawnSync(
    process.execPath,
    [
      cli,
      "--repo-root",
      fixture.root,
      "--pack-json",
      fixture.packJsonPath,
      "--tarball",
      fixture.tarballPath
    ],
    { encoding: "utf8" }
  );
  const output = `${result.stdout}\n${result.stderr}`;

  assert.notEqual(result.status, 0);
  assert.match(output, /tar-header-email/);
  assert.equal(output.includes(leakedHeaderEmail), false);
});

test("rejects gzip filename and comment metadata without leaking values", async (t) => {
  const leakedFilename = `f${String.fromCharCode(64)}b.invalid`;
  const leakedComment = syntheticPath("Users", "gzip-comment-user", "repo");
  const fixture = await fixtureRepo(t);
  await writeFile(
    fixture.tarballPath,
    gzipWithMetadata(
      tarArchive([
        {
          name: "package/package.json",
          body: jsonBuffer({
            name: "patchpage",
            version: "1.2.3",
            author: fixture.approvedName
          })
        },
        {
          name: "package/dist/index.js",
          body: Buffer.from("console.log('ok');\n")
        }
      ]),
      { comment: leakedComment, filename: leakedFilename }
    )
  );

  const result = spawnSync(
    process.execPath,
    [
      cli,
      "--repo-root",
      fixture.root,
      "--pack-json",
      fixture.packJsonPath,
      "--tarball",
      fixture.tarballPath
    ],
    { encoding: "utf8" }
  );
  const output = `${result.stdout}\n${result.stderr}`;

  assert.notEqual(result.status, 0);
  assert.match(output, /gzip envelope is not the reviewed minimal form/);
  assert.equal(output.includes(leakedFilename), false);
  assert.equal(output.includes(leakedComment), false);
});

test("rejects a second gzip member with metadata without leaking values", async (t) => {
  const hiddenFilename = email("second-gzip");
  const hiddenComment = syntheticPath("Users", "second-gzip", "repo");
  const fixture = await fixtureRepo(t);
  const reviewedMember = await readFile(fixture.tarballPath);
  const secondMember = gzipWithMetadata(Buffer.alloc(0), {
    comment: hiddenComment,
    filename: hiddenFilename
  });
  await writeFile(fixture.tarballPath, Buffer.concat([reviewedMember, secondMember]));

  const result = spawnSync(
    process.execPath,
    [
      cli,
      "--repo-root",
      fixture.root,
      "--pack-json",
      fixture.packJsonPath,
      "--tarball",
      fixture.tarballPath
    ],
    { encoding: "utf8" }
  );
  const output = `${result.stdout}\n${result.stderr}`;

  assert.notEqual(result.status, 0);
  assert.match(output, /gzip envelope must contain exactly one reviewed member/);
  assert.equal(output.includes(hiddenFilename), false);
  assert.equal(output.includes(hiddenComment), false);
});

test("rejects malformed gzip envelopes opaquely", async (t) => {
  const reviewedEnvelope = tgz([]);
  const nonzeroMtime = Buffer.from(reviewedEnvelope);
  nonzeroMtime[4] = 1;
  const nonstandardXfl = Buffer.from(reviewedEnvelope);
  nonstandardXfl[8] = 0;
  const platformSpecificOs = Buffer.from(reviewedEnvelope);
  platformSpecificOs[9] = 3;
  const cases = [
    Buffer.from([0x1f, 0x8b, 8]),
    Buffer.from([0x1f, 0x8b, 8, 0x04, 0, 0, 0, 0, 0, 0]),
    Buffer.from([0x1f, 0x8b, 8, 0xe0, 0, 0, 0, 0, 0, 0]),
    nonzeroMtime,
    nonstandardXfl,
    platformSpecificOs
  ];

  for (const body of cases) {
    const fixture = await fixtureRepo(t);
    await writeFile(fixture.tarballPath, body);

    await assert.rejects(
      () => verifyFixture(fixture),
      /gzip envelope is not the reviewed minimal form/
    );
  }
});

test("accepts exact reviewed web-flow identity as committer", async (t) => {
  const reviewedWebFlowCommitter = {
    email: email("reviewed-web-flow"),
    name: "Reviewed Web Flow"
  };
  const fixture = await fixtureRepo(t, {
    extraCommitter: reviewedWebFlowCommitter,
    reviewedCommitters: [reviewedWebFlowCommitter]
  });

  const failures = await verifyFixture(fixture);

  assert.deepEqual(failures, []);
});

test("rejects release commit author outside the approved public identity", async (t) => {
  const fixture = await fixtureRepo(t, {
    extraCommitAuthor: {
      email: email("other"),
      name: "Other Maintainer"
    }
  });

  const failures = await verifyFixture(fixture);

  assert.deepEqual(categories(failures), ["release-commit-author"]);
});

test("rejects reviewed committer identity when used as author", async (t) => {
  const reviewedWebFlowCommitter = {
    email: email("reviewed-web-flow-author"),
    name: "Reviewed Web Flow"
  };
  const fixture = await fixtureRepo(t, {
    extraCommitAuthor: reviewedWebFlowCommitter,
    extraCommitter: reviewedWebFlowCommitter,
    reviewedCommitters: [reviewedWebFlowCommitter]
  });

  const failures = await verifyFixture(fixture);

  assert.deepEqual(categories(failures), ["release-commit-author"]);
});

test("rejects release commit committer outside the approved public identity", async (t) => {
  const fixture = await fixtureRepo(t, {
    extraCommitter: {
      email: email("committer"),
      name: "Other Committer"
    }
  });

  const failures = await verifyFixture(fixture);

  assert.deepEqual(categories(failures), ["release-commit-committer"]);
});

test("rejects source package author outside the approved public identity", async (t) => {
  const fixture = await fixtureRepo(t);
  await writeJson(path.join(fixture.root, "packages/cli/package.json"), {
    name: "patchpage",
    version: "1.2.3",
    author: "Other Maintainer"
  });

  const failures = await verifyFixture(fixture);

  assert.deepEqual(categories(failures), ["source-package-author"]);
});

test("rejects tracked path names and tracked textual disclosures", async (t) => {
  const fixture = await fixtureRepo(t);
  const badHome = syntheticPath("Users", "local-user", "project");
  const badTemp = syntheticPath("tmp", "npm-build-fixture", "package");
  const badArtifact = `notes/${privateStructuredArtifactName()}`;
  await addTrackedFile(
    fixture.root,
    path.join("notes", privateTextArtifactName()),
    [
      `contact ${email("leak")}`,
      `workspace ${badHome}`,
      `build ${badTemp}`,
      `export ${badArtifact}`
    ].join("\n")
  );

  const failures = await verifyFixture(fixture);

  assert.deepEqual(categories(failures), [
    privateCategory("tracked-path", "export-path"),
    "tracked-text-email",
    "tracked-text-home-path",
    privateCategory("tracked-text", "export"),
    "tracked-text-temp-build-path"
  ]);
});

test("scans tracked symlink target text", async (t) => {
  const fixture = await fixtureRepo(t);
  const linkPath = path.join(fixture.root, "linked-target");
  await symlink(syntheticPath("Users", "symlink-user", "repo"), linkPath);
  run("git", ["add", "linked-target"], { cwd: fixture.root });

  const failures = await verifyFixture(fixture);

  assert.deepEqual(categories(failures), ["tracked-text-home-path"]);
});

test("rejects private artifact components in tracked and tar link targets", async (t) => {
  const markerDirectory = `${privateKind(0)}-export`;
  const trackedTarget = ["safe", markerDirectory, "neutral.txt"].join("/");
  const trackedFixture = await fixtureRepo(t);
  const trackedLink = path.join(trackedFixture.root, "component-link");
  await symlink(trackedTarget, trackedLink);
  run("git", ["add", "component-link"], { cwd: trackedFixture.root });

  const trackedFailures = await verifyFixture(trackedFixture);
  assert.deepEqual(categories(trackedFailures), [privateCategory("tracked-text", "export-path")]);
  assert.equal(formatFailures(trackedFailures).includes(trackedTarget), false);

  const effectiveTarget = ["safe", markerDirectory, "effective.txt"].join("/");
  const rawTarget = ["safe", markerDirectory, "raw.txt"].join(String.fromCharCode(92));
  const tarFixture = await fixtureRepo(t, {
    extraTarEntries: [
      {
        body: paxBody({ linkpath: effectiveTarget }),
        name: "package/PaxHeader/component-link",
        type: "x"
      },
      {
        linkName: rawTarget,
        name: "package/bin/component-link",
        type: "2"
      }
    ]
  });

  const tarFailures = await verifyFixture(tarFixture);
  assert.deepEqual(categories(tarFailures), [
    privateCategory("tar-link", "export-path"),
    privateCategory("tar-link", "export-path")
  ]);
  const tarOutput = formatFailures(tarFailures);
  assert.equal(tarOutput.includes(effectiveTarget), false);
  assert.equal(tarOutput.includes(rawTarget), false);
});

test("fails closed on oversized tracked and tar text", async (t) => {
  const fixture = await fixtureRepo(t, {
    extraTarEntries: [
      {
        name: "package/large.txt",
        body: Buffer.from("x".repeat(512), "utf8")
      }
    ]
  });
  await addTrackedFile(fixture.root, "large.txt", "x".repeat(512));

  const failures = await verifyFixture(fixture, {
    tarTextLimitBytes: 400,
    trackedTextLimitBytes: 400
  });

  assert.deepEqual(categories(failures), ["tar-text-size-limit", "tracked-text-size-limit"]);
});

test("scans tracked and tar binary blobs for prohibited signatures", async (t) => {
  const fixture = await fixtureRepo(t, {
    extraTarEntries: [
      {
        name: "package/dist/binary.bin",
        body: binarySignatureBlob({
          emailValue: email("tar-binary"),
          homePath: syntheticPath("Users", "tar-binary-user", "repo"),
          artifactValue: privateStructuredArtifactName(),
          tempPath: syntheticPath("tmp", "tar-binary-build", "repo")
        })
      }
    ]
  });
  await addTrackedFile(
    fixture.root,
    "binary.bin",
    binarySignatureBlob({
      emailValue: email("tracked-binary"),
      homePath: syntheticPath("Users", "tracked-binary-user", "repo"),
      artifactValue: privateStructuredArtifactName(),
      tempPath: syntheticPath("tmp", "tracked-binary-build", "repo")
    })
  );

  const failures = await verifyFixture(fixture);

  assert.deepEqual(categories(failures), [
    "tar-binary-unreviewed",
    "tar-text-email",
    "tar-text-home-path",
    privateCategory("tar-text", "export"),
    "tar-text-temp-build-path",
    "tracked-binary-unreviewed",
    "tracked-text-email",
    "tracked-text-home-path",
    privateCategory("tracked-text", "export"),
    "tracked-text-temp-build-path"
  ]);
});

test("rejects otherwise clean tracked and tar binary blobs", async (t) => {
  const cleanBinary = Buffer.from([0, 255, 254, 0]);
  const fixture = await fixtureRepo(t, {
    extraTarEntries: [
      {
        name: "package/dist/clean-binary.bin",
        body: cleanBinary
      }
    ]
  });
  await addTrackedFile(fixture.root, "clean-binary.bin", cleanBinary);

  const failures = await verifyFixture(fixture);

  assert.deepEqual(categories(failures), ["tar-binary-unreviewed", "tracked-binary-unreviewed"]);
});

test("binary blob failure output redacts embedded signatures", async (t) => {
  const leakedBinaryEmail = email("redacted-binary-only");
  const leakedBinaryHome = syntheticPath("Users", "redacted-binary-only", "repo");
  const leakedBinaryArtifact = privateStructuredArtifactName();
  const leakedBinaryTemp = syntheticPath("tmp", "redacted-binary-only", "repo");
  const leakedBinaryBlob = binarySignatureBlob({
    emailValue: leakedBinaryEmail,
    homePath: leakedBinaryHome,
    artifactValue: leakedBinaryArtifact,
    tempPath: leakedBinaryTemp
  });
  const fixture = await fixtureRepo(t, {
    extraTarEntries: [
      {
        name: "package/dist/binary-output.bin",
        body: leakedBinaryBlob
      }
    ]
  });
  await addTrackedFile(fixture.root, "binary-output.bin", leakedBinaryBlob);

  const result = spawnSync(
    process.execPath,
    [
      cli,
      "--repo-root",
      fixture.root,
      "--pack-json",
      fixture.packJsonPath,
      "--tarball",
      fixture.tarballPath
    ],
    { encoding: "utf8" }
  );
  const output = `${result.stdout}\n${result.stderr}`;

  assert.notEqual(result.status, 0);
  assert.match(output, /tracked-binary-unreviewed/);
  assert.match(output, /tar-binary-unreviewed/);
  assert.match(output, /tracked-text-email/);
  assert.match(output, /tar-text-email/);
  for (const secret of [
    leakedBinaryEmail,
    leakedBinaryHome,
    leakedBinaryArtifact,
    leakedBinaryTemp
  ]) {
    assert.equal(output.includes(secret), false);
  }
});

test("rejects expanded home and temp path forms", async (t) => {
  const cases = [
    {
      category: "tar-text-home-path",
      value: `~${syntheticPath("workspace")}`
    },
    {
      category: "tar-text-home-path",
      value: fileUrlPath("Users", "fixture-user", "workspace")
    },
    {
      category: "tar-text-home-path",
      value: windowsPath("C", "Users", "fixture-user", "workspace")
    },
    {
      category: "tar-text-temp-build-path",
      value: syntheticPath("private", "tmp", "fixture")
    },
    {
      category: "tar-text-temp-build-path",
      value: syntheticPath("var", "tmp", "fixture")
    },
    {
      category: "tar-text-temp-build-path",
      value: windowsPath("C", "Windows", "Temp", "fixture")
    },
    {
      category: "tar-text-temp-build-path",
      value: windowsEnvPath("TEMP", "fixture")
    }
  ];

  for (const testCase of cases) {
    const fixture = await fixtureRepo(t, {
      tarText: Buffer.from(`path ${testCase.value}\n`, "utf8")
    });

    const failures = await verifyFixture(fixture);

    assert.deepEqual(categories(failures), [testCase.category]);
  }
});

test("rejects plain, archive, html, and non-text private artifact names and identifier fields", async (t) => {
  const fixture = await fixtureRepo(t, {
    extraTarEntries: [
      {
        name: `package/${privateKind(2)}.zip`,
        body: Buffer.from([0, 1, 2])
      }
    ],
    packExtras: {
      [privateIdentifierKey(0)]: "opaque"
    },
    packFilePath: `logs/${"trans"}${"ript"}.html`,
    tarText: Buffer.from(`${privateIdentifierKey(1)}: opaque\n`, "utf8")
  });
  await addTrackedFile(
    fixture.root,
    path.join("exports", `${privateKind(0)}-export`),
    Buffer.from([0, 1, 2])
  );
  await addTrackedFile(
    fixture.root,
    "metadata.json",
    JSON.stringify({ [privateIdentifierKey(2)]: "opaque" })
  );

  const failures = await verifyFixture(fixture);

  assert.deepEqual(
    categories(failures),
    [
      privateCategory("pack-json-path", "export-path"),
      privateCategory("pack-json", "identifier-field"),
      privateCategory("pack-json", "export"),
      "tar-binary-unreviewed",
      privateCategory("tar-entry", "export-path"),
      privateCategory("tar-header", "export"),
      privateCategory("tar-text", "identifier-field"),
      "tracked-binary-unreviewed",
      privateCategory("tracked-json", "identifier-field"),
      privateCategory("tracked-path", "export-path"),
      privateCategory("tracked-text", "identifier-field")
    ].sort()
  );
});

test("rejects private artifact markers in every path component", async (t) => {
  const markerDirectory = `${privateKind(0)}-export`;

  const trackedFixture = await fixtureRepo(t);
  const trackedPath = path.join("safe", markerDirectory, "neutral.txt");
  await addTrackedFile(trackedFixture.root, trackedPath, "neutral\n");
  const trackedFailures = await verifyFixture(trackedFixture);
  assert.deepEqual(categories(trackedFailures), [privateCategory("tracked-path", "export-path")]);
  assert.equal(formatFailures(trackedFailures).includes(trackedPath), false);

  const packPath = ["safe", markerDirectory, "neutral.js"].join(String.fromCharCode(92));
  const packFixture = await fixtureRepo(t, { packFilePath: packPath });
  const packFailures = await verifyFixture(packFixture);
  assert.deepEqual(categories(packFailures), [privateCategory("pack-json-path", "export-path")]);
  assert.equal(formatFailures(packFailures).includes(packPath), false);

  const effectivePath = ["package", markerDirectory, "neutral.js"].join("/");
  const rawPath = ["package", markerDirectory, "neutral.js"].join(String.fromCharCode(92));
  const tarFixture = await fixtureRepo(t, {
    extraTarEntries: [
      {
        body: paxBody({ path: effectivePath }),
        name: "package/PaxHeader/component-path",
        type: "x"
      },
      {
        name: rawPath,
        body: Buffer.from("neutral\n")
      }
    ]
  });
  const tarFailures = await verifyFixture(tarFixture);
  assert.deepEqual(categories(tarFailures), [
    privateCategory("tar-entry", "export-path"),
    privateCategory("tar-entry", "export-path")
  ]);
  const tarOutput = formatFailures(tarFailures);
  assert.equal(tarOutput.includes(effectivePath), false);
  assert.equal(tarOutput.includes(rawPath), false);
});

test("rejects traversal components in raw and effective tar entry names", async (t) => {
  const rawName = ["package", "..", "outside", "neutral.js"].join(String.fromCharCode(92));
  const effectiveName = ["package", "..", "effective", "neutral.js"].join("/");
  const fixture = await fixtureRepo(t, {
    extraTarEntries: [
      {
        name: rawName,
        body: Buffer.from("neutral\n")
      },
      {
        body: paxBody({ path: effectiveName }),
        name: "package/PaxHeader/traversal-path",
        type: "x"
      },
      {
        name: "package/dist/effective-short.js",
        body: Buffer.from("neutral\n")
      }
    ]
  });

  const failures = await verifyFixture(fixture);
  assert.deepEqual(categories(failures), ["tar-entry-traversal-path", "tar-entry-traversal-path"]);
  const output = formatFailures(failures);
  assert.equal(output.includes(rawName), false);
  assert.equal(output.includes(effectiveName), false);
});

test("rejects non-exempt temp paths that share an exempt prefix", async (t) => {
  const fixture = await fixtureRepo(t);
  await addTrackedFile(
    fixture.root,
    "temp.txt",
    `path ${syntheticPath("tmp", "consumer", "other")}\n`
  );

  const failures = await verifyFixture(fixture);

  assert.deepEqual(categories(failures), ["tracked-text-temp-build-path"]);
});

test("accepts reserved example-domain synthetic identity text", async (t) => {
  const reservedEmail = `${"security"}${String.fromCharCode(64)}example.com`;
  const fixture = await fixtureRepo(t, {
    extraTarEntries: [
      {
        name: `package/docs/${reservedEmail}/index.txt`,
        body: Buffer.from("reserved\n")
      },
      {
        linkName: `package/${reservedEmail}/index.txt`,
        name: "package/bin/reserved-link",
        type: "2"
      }
    ],
    packFilePath: `dist/${reservedEmail}/index.js`
  });
  await addTrackedFile(
    fixture.root,
    path.join("reserved", reservedEmail, "index.txt"),
    `Example Maintainer <${reservedEmail}>\n`
  );

  const failures = await verifyFixture(fixture);

  assert.deepEqual(failures, []);
});

test("rejects non-allowlisted emails in path-like fields with redacted locations", async (t) => {
  const leakedPathEmail = email("path-policy");
  const fixture = await fixtureRepo(t, {
    extraTarEntries: [
      {
        name: `package/docs/${leakedPathEmail}.txt`,
        body: Buffer.from("benign\n")
      },
      {
        linkName: `package/${leakedPathEmail}`,
        name: "package/bin/path-email-link",
        type: "2"
      }
    ],
    packFilePath: `dist/${leakedPathEmail}.js`
  });
  await addTrackedFile(fixture.root, path.join("paths", `${leakedPathEmail}.txt`), "benign\n");

  const failures = await verifyFixture(fixture);

  assert.deepEqual(categories(failures), [
    "pack-json-email",
    "pack-json-path-email",
    "tar-entry-email",
    "tar-header-email",
    "tar-header-email",
    "tar-link-email",
    "tracked-path-email"
  ]);

  const result = spawnSync(
    process.execPath,
    [
      cli,
      "--repo-root",
      fixture.root,
      "--pack-json",
      fixture.packJsonPath,
      "--tarball",
      fixture.tarballPath
    ],
    { encoding: "utf8" }
  );
  const output = `${result.stdout}\n${result.stderr}`;

  assert.notEqual(result.status, 0);
  assert.match(output, /tracked-path-email/);
  assert.match(output, /pack-json-path-email/);
  assert.equal(output.includes(leakedPathEmail), false);
});

test("rejects non-allowlisted identity text by email without prose overmatch", async (t) => {
  const fixture = await fixtureRepo(t);
  await addTrackedFile(
    fixture.root,
    "other-identity.txt",
    `prose before Other Maintainer <${email("identity")}>\n`
  );

  const failures = await verifyFixture(fixture);

  assert.deepEqual(categories(failures), ["tracked-text-email"]);
});

test("rejects npm pack JSON metadata and file path disclosures", async (t) => {
  const fixture = await fixtureRepo(t, {
    packExtras: {
      [localField("where")]: syntheticPath("Users", "pack-user", "repo"),
      nested: {
        [localField("resolved")]: `https://registry.example.invalid/${email("pack")}`,
        [localField("integrity")]: "sha512-local",
        [localField("npmOperationalInternal")]: { tmp: syntheticPath("tmp", "npm-local-fixture") }
      }
    },
    packFilePath: `logs/${privateTextArtifactName()}`
  });

  const failures = await verifyFixture(fixture);

  assert.deepEqual(categories(failures), [
    "pack-json-email",
    "pack-json-home-path",
    "pack-json-npm-local-field",
    "pack-json-npm-local-field",
    "pack-json-npm-local-field",
    "pack-json-npm-local-field",
    privateCategory("pack-json-path", "export-path"),
    privateCategory("pack-json", "export"),
    "pack-json-temp-build-path"
  ]);
});

test("rejects tar entry names, tar text, and packed package metadata disclosures", async (t) => {
  const badHome = syntheticPath("Users", "tar-user", "repo");
  const badTemp = syntheticPath("tmp", "package-build-fixture", "repo");
  const ordinaryTemp = syntheticPath("tmp", "ordinary-fixture", "repo");
  const fixture = await fixtureRepo(t, {
    extraTarEntries: [
      {
        name: `package/${privateTextArtifactName()}`,
        body: Buffer.from("old export\n")
      },
      {
        name: "/absolute-entry.txt",
        body: Buffer.from("absolute\n")
      }
    ],
    packedAuthor: `Other Maintainer <${email("packed")}>`,
    packedPackageExtras: {
      [localField("resolved")]: badHome,
      [localField("integrity")]: "sha512-local",
      [localField("npmOperationalInternal")]: { tmp: badTemp }
    },
    tarText: Buffer.from(
      [
        `contact ${email("tar")}`,
        `workspace ${badHome}`,
        `build ${ordinaryTemp}`,
        `export ${privateStructuredArtifactName()}`
      ].join("\n")
    )
  });

  const failures = await verifyFixture(fixture);

  assert.deepEqual(categories(failures), [
    "packed-package-author",
    "packed-package-json-email",
    "packed-package-json-home-path",
    "packed-package-json-npm-local-field",
    "packed-package-json-npm-local-field",
    "packed-package-json-npm-local-field",
    "packed-package-json-temp-build-path",
    "tar-entry-absolute-path",
    privateCategory("tar-entry", "export-path"),
    privateCategory("tar-header", "export"),
    "tar-text-email",
    "tar-text-home-path",
    privateCategory("tar-text", "export"),
    "tar-text-temp-build-path"
  ]);
});

test("rejects sensitive or unsafe tar link targets", async (t) => {
  const absoluteHomeLinkTarget = syntheticPath("Users", "link-user", privateTextArtifactName());
  const absoluteTempLinkTarget = syntheticPath("tmp", "link-build-fixture", "cache");
  const fixture = await fixtureRepo(t, {
    extraTarEntries: [
      {
        linkName: absoluteHomeLinkTarget,
        name: "package/bin/home-link",
        type: "2"
      },
      {
        linkName: `package/${email("tar-link")}`,
        name: "package/bin/email-link",
        type: "2"
      },
      {
        linkName: absoluteTempLinkTarget,
        name: "package/bin/temp-link",
        type: "1"
      },
      {
        linkName: "../outside/release.txt",
        name: "package/bin/traversal-link",
        type: "2"
      }
    ]
  });

  const failures = await verifyFixture(fixture);

  assert.deepEqual(categories(failures), [
    "tar-header-email",
    privateCategory("tar-header", "export"),
    "tar-link-absolute-path",
    "tar-link-absolute-path",
    "tar-link-email",
    "tar-link-home-path",
    privateCategory("tar-link", "export"),
    privateCategory("tar-link", "export-path"),
    "tar-link-temp-build-path",
    "tar-link-traversal-path"
  ]);
});

test("rejects PAX and GNU tar metadata with prohibited values", async (t) => {
  const paxLinkTarget = syntheticPath("Users", "pax-link-user", "repo");
  const gnuLinkTarget = syntheticPath("tmp", "gnu-longlink-build", "repo");
  const fixture = await fixtureRepo(t, {
    extraTarEntries: [
      {
        body: paxBody({
          linkpath: paxLinkTarget,
          path: `package/${privateTextArtifactName()}`
        }),
        name: "package/PaxHeader/pax",
        type: "x"
      },
      {
        linkName: "relative-pax-target",
        name: "package/pax-short",
        type: "2"
      },
      {
        body: gnuLongBody(`package/${privateStructuredArtifactName()}`),
        name: "././@LongLink",
        type: "L"
      },
      {
        name: "package/gnu-longname-short",
        body: Buffer.from("gnu longname body\n")
      },
      {
        body: gnuLongBody(gnuLinkTarget),
        name: "././@LongLink",
        type: "K"
      },
      {
        linkName: "relative-gnu-target",
        name: "package/gnu-longlink-short",
        type: "2"
      }
    ]
  });

  const failures = await verifyFixture(fixture);

  assert.deepEqual(categories(failures), [
    privateCategory("tar-entry", "export-path"),
    privateCategory("tar-entry", "export-path"),
    "tar-link-absolute-path",
    "tar-link-absolute-path",
    "tar-link-home-path",
    "tar-link-temp-build-path",
    "tar-metadata-home-path",
    privateCategory("tar-metadata", "export"),
    privateCategory("tar-metadata", "export"),
    "tar-metadata-temp-build-path"
  ]);
});

test("tar metadata failure output uses opaque redacted locations", async (t) => {
  const leakedPaxPath = `package/${email("redacted-pax-metadata")}/${privateTextArtifactName()}`;
  const leakedGnuLongName = `package/${email("redacted-gnu-longname")}/${privateStructuredArtifactName()}`;
  const leakedGnuLongLink = syntheticPath("Users", "redacted-gnu-longlink", "repo");
  const fixture = await fixtureRepo(t, {
    extraTarEntries: [
      {
        body: paxBody({ path: leakedPaxPath }),
        name: "package/PaxHeader/redacted",
        type: "x"
      },
      {
        name: "package/pax-redacted-short",
        body: Buffer.from("pax body\n")
      },
      {
        body: gnuLongBody(leakedGnuLongName),
        name: "././@LongLink",
        type: "L"
      },
      {
        name: "package/gnu-longname-redacted-short",
        body: Buffer.from("gnu body\n")
      },
      {
        body: gnuLongBody(leakedGnuLongLink),
        name: "././@LongLink",
        type: "K"
      },
      {
        linkName: "relative-redacted-target",
        name: "package/gnu-longlink-redacted-short",
        type: "2"
      }
    ]
  });

  const result = spawnSync(
    process.execPath,
    [
      cli,
      "--repo-root",
      fixture.root,
      "--pack-json",
      fixture.packJsonPath,
      "--tarball",
      fixture.tarballPath
    ],
    { encoding: "utf8" }
  );
  const output = `${result.stdout}\n${result.stderr}`;

  assert.notEqual(result.status, 0);
  assert.match(output, /tar-metadata-email/);
  assert.match(output, /tar-link-home-path/);
  for (const secret of [
    leakedPaxPath,
    leakedGnuLongName,
    leakedGnuLongLink,
    email("redacted-pax-metadata"),
    email("redacted-gnu-longname")
  ]) {
    assert.equal(output.includes(secret), false);
  }
});

test("rejects PAX size overrides without truncating hidden bodies", async (t) => {
  const fixture = await fixtureRepo(t, {
    extraTarEntries: [
      {
        body: paxBody({ size: "0" }),
        name: "package/PaxHeader/size",
        type: "x"
      },
      {
        name: "package/dist/pax-size-body.bin",
        body: Buffer.alloc(1024)
      },
      {
        name: "package/dist/after-pax-size.js",
        body: Buffer.from(`contact ${email("after-pax-size")}\n`)
      }
    ]
  });

  const failures = await verifyFixture(fixture);

  assert.deepEqual(categories(failures), [
    "tar-binary-unreviewed",
    "tar-metadata-unsupported",
    "tar-text-email"
  ]);
});

test("rejects nonzero tar header uid and gid", async (t) => {
  const fixture = await fixtureRepo(t, {
    extraTarEntries: [
      {
        name: "package/dist/nonzero-owner.bin",
        body: Buffer.from("owner\n"),
        owner: { gid: 20, uid: 501 }
      }
    ]
  });

  const failures = await verifyFixture(fixture);

  assert.deepEqual(categories(failures), ["tar-owner-gid", "tar-owner-uid"]);
});

test("rejects nonempty tar header uname and gname", async (t) => {
  const fixture = await fixtureRepo(t, {
    extraTarEntries: [
      {
        name: "package/dist/named-owner.bin",
        body: Buffer.from("owner\n"),
        owner: { gname: "group", uname: "user" }
      }
    ]
  });

  const failures = await verifyFixture(fixture);

  assert.deepEqual(categories(failures), ["tar-owner-gname", "tar-owner-uname"]);
});

test("rejects PAX local owner overrides that do not normalize", async (t) => {
  const fixture = await fixtureRepo(t, {
    extraTarEntries: [
      {
        body: paxBody({
          gid: "20",
          gname: "group",
          uid: "501",
          uname: "user"
        }),
        name: "package/PaxHeader/owner",
        type: "x"
      },
      {
        name: "package/dist/pax-owner.bin",
        body: Buffer.from("owner\n")
      }
    ]
  });

  const failures = await verifyFixture(fixture);

  assert.deepEqual(categories(failures), [
    "tar-owner-gid",
    "tar-owner-gname",
    "tar-owner-uid",
    "tar-owner-uname"
  ]);
});

test("rejects duplicate PAX keys before owner values can be replaced", async (t) => {
  const hiddenOwner = email("duplicate-pax-owner");
  const fixture = await fixtureRepo(t, {
    extraTarEntries: [
      {
        body: paxBodyEntries([
          ["uid", "501"],
          ["uid", "0"]
        ]),
        name: "package/PaxHeader/duplicate-uid",
        type: "x"
      },
      {
        name: "package/dist/after-duplicate-uid.bin",
        body: Buffer.from("owner\n")
      },
      {
        body: paxBodyEntries([
          ["uname", hiddenOwner],
          ["uname", ""]
        ]),
        name: "package/PaxHeader/duplicate-uname",
        type: "x"
      },
      {
        name: "package/dist/after-duplicate-uname.bin",
        body: Buffer.from("owner\n")
      }
    ]
  });

  const failures = await verifyFixture(fixture);
  assert.deepEqual(categories(failures), [
    "tar-metadata-duplicate-key",
    "tar-metadata-duplicate-key",
    "tar-metadata-email"
  ]);

  const result = spawnSync(
    process.execPath,
    [
      cli,
      "--repo-root",
      fixture.root,
      "--pack-json",
      fixture.packJsonPath,
      "--tarball",
      fixture.tarballPath
    ],
    { encoding: "utf8" }
  );
  const output = `${result.stdout}\n${result.stderr}`;
  assert.notEqual(result.status, 0);
  assert.match(output, /tar-metadata-duplicate-key/);
  assert.equal(output.includes(hiddenOwner), false);
});

test("merges sequential PAX local owner overrides field by field", async (t) => {
  const fixture = await fixtureRepo(t, {
    extraTarEntries: [
      {
        body: paxBody({ uid: "501" }),
        name: "package/PaxHeader/owner-uid",
        type: "x"
      },
      {
        body: paxBody({ gid: "0" }),
        name: "package/PaxHeader/owner-gid",
        type: "x"
      },
      {
        name: "package/dist/pax-owner-merged.bin",
        body: Buffer.from("owner\n")
      }
    ]
  });

  const failures = await verifyFixture(fixture);

  assert.deepEqual(categories(failures), ["tar-owner-uid"]);
});

test("rejects global PAX owner overrides", async (t) => {
  const fixture = await fixtureRepo(t, {
    extraTarEntries: [
      {
        body: paxBody({ uid: "501" }),
        name: "package/PaxHeader/global-owner",
        type: "g"
      }
    ]
  });

  const failures = await verifyFixture(fixture);

  assert.deepEqual(categories(failures), ["tar-owner-pax-global-unsupported", "tar-owner-uid"]);
});

test("rejects raw header owner laundering through PAX overrides", async (t) => {
  const fixture = await fixtureRepo(t, {
    extraTarEntries: [
      {
        body: paxBody({ uid: "0" }),
        name: "package/PaxHeader/launder-owner",
        type: "x"
      },
      {
        name: "package/dist/laundered-owner.bin",
        body: Buffer.from("owner\n"),
        owner: { uid: 501 }
      }
    ]
  });

  const failures = await verifyFixture(fixture);

  assert.deepEqual(categories(failures), ["tar-owner-uid"]);
});

test("rejects raw link target laundering through PAX overrides", async (t) => {
  const fixture = await fixtureRepo(t, {
    extraTarEntries: [
      {
        body: paxBody({ linkpath: "package/clean-target" }),
        name: "package/PaxHeader/launder-link",
        type: "x"
      },
      {
        linkName: syntheticPath("Users", "raw-link-user", privateTextArtifactName()),
        name: "package/bin/laundered-link",
        type: "2"
      }
    ]
  });

  const failures = await verifyFixture(fixture);

  assert.deepEqual(categories(failures), [
    privateCategory("tar-header", "export"),
    "tar-link-absolute-path",
    "tar-link-home-path",
    privateCategory("tar-link", "export"),
    privateCategory("tar-link", "export-path")
  ]);
});

test("rejects dangling invalid PAX owner maps", async (t) => {
  const fixture = await fixtureRepo(t, {
    extraTarEntries: [
      {
        body: paxBody({ uid: "501" }),
        name: "package/PaxHeader/dangling-owner",
        type: "x"
      }
    ]
  });

  const failures = await verifyFixture(fixture);

  assert.deepEqual(categories(failures), ["tar-owner-uid"]);
});

test("rejects invalid PAX owner maps overwritten before use", async (t) => {
  const fixture = await fixtureRepo(t, {
    extraTarEntries: [
      {
        body: paxBody({ uid: "501" }),
        name: "package/PaxHeader/invalid-owner",
        type: "x"
      },
      {
        body: paxBody({ uid: "0" }),
        name: "package/PaxHeader/normalized-owner",
        type: "x"
      },
      {
        name: "package/dist/overwritten-owner.bin",
        body: Buffer.from("owner\n")
      }
    ]
  });

  const failures = await verifyFixture(fixture);

  assert.deepEqual(categories(failures), ["tar-owner-uid"]);
});

test("accepts clean normalized tar owner metadata", async (t) => {
  const fixture = await fixtureRepo(t, {
    extraTarEntries: [
      {
        name: "package/dist/normalized-owner.bin",
        body: Buffer.from("owner\n"),
        owner: { gid: 0, gname: "", uid: 0, uname: "" }
      },
      {
        body: paxBody({
          gid: "0",
          gname: "",
          uid: "0",
          uname: ""
        }),
        name: "package/PaxHeader/normalized-owner",
        type: "x"
      },
      {
        name: "package/dist/pax-normalized-owner.bin",
        body: Buffer.from("owner\n")
      }
    ]
  });

  const failures = await verifyFixture(fixture);

  assert.deepEqual(failures, []);
});

test("fails closed on oversized tar metadata bodies", async (t) => {
  const fixture = await fixtureRepo(t, {
    extraTarEntries: [
      {
        body: Buffer.from("x".repeat(512), "utf8"),
        name: "package/PaxHeader/large",
        type: "x"
      }
    ]
  });

  const failures = await verifyFixture(fixture, {
    tarTextLimitBytes: 400
  });

  assert.deepEqual(categories(failures), ["tar-metadata-size-limit"]);
});

test("accepts clean empty tar directory entries", async (t) => {
  const fixture = await fixtureRepo(t, {
    extraTarEntries: [
      {
        name: "package/docs/",
        type: "5"
      }
    ]
  });

  const failures = await verifyFixture(fixture);

  assert.deepEqual(failures, []);
});

test("rejects empty tar metadata bodies opaquely", async (t) => {
  const metadataTypes = ["L", "K", "x", "g"];
  const entryNames = metadataTypes.map((_type, index) => `package/empty-metadata-${index + 1}`);
  const fixture = await fixtureRepo(t, {
    extraTarEntries: metadataTypes.map((type, index) => ({
      name: entryNames[index],
      type
    }))
  });

  const failures = await verifyFixture(fixture);
  assert.deepEqual(
    categories(failures),
    metadataTypes.map(() => "tar-metadata-invalid")
  );
  const output = formatFailures(failures);
  for (const entryName of entryNames) {
    assert.equal(output.includes(entryName), false);
  }
});

test("rejects unsupported zero-body tar typeflags opaquely", async (t) => {
  const unsupportedTypes = ["3", "4", "6", "7", "S", "?"];
  const entryNames = unsupportedTypes.map(
    (_type, index) => `package/unsupported-type-${index + 1}`
  );
  const fixture = await fixtureRepo(t, {
    extraTarEntries: unsupportedTypes.map((type, index) => ({
      name: entryNames[index],
      type
    }))
  });

  const failures = await verifyFixture(fixture);
  assert.deepEqual(
    categories(failures),
    unsupportedTypes.map(() => "tar-entry-type-unsupported")
  );
  const output = formatFailures(failures);
  for (const entryName of entryNames) {
    assert.equal(output.includes(entryName), false);
  }
});

test("failure output reports categories and safe locations without leaking matched values", async (t) => {
  const leakedBinaryEmail = email("redacted-binary");
  const leakedBinaryHome = syntheticPath("Users", "redacted-binary-user", "repo");
  const leakedEmail = email("redacted");
  const leakedJsonKeyEmail = email("redacted-key");
  const leakedLinkEmail = email("redacted-link-target");
  const leakedLinkTarget = syntheticPath(
    "Users",
    "redacted-link-user",
    leakedLinkEmail,
    privateTextArtifactName()
  );
  const leakedPathEmail = email("redacted-path");
  const leakedTarNameEmail = email("redacted-tar-name");
  const leakedHome = syntheticPath("Users", "redacted-user", "repo");
  const leakedTemp = syntheticPath("tmp", "npm-redacted-fixture", "repo");
  const leakedOrdinaryTemp = syntheticPath("tmp", "ordinary-redacted", "repo");
  const leakedArtifact = privateTextArtifactName();
  const leakedBinaryBlob = binarySignatureBlob({
    emailValue: leakedBinaryEmail,
    homePath: leakedBinaryHome,
    artifactValue: privateStructuredArtifactName(),
    tempPath: leakedTemp
  });
  const fixture = await fixtureRepo(t, {
    extraTarEntries: [
      {
        name: `package/docs/${leakedTarNameEmail}.txt`,
        body: Buffer.from(`contact ${leakedTarNameEmail}\n`)
      },
      {
        linkName: leakedLinkTarget,
        name: "package/bin/redacted-link",
        type: "2"
      },
      {
        name: "package/dist/redacted-binary.bin",
        body: leakedBinaryBlob
      }
    ],
    packExtras: {
      [leakedJsonKeyEmail]: "opaque"
    },
    packedPackageExtras: {
      [localField("where")]: leakedHome
    },
    tarText: Buffer.from(
      [
        `contact ${leakedEmail}`,
        `workspace ${leakedHome}`,
        `build ${leakedTemp}`,
        `cache ${leakedOrdinaryTemp}`
      ].join("\n")
    )
  });
  await addTrackedFile(fixture.root, "redacted-binary.bin", leakedBinaryBlob);
  await addTrackedFile(fixture.root, leakedArtifact, `export ${leakedTemp}\n`);
  await addTrackedFile(
    fixture.root,
    path.join("notes", `${leakedPathEmail}.txt`),
    `contact ${leakedPathEmail}\n`
  );

  const result = spawnSync(
    process.execPath,
    [
      cli,
      "--repo-root",
      fixture.root,
      "--pack-json",
      fixture.packJsonPath,
      "--tarball",
      fixture.tarballPath
    ],
    { encoding: "utf8" }
  );
  const output = `${result.stdout}\n${result.stderr}`;

  assert.notEqual(result.status, 0);
  assert.equal(output.includes(privateCategory("tracked-path", "export-path")), true);
  assert.match(output, /pack-json-key-email/);
  assert.match(output, /packed-package-json-npm-local-field/);
  assert.match(output, /tar-link-home-path/);
  for (const secret of [
    leakedBinaryEmail,
    leakedBinaryHome,
    leakedEmail,
    leakedJsonKeyEmail,
    leakedLinkEmail,
    leakedLinkTarget,
    leakedPathEmail,
    leakedTarNameEmail,
    leakedHome,
    leakedTemp,
    leakedOrdinaryTemp,
    leakedArtifact,
    fixture.approvedEmail,
    fixture.approvedName
  ]) {
    assert.equal(output.includes(secret), false);
  }

  const failures = await verifyFixture(fixture);
  assert.equal(formatFailures(failures).includes(leakedEmail), false);
});

import { describe, expect, it } from "vitest";
import { verifyPublishedFork } from "../src/installer/provenance.js";

const tag = "predict-0.17.4.2";
const sha256 = "a".repeat(64);
const commit = "b".repeat(40);
const releaseUrl = `https://github.com/CometDash77/weasel/releases/tag/${tag}`;
const lock = { releaseVerified: true, draft: false, prerelease: false, tag, sha256, bytes: 42, commit, releaseUrl, assetId: 17 };
const release = { draft: false, prerelease: false, tag_name: tag, html_url: releaseUrl, assets: [{ id: 17, digest: `sha256:${sha256}`, size: 42 }] };
const ref = { object: { type: "commit", sha: commit } };
const archive = { sha256, bytes: 42 };

describe("published fork provenance", () => {
  it("binds the pinned bytes to the public stable release and tag commit", async () => {
    const queried: string[] = [];
    await verifyPublishedFork(lock, archive, async endpoint => { queried.push(endpoint); return endpoint.startsWith("releases/") ? release : ref; });
    expect(queried).toEqual([`releases/tags/${tag}`, `git/ref/tags/${tag}`]);
  });
  it("peels an annotated source tag", async () => {
    const tagSha = "c".repeat(40);
    await expect(verifyPublishedFork(lock, archive, async endpoint => endpoint.startsWith("releases/") ? release
      : endpoint.startsWith("git/ref/") ? { object: { type: "tag", sha: tagSha } } : ref)).resolves.toBeUndefined();
  });
  it("forging a local verified boolean cannot manufacture a missing release", async () => {
    await expect(verifyPublishedFork(lock, archive, async () => { throw new Error("GitHub 404"); })).rejects.toThrow("GitHub 404");
  });
  for (const [label, changed] of [
    ["draft", { ...release, draft: true }], ["prerelease", { ...release, prerelease: true }],
    ["wrong tag", { ...release, tag_name: "predict-0.17.4.1" }],
    ["foreign URL", { ...release, html_url: "https://example.com/release" }],
    ["missing asset", { ...release, assets: [] }],
    ["wrong digest", { ...release, assets: [{ id: 17, digest: "sha256:" + "d".repeat(64), size: 42 }] }],
    ["wrong size", { ...release, assets: [{ id: 17, digest: `sha256:${sha256}`, size: 43 }] }],
  ] as const) {
    it(`rejects ${label} despite a locally verified receipt`, async () => {
      await expect(verifyPublishedFork(lock, archive, async endpoint => endpoint.startsWith("releases/") ? changed : ref)).rejects.toThrow("provenance mismatch");
    });
  }
  it("rejects a tag that points to another source commit", async () => {
    await expect(verifyPublishedFork(lock, archive, async endpoint => endpoint.startsWith("releases/") ? release
      : { object: { type: "commit", sha: "d".repeat(40) } })).rejects.toThrow("tag/commit mismatch");
  });
  it("rejects an unpublished local input without querying the network", async () => {
    let calls = 0;
    await expect(verifyPublishedFork({ ...lock, releaseVerified: false }, archive, async () => { calls++; return release; })).rejects.toThrow("receipt is required");
    expect(calls).toBe(0);
  });
});

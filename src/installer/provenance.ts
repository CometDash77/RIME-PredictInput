interface JsonRecord { readonly [key: string]: unknown }
function record(value: unknown): JsonRecord {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid fork release metadata");
  return value as JsonRecord;
}

/** A local receipt is a pin, never proof that a public release exists. */
export async function verifyPublishedFork(
  receipt: unknown,
  archive: { readonly sha256: string; readonly bytes: number },
  api: (endpoint: string) => Promise<unknown>,
): Promise<void> {
  const lock = record(receipt);
  const tag = lock["tag"];
  if (typeof tag !== "string" || !/^(?:v0\.17\.4-predict\.|predict-0\.17\.4\.)([1-9][0-9]*)$/.test(tag)) throw new Error("Invalid fork release tag");
  if (lock["releaseVerified"] !== true || lock["draft"] !== false || lock["prerelease"] !== false
      || !Number.isSafeInteger(lock["assetId"])) throw new Error("A published fork release receipt is required");
  if (lock["sha256"] !== archive.sha256 || lock["bytes"] !== archive.bytes) throw new Error("Pinned archive mismatch");
  const release = record(await api(`releases/tags/${tag}`));
  const assetList = release["assets"];
  if (!Array.isArray(assetList)) throw new Error("Missing fork release assets");
  const asset = assetList.map(record).find(entry => entry["id"] === lock["assetId"]);
  const expectedUrl = `https://github.com/CometDash77/weasel/releases/tag/${tag}`;
  if (release["draft"] !== false || release["prerelease"] !== false || release["tag_name"] !== tag
      || release["html_url"] !== expectedUrl || lock["releaseUrl"] !== expectedUrl || asset === undefined
      || asset["size"] !== archive.bytes || asset["digest"] !== `sha256:${archive.sha256}`) {
    throw new Error("Fork public release provenance mismatch");
  }
  let object = record(record(await api(`git/ref/tags/${tag}`))["object"]);
  if (object["type"] === "tag") {
    const sha = object["sha"];
    if (typeof sha !== "string" || !/^[a-f0-9]{40}$/.test(sha)) throw new Error("Invalid annotated tag object");
    object = record(record(await api(`git/tags/${sha}`))["object"]);
  }
  if (object["type"] !== "commit" || object["sha"] !== lock["commit"]
      || typeof object["sha"] !== "string" || !/^[a-f0-9]{40}$/.test(object["sha"])) throw new Error("Fork tag/commit mismatch");
}

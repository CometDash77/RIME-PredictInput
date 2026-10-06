/**
 * What the editor can tell us about the text before the caret.
 *
 * `WeaselTSF` publishes three RIME properties; the Lua filter refuses to act
 * unless the status is exactly `ok` and a non-empty revision comes with it.
 * "The user confirmed there is no preceding text" and "the editor could not be
 * read" are different facts and must never collapse into one `null`.
 */
export type ContextSnapshot =
  | {
      readonly status: "ok";
      readonly revision: string;
      /** At most `MAX_CONTEXT_CHARS` Unicode scalar values, taken from the end. */
      readonly precedingText: string;
    }
  | {
      /** The editor is unreadable, or the user's window is protected. */
      readonly status: "unavailable" | "protected";
      readonly revision: string;
    };

export const MAX_CONTEXT_CHARS = 300;

/** Everything the sidecar can observe about the request's editor context. */
export function contextFromProperties(properties: {
  readonly status: string | null;
  readonly precedingText: string | null;
  readonly revision: string | null;
}): ContextSnapshot | null {
  const { status, precedingText, revision } = properties;
  if (status !== "ok") return null;
  if (typeof precedingText !== "string") return null;
  if (typeof revision !== "string" || revision === "") return null;
  return { status: "ok", revision, precedingText: truncateToScalars(precedingText, MAX_CONTEXT_CHARS) };
}

/** `utf8.offset`-equivalent: keep the last `limit` Unicode scalar values. */
export function truncateToScalars(value: string, limit: number): string {
  const scalars = [...value];
  return scalars.length <= limit ? value : scalars.slice(scalars.length - limit).join("");
}

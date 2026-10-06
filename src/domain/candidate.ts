/**
 * One candidate as the RIME filter sees it, and the page it belongs to.
 *
 * `start`/`end` are scalar offsets into the composition input, and the legacy
 * Lua code read them from both `candidate.start`/`candidate._end` (Lua) and the
 * serialized `start`/`end` (Python). They are modelled here as a single
 * immutable range so the two spellings cannot drift apart again.
 */
export interface CandidateSpan {
  readonly start: number;
  readonly end: number;
}

export interface CandidateRecord {
  readonly text: string;
  readonly preedit: string;
  readonly span: CandidateSpan;
  /** `model_predict` marks the shadow candidate this feature inserts itself. */
  readonly type?: string;
}

export const MAX_CANDIDATE_TEXT_SCALARS = 512;
export const MAX_CANDIDATES = 255;
export const MAX_PREEDIT_SCALARS = 256;
export const MAX_SPAN_OFFSET = 256;

export interface CandidatePage {
  /** Every candidate the previous filters produced, in display order. */
  readonly candidates: readonly CandidateRecord[];
  /** The schema's `menu/page_size`, clamped to 1..255 like the Lua filter does. */
  readonly pageSize: number;
  /** The whole input of the composition, used to derive pinyin and to validate spans. */
  readonly inputText: string;
}

export function clampPageSize(configured: number | null): number {
  if (typeof configured !== "number" || !Number.isInteger(configured)) return 5;
  return configured >= 1 && configured <= 255 ? configured : 5;
}

/**
 * `safe_candidates`: at most 255 non-empty texts of at most 512 scalars each.
 * Anything longer is user text that must not be shipped to the model.
 */
export function areCandidatesSafe(candidates: readonly string[]): boolean {
  if (candidates.length < 1 || candidates.length > MAX_CANDIDATES) return false;
  return candidates.every(
    (text) => text !== "" && [...text].length <= MAX_CANDIDATE_TEXT_SCALARS,
  );
}

/**
 * The preedit the model is told about. During filter evaluation the RIME menu is
 * not installed yet, so `get_preedit()` can still return raw input; the
 * translator's spelling plus its unconsumed tail is the correct reconstruction.
 */
export function effectivePinyin(candidate: CandidateRecord | undefined, inputText: string): string {
  if (candidate === undefined || candidate.preedit === "") return inputText;
  return candidate.preedit + [...inputText].slice(candidate.span.end).join("");
}

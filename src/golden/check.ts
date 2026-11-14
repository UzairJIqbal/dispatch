// CI's check on a pull request's golden set. The eval gate already grades
// with main's copy, so a PR can't move the goalposts it is judged by; this is
// what stops such a change from reaching main without a version bump.
import { GOLDEN_VERSION, parseGolden } from "./golden.js";
import { splitFor } from "./split.js";

const versionNumber = (v: string) => Number(v.slice(1));

/**
 * Problems with the PR's golden file, compared with main's. Empty means fine.
 * `base` is undefined when main has no golden file yet.
 */
export function checkGoldenChange(input: { base: string | undefined; head: string; changelog: string; file: string }): string[] {
  let head;
  try {
    head = parseGolden(input.head, input.file);
  } catch (err) {
    return [err instanceof Error ? err.message : String(err)];
  }
  const version = head.header.dataset_version;
  const out: string[] = [];

  if (version !== GOLDEN_VERSION) {
    out.push(`${input.file} says ${version} but GOLDEN_VERSION in src/golden/golden.ts is ${GOLDEN_VERSION}. Rebuild it with \`pnpm label\`.`);
  }
  // The split is a function of the id; a row that disagrees was moved by hand.
  const moved = head.rows.filter((r) => r.split !== splitFor(r.id)).length;
  if (moved > 0) out.push(`${String(moved)} rows in ${input.file} are in a split their id doesn't put them in. Splits come from the id alone.`);
  if (!new RegExp(`\\*\\*${version}\\*\\*`).test(input.changelog)) {
    out.push(`evals/CHANGELOG.md has no line for ${version}. Add one saying what changed and why.`);
  }

  if (input.base !== undefined && input.base !== input.head) {
    let baseVersion: string;
    try {
      baseVersion = parseGolden(input.base, `main's ${input.file}`).header.dataset_version;
    } catch (err) {
      return [...out, err instanceof Error ? err.message : String(err)];
    }
    if (versionNumber(version) <= versionNumber(baseVersion)) {
      out.push(
        `${input.file} changed but its version didn't go up (main has ${baseVersion}, this PR has ${version}). ` +
          `Bump GOLDEN_VERSION, add a line to evals/CHANGELOG.md saying why, and rebuild with \`pnpm label\`.`,
      );
    }
  }
  return out;
}

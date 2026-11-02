// The shape of worker/version.generated.ts, which worker/write-version.mjs writes before every
// bundle (it is not committed). This lets the Worker type-check in a fresh clone.
export declare const BUILD: {
  /** package.json's version. */
  version: string;
  /** The full commit SHA the Worker was built from, or "unknown". */
  commit: string;
  /** When that commit was made (ISO 8601), or "" when unknown. */
  commitDate: string;
  /** When the Worker was built (ISO 8601). */
  builtAt: string;
  branch: string;
  /** "owner/repo" of the GitHub repository it was built from, or "" when unknown. */
  repo: string;
};

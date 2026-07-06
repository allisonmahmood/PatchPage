export type DraftVisibility = "unlisted" | "public" | "private";

export interface UploadMetadata {
  repoOrg?: string | null;
  repoName?: string | null;
  gitBranch?: string | null;
  gitCommitSha?: string | null;
  cliVersion?: string | null;
  fileSha256?: string | null;
  [key: string]: unknown;
}

export interface HtmlValidationResult {
  ok: boolean;
  errors: string[];
  warnings: string[];
  title: string | null;
}

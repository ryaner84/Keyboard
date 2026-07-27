// Wire contract shared by the CSV import modal and the resolve/commit routes.

export const IMPORT_MAX_ROWS = 200;

export type ImportRowStatus =
  | "MATCHED"
  | "AMBIGUOUS"
  | "UNMATCHED"
  | "ALREADY_IN_COLLECTION"
  | "INVALID";

export type ImportAction = "LINK" | "CUSTOM" | "IGNORE";
export type ImportOnExisting = "APPEND" | "REPLACE";

// One parsed CSV line, already validated client-side by parseKeycapImportCsv.
export interface ImportRowPayload {
  line: number;
  name: string;
  kits: string[];
  quantity: number;
  acquiredAt: string | null;
  price: number | null;
  currency: string | null;
  condition: string | null;
  notes: string | null;
  errors: string[];
}

export interface ImportSetSummary {
  slug: string;
  name: string;
  imageUrl: string | null;
  designer: string | null;
  status: string;
}

export interface ResolvedImportRow {
  line: number;
  name: string;
  status: ImportRowStatus;
  match: ImportSetSummary | null;
  candidates: ImportSetSummary[];
  existingPurchaseCount?: number;
  errors: string[];
}

export interface ResolveImportResponse {
  rows: ResolvedImportRow[];
  summary: {
    matched: number;
    needsReview: number;
    alreadyOwned: number;
    invalid: number;
  };
}

export interface ImportDecision {
  line: number;
  action: ImportAction;
  slug?: string; // required for LINK
  onExisting?: ImportOnExisting; // used when the target is already collected
  row: ImportRowPayload;
}

export interface CommitImportResponse {
  results: Array<{
    line: number;
    ok: boolean;
    name: string;
    slug?: string;
    action: string;
    error?: string;
  }>;
  summary: {
    added: number;
    appended: number;
    replaced: number;
    ignored: number;
    failed: number;
  };
}

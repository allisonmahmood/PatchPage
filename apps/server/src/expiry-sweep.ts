import type { PatchPageDb } from "@patchpage/db";
import type { HtmlStorage } from "@patchpage/storage";
import type { Analytics } from "./analytics.js";

/**
 * The expiry sweep — the job that makes draft expiry real.
 *
 * A draft whose retention clock has run out already stops serving and refuses
 * updates; the row and its stored HTML are still there, still costing storage,
 * still counting against its creator's draft quota. The sweep is what finishes
 * the job: for each expired, unpinned draft it hard-deletes the record and then
 * the content behind it. There is no recovery — republishing is the way back.
 *
 * Order is deliberate. The record goes first, so a failure between the two
 * halves leaves unreachable objects rather than a live draft with no content;
 * an orphaned object costs storage, a contentless draft costs the reader the
 * page. Everything else follows from re-reading the database: a run is
 * idempotent, two runs overlapping is safe, and a draft pinned mid-run stays.
 *
 * There is no scheduler seam here on purpose. The sweep is a plain call on the
 * app, driven by the same injected clock the rest of the hosting seam uses, so
 * a test winds time forward and runs it. Deciding *when* to run is wiring, and
 * lives in `start.ts`.
 */

/** How many drafts one database listing asks for. */
const SWEEP_BATCH_SIZE = 100;

/**
 * The most drafts one run will take. A backlog is drained across runs rather
 * than in one unbounded pass, so the sweep never becomes the thing that stalls
 * a serving process.
 */
const SWEEP_MAX_DRAFTS_PER_RUN = 1_000;

export interface ExpirySweepResult {
  /** Drafts hard-deleted: record gone, content gone. */
  deleted: number;
  /** Drafts no longer the sweep's to take — pinned, or already swept. */
  skipped: number;
  /** Drafts whose delete failed. They stay expired, and the next run retries. */
  failed: number;
  /** Objects left behind because their delete failed after the record's did not. */
  orphanedObjects: number;
}

export interface ExpirySweepLog {
  warn(details: Record<string, unknown>, message: string): void;
}

export interface ExpirySweepOptions {
  db: PatchPageDb;
  storage: HtmlStorage;
  /**
   * Where a taken draft is reported. Left out, the sweep reports nothing and
   * behaves exactly as it did.
   */
  analytics?: Analytics;
  log?: ExpirySweepLog;
}

export interface ExpirySweep {
  /**
   * Sweeps what is expired now. Concurrent calls share one run rather than
   * racing each other over the same drafts.
   */
  run(): Promise<ExpirySweepResult>;
}

export function createExpirySweep(options: ExpirySweepOptions): ExpirySweep {
  let inFlight: Promise<ExpirySweepResult> | null = null;

  return {
    run() {
      if (inFlight) return inFlight;

      const running = sweep(options).finally(() => {
        if (inFlight === running) inFlight = null;
      });
      inFlight = running;
      return running;
    }
  };
}

async function sweep(options: ExpirySweepOptions): Promise<ExpirySweepResult> {
  const result: ExpirySweepResult = {
    deleted: 0,
    skipped: 0,
    failed: 0,
    orphanedObjects: 0
  };
  let attempted = 0;

  while (attempted < SWEEP_MAX_DRAFTS_PER_RUN) {
    const batchLimit = Math.min(SWEEP_BATCH_SIZE, SWEEP_MAX_DRAFTS_PER_RUN - attempted);
    const draftIds = await options.db.listExpiredDraftIds(batchLimit);
    if (draftIds.length === 0) break;

    const deletedBefore = result.deleted;
    for (const draftId of draftIds) {
      attempted += 1;
      await sweepDraft(options, draftId, result);
    }

    // A short batch is the end of the backlog. A full batch that deleted
    // nothing is a batch the next listing would hand back unchanged, so stop
    // rather than spin on drafts this run cannot take.
    if (draftIds.length < batchLimit || result.deleted === deletedBefore) break;
  }

  return result;
}

async function sweepDraft(
  options: ExpirySweepOptions,
  draftId: string,
  result: ExpirySweepResult
): Promise<void> {
  let objectKeys: string[] | null;
  try {
    objectKeys = await options.db.deleteExpiredDraft(draftId);
  } catch (error) {
    result.failed += 1;
    options.log?.warn({ err: error, draftId }, "Expiry sweep could not delete a draft record.");
    return;
  }

  if (objectKeys === null) {
    result.skipped += 1;
    return;
  }

  result.deleted += 1;
  // Reported once the record is gone, which is the moment the draft stops
  // existing. No principal performed it — the clock ran out.
  options.analytics?.capture({
    name: "draft.expired",
    principalId: null,
    properties: { draftId, versionsRemoved: objectKeys.length }
  });

  for (const objectKey of objectKeys) {
    try {
      await options.storage.deleteHtmlObject(objectKey);
    } catch (error) {
      // The record is already gone, so nothing serves this object and no later
      // run will list it again. It is storage to reclaim by hand, not a draft
      // that survived, and it must not fail the rest of the sweep.
      result.orphanedObjects += 1;
      options.log?.warn(
        { err: error, draftId, objectKey },
        "Expiry sweep orphaned a stored object."
      );
    }
  }
}

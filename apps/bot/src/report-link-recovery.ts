import { DsaApiError } from "@nreport/contracts";

/** A non-definitive mutation result must be replayed with its original key. */
export function shouldAbandonReportLink(error: unknown): boolean {
  return error instanceof DsaApiError && error.status >= 400 && error.status < 500 &&
    error.status !== 408 && error.status !== 429;
}

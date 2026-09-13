/**
 * The only report identifiers permitted in restricted structured operational logs.
 * This context never carries reporter identity, evidence, external Discord IDs, or mail data.
 */
export interface ReportLogContext {
  reportId: string;
  traceId: string;
}

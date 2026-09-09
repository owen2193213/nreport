import type { CreateReportInput, LegalSourceAnnotation, ReportStatus } from "@nreport/contracts";

import type { AccountReportRow } from "./report-repository.js";

export const PREPARATION_WORKFLOW_TIMEOUT_MS = 300_000;

export interface PreparationUsage {
  aiRequests: number;
  inputTokens: number;
  outputTokens: number;
  searchRequests: number;
}

export interface PreparedResult {
  country: string;
  category: string;
  description: string;
  finalText: string;
  legalReference: string | null;
  researchSummary: string | null;
  sources: LegalSourceAnnotation[];
  usage: PreparationUsage;
}

export interface GeneratedReportIdentity {
  legalName: string;
  email: string;
  locale: string;
  timezone: string;
  language: string;
  proxySessionId: string;
}

export interface ReportPreparer {
  prepare(
    input: Extract<CreateReportInput, { useAi: true }>,
    progress: (stage: "researching" | "writing") => Promise<void>,
    signal: AbortSignal,
    recordUsage?: (usage: PreparationUsage) => Promise<void>
  ): Promise<PreparedResult>;
}

export interface PreparationStore {
  claimPreparation(): Promise<{ jobId: string; report: AccountReportRow } | null>;
  transition(reportId: string, status: ReportStatus): Promise<boolean>;
  completePreparation(
    jobId: string,
    reportId: string,
    prepared: PreparedResult,
    identity: GeneratedReportIdentity,
    usage: PreparationUsage
  ): Promise<void>;
  failPreparation(jobId: string, reportId: string, code: string, message: string): Promise<void>;
  recordPreparationUsage?(reportId: string, usage: PreparationUsage): Promise<void>;
}

export class PreparationWorker {
  private stopping = false;
  private loops: Promise<void>[] = [];

  public constructor(
    private readonly store: PreparationStore,
    private readonly preparer: ReportPreparer,
    private readonly generateIdentity: (country: string) => GeneratedReportIdentity,
    private readonly concurrency = 2,
    private readonly sleep: (milliseconds: number) => Promise<unknown> = delay,
    private readonly onIterationError: (error: unknown) => void = () => undefined
  ) {
    if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 16) {
      throw new Error("Preparation concurrency must be between 1 and 16.");
    }
  }

  public start(): void {
    if (this.loops.length > 0) return;
    this.stopping = false;
    this.loops = Array.from({ length: this.concurrency }, () => this.runLoop());
  }

  public async stop(): Promise<void> {
    this.stopping = true;
    await Promise.all(this.loops);
    this.loops = [];
  }

  public async processOne(): Promise<boolean> {
    const claimed = await this.store.claimPreparation();
    if (claimed === null) return false;
    const { jobId, report } = claimed;
    try {
      if (report.retry_mode !== "reuse" && report.request_input.useAi &&
          !(await this.store.transition(report.id, "planning"))) {
        return true;
      }
      const prepared = report.retry_mode === "reuse"
        ? reusedPreparation(report)
        : report.request_input.useAi
          ? await this.prepareWithAi(report.id, report.request_input)
          : manualPreparation(report.request_input);
      const identity = this.generateIdentity(prepared.country);
      await this.store.completePreparation(
        jobId,
        report.id,
        prepared,
        identity,
        prepared.usage
      );
    } catch (error) {
      if (error instanceof PreparationCancelledError) return true;
      const details = preparationErrorDetails(error);
      const code = details.errorCode;
      await this.store.failPreparation(
        jobId,
        report.id,
        code,
        preparationErrorMessage(code, error)
      );
      this.onIterationError(new PreparationFailureDiagnostic(details));
    }
    return true;
  }

  private async prepareWithAi(
    reportId: string,
    input: Extract<CreateReportInput, { useAi: true }>
  ): Promise<PreparedResult> {
    const result = await this.preparer.prepare(
      input,
      async (stage) => {
        if (!(await this.store.transition(reportId, stage))) throw new PreparationCancelledError();
      },
      AbortSignal.timeout(PREPARATION_WORKFLOW_TIMEOUT_MS),
      async (usage) => this.store.recordPreparationUsage?.(reportId, usage)
    );
    return {
      ...result,
      ...(input.country === undefined ? {} : { country: input.country }),
      ...(input.category === undefined ? {} : { category: input.category }),
      ...(input.description === undefined ? {} : { description: input.description })
    };
  }

  private async runLoop(): Promise<void> {
    while (!this.stopping) {
      try {
        const worked = await this.processOne();
        if (!worked) await this.sleep(500);
      } catch (error) {
        try {
          this.onIterationError(error);
        } catch {
          // Error reporting must not stop durable preparation processing.
        }
        if (!this.stopping) await this.sleep(1_000);
      }
    }
  }
}

function manualPreparation(input: Extract<CreateReportInput, { useAi: false }>): PreparedResult {
  return {
    country: input.country,
    category: input.category,
    description: input.description ?? input.finalText,
    finalText: input.finalText,
    legalReference: null,
    researchSummary: null,
    sources: [],
    usage: { aiRequests: 0, inputTokens: 0, outputTokens: 0, searchRequests: 0 }
  };
}

function reusedPreparation(report: AccountReportRow): PreparedResult {
  const input = report.prepared_input;
  if (
    input === null ||
    typeof input.country !== "string" ||
    typeof input.category !== "string" ||
    typeof input.description !== "string" ||
    typeof input.finalText !== "string"
  ) {
    throw new Error("Reusable prepared input is unavailable.");
  }
  return {
    country: input.country,
    category: input.category,
    description: input.description,
    finalText: input.finalText,
    legalReference: report.legal_reference,
    researchSummary: report.research_summary,
    sources: report.research_sources as LegalSourceAnnotation[],
    usage: { aiRequests: 0, inputTokens: 0, outputTokens: 0, searchRequests: 0 }
  };
}

const PREPARATION_ERROR_KINDS = new Set([
  "empty",
  "incomplete",
  "invalid_query",
  "malformed",
  "network",
  "provider",
  "rate_limited",
  "refusal",
  "timeout"
]);
const PREPARATION_ERROR_STAGES = new Set([
  "plan",
  "synthesize",
  "refine",
  "term_research",
  "law_research"
]);

interface PreparationErrorDetails {
  errorCode: string;
  kind: string;
  stage: string;
}

function preparationErrorDetails(error: unknown): PreparationErrorDetails {
  if (error instanceof DOMException && error.name === "TimeoutError") {
    return { errorCode: "preparation_timeout", kind: "timeout", stage: "preparation" };
  }
  const candidate = typeof error === "object" && error !== null
    ? error as { kind?: unknown; stage?: unknown }
    : {};
  const kind = typeof candidate.kind === "string" && PREPARATION_ERROR_KINDS.has(candidate.kind)
    ? candidate.kind
    : "unknown";
  const stage = typeof candidate.stage === "string" && PREPARATION_ERROR_STAGES.has(candidate.stage)
    ? candidate.stage
    : "preparation";
  return {
    errorCode: kind === "unknown" ? "preparation_failed" : `preparation_${kind}`,
    kind,
    stage
  };
}

class PreparationFailureDiagnostic extends Error {
  public constructor(details: PreparationErrorDetails) {
    super("Report preparation failed.");
    this.name = "PreparationFailureDiagnostic";
    this.errorCode = details.errorCode;
    this.kind = details.kind;
    this.stage = details.stage;
  }

  public readonly errorCode: string;
  public readonly kind: string;
  public readonly stage: string;
}

class PreparationCancelledError extends Error {}

function preparationErrorMessage(code: string, error: unknown): string {
  if (code === "preparation_timeout") return "Report preparation timed out.";
  if (code === "preparation_refusal") return "The writing provider could not prepare this report.";
  if (code === "preparation_rate_limited") return "A preparation provider is rate limited. Retry the report shortly.";
  if (code === "preparation_network") return "A preparation provider could not be reached.";
  if (code === "preparation_provider") return "A preparation provider remained unavailable.";
  if (code === "preparation_malformed") return "A preparation provider returned an invalid response.";
  if (code === "preparation_incomplete") return "The AI writing provider stopped before completing the report.";
  const message = error instanceof Error ? error.message : "";
  if (message === "Reusable prepared input is unavailable.") return message;
  return "Report preparation failed because the worker encountered an unexpected internal error.";
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

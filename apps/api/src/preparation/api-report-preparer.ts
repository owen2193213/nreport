import { createHash, randomUUID } from "node:crypto";

import type { CreateReportInput } from "@nreport/contracts";

import type { PreparedResult, ReportPreparer } from "../preparation-worker.js";
import { ReportWriter } from "./report-writer.js";
import type { AiUsage, ReportDraft } from "./types.js";

type UsageRecorder = (operationId: string, usage: AiUsage) => Promise<void>;
type WriterLike = Pick<ReportWriter, "generate">;

export interface ApiReportPreparerOptions {
  writerFactory: (recordUsage: UsageRecorder) => WriterLike;
}

export interface ProviderPreparationConfig {
  aiApiKey: string;
  aiModel: string;
  braveSearchApiKey: string;
  supportedCountries: readonly string[];
  provider?: "openrouter" | "baseten";
}

export class ApiReportPreparer implements ReportPreparer {
  private readonly writerFactory: (recordUsage: UsageRecorder) => WriterLike;

  public constructor(options: ApiReportPreparerOptions | ProviderPreparationConfig) {
    this.writerFactory = "writerFactory" in options
      ? options.writerFactory
      : (recordUsage) => new ReportWriter(
          options.aiApiKey,
          options.aiModel,
          options.braveSearchApiKey,
          options.supportedCountries,
          { recordUsage, ...(options.provider === undefined ? {} : { provider: options.provider }) }
        );
  }

  public async prepare(
    input: Extract<CreateReportInput, { useAi: true }>,
    progress: (stage: "researching" | "writing") => Promise<void>,
    signal: AbortSignal,
    recordUsage?: (usage: PreparedResult["usage"]) => Promise<void>
  ): Promise<PreparedResult> {
    if (signal.aborted) throw signal.reason;
    const usage = { aiRequests: 0, inputTokens: 0, outputTokens: 0, searchRequests: 0 };
    const writer = this.writerFactory(async (_operationId, item) => {
      const delta = {
        aiRequests: item.searchRequests === 0 ? 1 : 0,
        inputTokens: item.inputTokens,
        outputTokens: item.outputTokens,
        searchRequests: item.searchRequests
      };
      usage.inputTokens += delta.inputTokens;
      usage.outputTokens += delta.outputTokens;
      usage.searchRequests += delta.searchRequests;
      usage.aiRequests += delta.aiRequests;
      await recordUsage?.(delta);
    });
    const operationId = randomUUID();
    const actorKey = createHash("sha256").update(operationId).digest("hex").slice(0, 16);
    const result = await writer.generate(
      toWriterDraft(input),
      { actorKey, userId: operationId },
      async (event) => progress(event.stage === "research" ? "researching" : "writing")
    );
    if (signal.aborted) throw signal.reason;
    return {
      country: result.country,
      category: result.reportType,
      description: result.reportReason,
      finalText: result.report,
      legalReference: result.legalResearch.lawReference ?? null,
      researchSummary: result.legalResearch.summary,
      sources: result.legalResearch.sources,
      usage: {
        ...usage,
        searchRequests: usage.searchRequests || result.legalResearch.searchRequests
      }
    };
  }
}

function toWriterDraft(input: Extract<CreateReportInput, { useAi: true }>): ReportDraft {
  const internal = input as typeof input & { rewriteDirective?: ReportDraft["rewriteRequest"] };
  const common = {
    ...(input.country === undefined ? {} : { country: input.country, countrySelection: "override" as const }),
    ...(input.category === undefined ? {} : { reportType: input.category }),
    ...(input.description === undefined ? {} : { reportBrief: input.description }),
    ...(internal.rewriteDirective === undefined ? {} : { rewriteRequest: internal.rewriteDirective })
  };
  const target = input.target;
  if (input.flow === "message") {
    if (!("messageUrl" in target)) throw new Error("Message target does not match flow.");
    return {
      ...common,
      flow: "message_urf",
      messageUrl: target.messageUrl,
      ...(target.messageEvidence === undefined ? {} : { messageEvidence: target.messageEvidence })
    };
  }
  if (input.flow === "profile") {
    if (!("reportedUsername" in target)) throw new Error("Profile target does not match flow.");
    return {
      ...common,
      flow: "user_urf",
      reportedUsername: target.reportedUsername,
      reportedUserId: target.reportedUserId,
      reportedUserSnapshot: target.reportedUserSnapshot,
      profileElements: target.profileElements,
      ...(target.reportedUserServerId === undefined ? {} : { reportedUserServerId: target.reportedUserServerId })
    };
  }
  if (!("guildIdOrInviteCode" in target)) throw new Error("Server target does not match flow.");
  return {
    ...common,
    flow: "guild_urf",
    guildIdOrInviteCode: target.guildIdOrInviteCode,
    guildElements: target.guildElements
  };
}

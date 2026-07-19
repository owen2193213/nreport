import { DiscordDsaError, PayloadValidationError } from "./errors.js";
import { validateMenu } from "./menu.js";
import { buildSubmissionPayload } from "./payload.js";
import { UndiciJsonTransport } from "./transport.js";
import { REPORT_FLOWS } from "./types.js";
import type {
  EmailTokenResponse,
  FingerprintResponse,
  JsonTransport,
  ReportDraft,
  ReportFlow,
  ReportMenu,
  ReportSubmissionResult,
  SubmissionPayload
} from "./types.js";

export interface DiscordDsaClientOptions {
  codeQueryB: string;
  fingerprint?: string;
  proxyUrl?: string;
  baseUrl?: string;
  locale?: string;
  timezone?: string;
  userAgent?: string;
  extraHeaders?: Record<string, string>;
  timeoutMs?: number;
  transport?: JsonTransport;
}

function assertFlow(flow: string): asserts flow is ReportFlow {
  if (!(REPORT_FLOWS as readonly string[]).includes(flow)) {
    throw new PayloadValidationError(`Unsupported report flow: ${flow}.`);
  }
}

function assertEmail(email: string): void {
  if (!/^\S+@\S+\.\S+$/.test(email)) {
    throw new PayloadValidationError("A valid email address is required.");
  }
}

function assertCode(code: string): void {
  if (!/^[A-Za-z0-9]{6}$/.test(code)) {
    throw new PayloadValidationError(
      "Verification code must contain exactly six letters or digits."
    );
  }
}

function defaultHeaders(options: DiscordDsaClientOptions): Record<string, string> {
  const headers: Record<string, string> = {
    accept: "*/*",
    "user-agent": options.userAgent ?? "ProjectNebulon-DSA-Reporter/0.1"
  };
  if (options.locale !== undefined) headers["x-discord-locale"] = options.locale;
  if (options.timezone !== undefined) headers["x-discord-timezone"] = options.timezone;
  return { ...headers, ...options.extraHeaders };
}

export class DiscordDsaClient {
  private readonly codeQueryB: string;
  private readonly transport: JsonTransport;
  private fingerprint: string | undefined;
  private fingerprintPromise: Promise<string> | undefined;

  public constructor(options: DiscordDsaClientOptions) {
    if (options.codeQueryB.trim().length === 0) {
      throw new PayloadValidationError("codeQueryB must not be empty.");
    }
    this.codeQueryB = options.codeQueryB;
    this.fingerprint = options.fingerprint;
    this.transport =
      options.transport ??
      new UndiciJsonTransport({
        ...(options.proxyUrl === undefined ? {} : { proxyUrl: options.proxyUrl }),
        ...(options.baseUrl === undefined ? {} : { baseUrl: options.baseUrl }),
        defaultHeaders: defaultHeaders(options),
        ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs })
      });
  }

  public async bootstrapFingerprint(): Promise<string> {
    if (this.fingerprint !== undefined) return this.fingerprint;
    this.fingerprintPromise ??= this.transport
      .requestJson<FingerprintResponse>({
        method: "GET",
        path: "https://discord.com/api/v9/experiments?with_guild_experiments=true"
      })
      .then((response) => {
        if (
          typeof response.fingerprint !== "string" ||
          response.fingerprint.length === 0
        ) {
          throw new DiscordDsaError(
            "Discord experiments response did not contain a fingerprint."
          );
        }
        this.fingerprint = response.fingerprint;
        return response.fingerprint;
      })
      .finally(() => {
        this.fingerprintPromise = undefined;
      });
    return this.fingerprintPromise;
  }

  private async fingerprintHeaders(): Promise<Record<string, string>> {
    return { "x-fingerprint": await this.bootstrapFingerprint() };
  }

  public async sendEmailCode(flow: ReportFlow, email: string): Promise<void> {
    assertFlow(flow);
    assertEmail(email);
    await this.transport.requestJson<void>({
      method: "POST",
      path: `${flow}/code?b=${encodeURIComponent(this.codeQueryB)}`,
      body: { name: flow, email },
      headers: await this.fingerprintHeaders()
    });
  }

  public async verifyEmailCode(
    flow: ReportFlow,
    email: string,
    code: string
  ): Promise<string> {
    assertFlow(flow);
    assertEmail(email);
    assertCode(code);
    const response = await this.transport.requestJson<EmailTokenResponse>({
      method: "POST",
      path: `${flow}/verify`,
      body: { name: flow, email, code },
      headers: await this.fingerprintHeaders()
    });
    if (typeof response.token !== "string" || response.token.length === 0) {
      throw new DiscordDsaError("Discord verification response did not contain a token.");
    }
    return response.token;
  }

  public async getMenu(flow: ReportFlow): Promise<ReportMenu> {
    assertFlow(flow);
    const menu = await this.transport.requestJson<ReportMenu>({
      method: "GET",
      path: `menu/${flow}`,
      headers: await this.fingerprintHeaders()
    });
    validateMenu(menu, flow);
    return menu;
  }

  public prepareSubmission(
    menu: ReportMenu,
    draft: ReportDraft,
    emailToken: string,
    language = "en"
  ): SubmissionPayload {
    return buildSubmissionPayload(menu, draft, emailToken, language);
  }

  public async submitPrepared(
    payload: SubmissionPayload
  ): Promise<ReportSubmissionResult> {
    assertFlow(payload.name);
    const response = await this.transport.requestJson<ReportSubmissionResult>({
      method: "POST",
      path: payload.name,
      body: payload,
      headers: await this.fingerprintHeaders()
    });
    if (typeof response.report_id !== "string" || response.report_id.length === 0) {
      throw new DiscordDsaError("Discord submission response did not contain report_id.");
    }
    return response;
  }

  public async submitReport(
    menu: ReportMenu,
    draft: ReportDraft,
    emailToken: string,
    language = "en"
  ): Promise<ReportSubmissionResult> {
    return this.submitPrepared(
      this.prepareSubmission(menu, draft, emailToken, language)
    );
  }

  public async close(): Promise<void> {
    await this.transport.close?.();
  }
}

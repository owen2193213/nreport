export class DiscordDsaError extends Error {
  public constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "DiscordDsaError";
  }
}

export class DiscordDsaNetworkError extends DiscordDsaError {
  public constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "DiscordDsaNetworkError";
  }
}

export class DiscordDsaHttpError extends DiscordDsaError {
  public readonly status: number;
  public readonly retryAfterSeconds?: number;
  public readonly responseSummary?: string;
  public readonly requestId?: string;

  public constructor(
    message: string,
    status: number,
    options?: ErrorOptions & { retryAfterSeconds?: number; responseSummary?: string; requestId?: string }
  ) {
    super(message, options);
    this.name = "DiscordDsaHttpError";
    this.status = status;
    if (options?.retryAfterSeconds !== undefined) {
      this.retryAfterSeconds = options.retryAfterSeconds;
    }
    if (options?.responseSummary !== undefined) {
      this.responseSummary = options.responseSummary;
    }
    if (options?.requestId !== undefined) this.requestId = options.requestId;
  }
}

export class MenuResolutionError extends DiscordDsaError {
  public constructor(message: string) {
    super(message);
    this.name = "MenuResolutionError";
  }
}

export class PayloadValidationError extends DiscordDsaError {
  public constructor(message: string) {
    super(message);
    this.name = "PayloadValidationError";
  }
}

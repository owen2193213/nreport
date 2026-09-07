import { ACCOUNT_STATUSES, GUILD_ELEMENTS, PROFILE_ELEMENTS, REPORT_FLOWS } from "./types.js";

const snowflake = { type: "string", pattern: "^[0-9]{15,22}$" } as const;

export const createReportBodySchema = {
  $id: "CreateReportInput",
  type: "object",
  additionalProperties: false,
  required: ["flow", "useAi", "target"],
  oneOf: [
    {
      properties: { useAi: { const: true } },
      required: ["useAi"],
      not: { required: ["finalText"] }
    },
    {
      properties: { useAi: { const: false } },
      required: ["useAi", "country", "category", "finalText"]
    }
  ],
  properties: {
    flow: { enum: [...REPORT_FLOWS] },
    useAi: { type: "boolean" },
    country: { type: "string", minLength: 2, maxLength: 2 },
    category: { type: "string", minLength: 1, maxLength: 100 },
    description: { type: "string", minLength: 1, maxLength: 4000 },
    finalText: { type: "string", minLength: 1, maxLength: 512 },
    target: {
      oneOf: [
        { type: "object", required: ["messageUrl"], properties: { messageUrl: { type: "string", maxLength: 512 } } },
        {
          type: "object",
          required: ["reportedUsername", "reportedUserId", "reportedUserSnapshot", "profileElements"],
          properties: {
            reportedUsername: { type: "string", minLength: 1, maxLength: 100 },
            reportedUserId: snowflake,
            reportedUserSnapshot: { type: "object" },
            reportedUserServerId: snowflake,
            profileElements: { type: "array", minItems: 1, uniqueItems: true, items: { enum: [...PROFILE_ELEMENTS] } }
          }
        },
        {
          type: "object",
          required: ["guildIdOrInviteCode", "guildElements"],
          properties: {
            guildIdOrInviteCode: { type: "string", minLength: 1, maxLength: 100 },
            guildElements: { type: "array", minItems: 1, uniqueItems: true, items: { enum: [...GUILD_ELEMENTS] } }
          }
        }
      ]
    }
  }
} as const;

export const apiAccountSchema = {
  $id: "ApiAccount",
  type: "object",
  required: ["accountId", "username", "status", "availableCredits", "reservedCredits", "keyPrefix", "usage"],
  properties: {
    accountId: { type: "string", format: "uuid" },
    username: { type: "string" },
    status: { enum: [...ACCOUNT_STATUSES] },
    availableCredits: { type: "integer", minimum: 0 },
    reservedCredits: { type: "integer", minimum: 0 },
    keyPrefix: { type: "string" },
    usage: { type: "object" }
  }
} as const;

export const errorEnvelopeSchema = {
  $id: "ApiError",
  type: "object",
  required: ["error"],
  properties: {
    error: {
      type: "object",
      required: ["code", "message", "requestId"],
      properties: {
        code: { type: "string" },
        message: { type: "string" },
        requestId: { type: "string" }
      }
    }
  }
} as const;

export const retryReportBodySchema = {
  $id: "RetryReportInput",
  oneOf: [
    {
      type: "object",
      additionalProperties: false,
      required: ["mode"],
      properties: { mode: { enum: ["reuse", "regenerate", "rewrite_ai"] } }
    },
    {
      type: "object",
      additionalProperties: false,
      required: ["mode", "country", "category", "finalText"],
      properties: {
        mode: { const: "edit_manual" },
        country: { type: "string", minLength: 2, maxLength: 2 },
        category: { type: "string", minLength: 1, maxLength: 100 },
        finalText: { type: "string", minLength: 1, maxLength: 512 },
        profileElements: { type: "array", minItems: 1, uniqueItems: true, items: { enum: [...PROFILE_ELEMENTS] } },
        guildElements: { type: "array", minItems: 1, uniqueItems: true, items: { enum: [...GUILD_ELEMENTS] } }
      }
    }
  ]
} as const;

export const adminCreateAccountBodySchema = {
  $id: "AdminCreateAccountInput",
  type: "object",
  additionalProperties: false,
  required: ["username"],
  properties: {
    username: { type: "string", minLength: 3, maxLength: 32, pattern: "^[A-Za-z0-9][A-Za-z0-9._-]{2,31}$" },
    initialCredits: { type: "integer", minimum: 0 },
    webhookDestinationId: { type: "string", format: "uuid" }
  }
} as const;

export const keyRotationBodySchema = {
  $id: "KeyRotationInput",
  type: "object",
  additionalProperties: false,
  properties: { overlapSeconds: { type: "integer", minimum: 0, maximum: 86_400 } }
} as const;

export const auditReasonBodySchema = {
  $id: "AuditReasonInput",
  type: "object",
  additionalProperties: false,
  required: ["reason"],
  properties: { reason: { type: "string", minLength: 3, maxLength: 500 } }
} as const;

export const creditAdjustmentBodySchema = {
  $id: "CreditAdjustmentInput",
  type: "object",
  additionalProperties: false,
  required: ["delta", "reason"],
  properties: {
    delta: { type: "integer", not: { const: 0 } },
    reason: { type: "string", minLength: 3, maxLength: 500 }
  }
} as const;

export const createWebhookDestinationBodySchema = {
  $id: "CreateWebhookDestinationInput",
  type: "object",
  additionalProperties: false,
  required: ["name", "url", "signingSecret"],
  properties: {
    name: { type: "string", minLength: 2, maxLength: 100 },
    url: { type: "string", minLength: 1, maxLength: 2048 },
    signingSecret: { type: "string", minLength: 32, maxLength: 4096 }
  }
} as const;

export const updateWebhookDestinationBodySchema = {
  $id: "UpdateWebhookDestinationInput",
  type: "object",
  additionalProperties: false,
  minProperties: 1,
  properties: {
    name: { type: "string", minLength: 2, maxLength: 100 },
    url: { type: "string", minLength: 1, maxLength: 2048 },
    signingSecret: { type: "string", minLength: 32, maxLength: 4096 },
    status: { enum: ["active", "disabled"] }
  }
} as const;

export const assignWebhookDestinationBodySchema = {
  $id: "AssignWebhookDestinationInput",
  type: "object",
  additionalProperties: false,
  required: ["destinationId"],
  properties: { destinationId: { anyOf: [{ type: "string", format: "uuid" }, { type: "null" }] } }
} as const;

export const reportLifecycleEventSchema = {
  $id: "ReportLifecycleEvent",
  type: "object",
  additionalProperties: false,
  required: ["eventId", "accountId", "reportId", "type", "occurredAt", "lifecycleAttempt"],
  properties: {
    eventId: { type: "string" },
    accountId: { type: "string", format: "uuid" },
    reportId: { type: "string", format: "uuid" },
    type: { type: "string" },
    occurredAt: { type: "string", format: "date-time" },
    lifecycleAttempt: { type: "integer", minimum: 1 }
  }
} as const;

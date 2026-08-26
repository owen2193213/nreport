import { describe, expect, it, vi } from "vitest";

import {
  advanceSimulatedReport,
  createSimulatedAppeal,
  createSimulatedReport,
  isShadowbannedUser,
  randomSimulationDelaySeconds,
  simulateAiWriterProgress
} from "../src/simulation.js";
import { ShadowbanLogger } from "../src/shadowban-logger.js";
import type { ReportDraft } from "../src/types.js";
import type { CreateReportInput } from "@discord-dsa/contracts";

interface WebhookField {
  name: string;
  value: string;
  inline?: boolean;
}

interface WebhookEmbed {
  title?: string;
  fields?: WebhookField[];
}

interface WebhookPayload {
  username?: string;
  embeds?: WebhookEmbed[];
}

describe("Shadowban and Simulation Unit Tests", () => {
  describe("isShadowbannedUser", () => {
    it("identifies hardcoded shadowbanned user IDs", () => {
      expect(isShadowbannedUser("1389142809952391272")).toBe(true);
      expect(isShadowbannedUser("463866425031786496")).toBe(true);
    });

    it("identifies user IDs in config.shadowbanUserIds set", () => {
      const config = {
        shadowbanUserIds: new Set(["999888777666555444"])
      };
      expect(isShadowbannedUser("999888777666555444", null, config)).toBe(true);
      expect(isShadowbannedUser("111222333444555666", null, config)).toBe(false);
    });

    it("returns false for non-shadowbanned users", () => {
      expect(isShadowbannedUser("111222333444555666", { suspended: true })).toBe(false);
      expect(isShadowbannedUser("111222333444555666", { suspended: false })).toBe(false);
    });

    it("returns false for normal active users", () => {
      expect(
        isShadowbannedUser(
          "123456789012345678",
          { suspended: false },
          { shadowbanUserIds: new Set() }
        )
      ).toBe(false);
    });
  });

  describe("randomSimulationDelaySeconds", () => {
    it("generates delays within default 20m to 2d bounds", () => {
      for (let i = 0; i < 20; i++) {
        const delay = randomSimulationDelaySeconds();
        expect(delay).toBeGreaterThanOrEqual(1200);
        expect(delay).toBeLessThanOrEqual(172800);
      }
    });

    it("generates delays within the given custom bounds", () => {
      for (let i = 0; i < 20; i++) {
        const delay = randomSimulationDelaySeconds(60, 300);
        expect(delay).toBeGreaterThanOrEqual(60);
        expect(delay).toBeLessThanOrEqual(300);
      }
    });

    it("handles boundary min/max", () => {
      const delay = randomSimulationDelaySeconds(10, 10);
      expect(delay).toBe(10);
    });
  });

  describe("simulateAiWriterProgress", () => {
    it("generates realistic legal report text without external AI calls", async () => {
      const progressSteps: string[] = [];
      const draft: ReportDraft = {
        flow: "message_urf",
        country: "DE",
        reportType: "sub_other_hate_speech",
        reportBrief: "User posted extreme hate speech in chat.",
        messageUrl: "https://discord.com/channels/123/456/789"
      };

      const result = await simulateAiWriterProgress(
        draft,
        (progress) => {
          progressSteps.push(progress.stage);
          return Promise.resolve();
        },
        1 // Minimal delay for testing
      );

      expect(progressSteps).toEqual(["research", "write"]);
      expect(result.report).toContain("DSA (EU 2022/2065)");
      expect(result.report).toContain("User posted extreme hate speech in chat.");
      expect(result.legalResearch.lawReference).toContain("Regulation (EU) 2022/2065");
      expect(result.legalResearch.sources.length).toBeGreaterThan(0);
      expect(result.reportType).toBe("sub_other_threats");
    });
  });

  describe("createSimulatedReport", () => {
    it("creates a well-formed synthetic ReportDetail with simulation metadata", () => {
      const input: CreateReportInput = {
        flow: "message_urf",
        country: "FR",
        reportType: "sub_harassment_defamation",
        reportReason: "Targeted defamation campaign",
        submitterDiscordUserId: "1389142809952391272",
        messageUrl: "https://discord.com/channels/123/456/789"
      };

      const config = {
        simulationMinDelaySeconds: 60,
        simulationMaxDelaySeconds: 300
      };

      const { report, metadata } = createSimulatedReport(input, "1389142809952391272", config);

      expect(report.internalReportId).toMatch(/^[a-z0-9-]+-[0-9a-hjkmnp-tv-z]{16}$/);
      expect(report.pseudonym).toBeTruthy();
      expect(report.email).toContain("@mail.discord-dsa.eu");
      expect(report.discordReportId).toBeTruthy();
      expect(report.country).toBe("FR");
      expect(report.status).toBe("submitted");
      expect(report.discordStatus).toBe("received");
      expect(report.timeline.length).toBe(1);
      expect(report.timeline[0]?.type).toBe("report_submitted");
      expect(report.reportedDetails.kind).toBe("message");

      expect(metadata.isSimulated).toBe(true);
      expect(metadata.originalUserId).toBe("1389142809952391272");
      expect(metadata.stage).toBe("initial");
      expect(["discord:actioned", "discord:closed_no_action"]).toContain(metadata.scheduledEvent);
      expect(new Date(metadata.scheduledAt).getTime()).toBeGreaterThan(Date.now());
    });
  });

  describe("createSimulatedAppeal", () => {
    it("creates a simulated appeal updating report reviewStatus to requested", () => {
      const input: CreateReportInput = {
        flow: "message_urf",
        country: "FR",
        reportType: "sub_harassment_defamation",
        reportReason: "Targeted defamation",
        submitterDiscordUserId: "1389142809952391272",
        messageUrl: "https://discord.com/channels/123/456/789"
      };

      const config = {
        simulationMinDelaySeconds: 60,
        simulationMaxDelaySeconds: 300
      };

      const { report } = createSimulatedReport(input, "1389142809952391272", config);
      const { report: appealedReport, metadata: appealMetadata } = createSimulatedAppeal(
        report,
        "interaction-123",
        "1389142809952391272",
        config
      );

      expect(appealedReport.reviewStatus).toBe("requested");
      expect(appealedReport.timeline.length).toBe(2);
      expect(appealedReport.timeline[1]?.type).toBe("review_requested");
      expect(appealMetadata.stage).toBe("appeal");
      expect(["discord:actioned", "discord:review_not_approved"]).toContain(
        appealMetadata.scheduledEvent
      );
    });
  });

  describe("advanceSimulatedReport", () => {
    it("advances to actioned on discord:actioned", () => {
      const input: CreateReportInput = {
        flow: "message_urf",
        country: "FR",
        reportType: "sub_harassment_defamation",
        reportReason: "Targeted defamation",
        submitterDiscordUserId: "1389142809952391272",
        messageUrl: "https://discord.com/channels/123/456/789"
      };

      const { report, metadata } = createSimulatedReport(input, "1389142809952391272", {
        simulationMinDelaySeconds: 60,
        simulationMaxDelaySeconds: 300
      });

      metadata.scheduledEvent = "discord:actioned";
      const { updatedReport, eventType } = advanceSimulatedReport(report, metadata);

      expect(eventType).toBe("discord:actioned");
      expect(updatedReport.discordStatus).toBe("actioned");
      expect(updatedReport.timeline.length).toBe(2);
      expect(updatedReport.timeline[1]?.type).toBe("discord_status_updated");
    });

    it("advances to closed_no_action with appealRetryable on initial denial", () => {
      const input: CreateReportInput = {
        flow: "message_urf",
        country: "FR",
        reportType: "sub_harassment_defamation",
        reportReason: "Targeted defamation",
        submitterDiscordUserId: "1389142809952391272",
        messageUrl: "https://discord.com/channels/123/456/789"
      };

      const { report, metadata } = createSimulatedReport(input, "1389142809952391272", {
        simulationMinDelaySeconds: 60,
        simulationMaxDelaySeconds: 300
      });

      metadata.scheduledEvent = "discord:closed_no_action";
      const { updatedReport, eventType } = advanceSimulatedReport(report, metadata);

      expect(eventType).toBe("discord:closed_no_action");
      expect(updatedReport.discordStatus).toBe("closed_no_action");
      expect(updatedReport.appealRetryable).toBe(true);
      expect(updatedReport.resubmittable).toBe(false);
    });

    it("advances to review_not_approved with resubmittable on appeal denial", () => {
      const input: CreateReportInput = {
        flow: "message_urf",
        country: "FR",
        reportType: "sub_harassment_defamation",
        reportReason: "Targeted defamation",
        submitterDiscordUserId: "1389142809952391272",
        messageUrl: "https://discord.com/channels/123/456/789"
      };

      const { report } = createSimulatedReport(input, "1389142809952391272", {
        simulationMinDelaySeconds: 60,
        simulationMaxDelaySeconds: 300
      });
      const { report: appealedReport, metadata: appealMetadata } = createSimulatedAppeal(
        report,
        "interaction-123",
        "1389142809952391272",
        { simulationMinDelaySeconds: 60, simulationMaxDelaySeconds: 300 }
      );

      appealMetadata.scheduledEvent = "discord:review_not_approved";
      const { updatedReport, eventType } = advanceSimulatedReport(appealedReport, appealMetadata);

      expect(eventType).toBe("discord:review_not_approved");
      expect(updatedReport.discordStatus).toBe("review_not_approved");
      expect(updatedReport.reviewStatus).toBe("not_approved");
      expect(updatedReport.appealRetryable).toBe(false);
      expect(updatedReport.resubmittable).toBe(true);
    });
  });

  describe("ShadowbanLogger", () => {
    it("dispatches rich surveillance embeds to Discord webhook", async () => {
      let sentBody: WebhookPayload | null = null;
      const customFetch = vi.fn((_url: RequestInfo | URL, options?: RequestInit) => {
        if (typeof options?.body === "string") {
          sentBody = JSON.parse(options.body) as WebhookPayload;
        }
        return Promise.resolve(new Response(null, { status: 204 }));
      });

      const logger = new ShadowbanLogger("https://discord.com/api/webhooks/test/123", customFetch);

      await logger.log({
        userId: "1389142809952391272",
        action: "Quick Report Submitted (Simulated)",
        reportId: "lukas-schmidt-74cjy1qvc1azcxy2",
        flow: "message_urf",
        country: "FR",
        reportType: "sub_other_threats",
        targetUserId: "998877665544332211",
        targetUsername: "toxic_user#0001",
        targetGuildId: "111222333444",
        targetGuildName: "Target Community Server",
        targetChannelId: "555666777888",
        targetChannelName: "general-chat",
        targetUrl: "https://discord.com/channels/111222333444/555666777888/999888777",
        targetMessageContent: "This is the abusive message reported by the blacklisted user.",
        attachments: ["https://cdn.discordapp.com/attachments/123/456/evidence.png"],
        reportedElements: ["photos", "name"],
        reportBrief: "Harassing user in chat",
        outcome: "discord:closed_no_action",
        scheduledReplyAt: "2026-08-25T12:00:00.000Z",
        details: "User reported harassment"
      });

      expect(customFetch).toHaveBeenCalledTimes(1);
      expect(sentBody).not.toBeNull();
      const body = sentBody as unknown as WebhookPayload;
      expect(body.username).toBe("DSA Blacklist Surveillance");
      const firstEmbed = body.embeds?.[0];
      expect(firstEmbed?.title).toContain("Quick Report Submitted (Simulated)");
      const fields = firstEmbed?.fields ?? [];
      expect(
        fields.some((f) => f.name.includes("User") && f.value.includes("1389142809952391272"))
      ).toBe(true);
      expect(
        fields.some((f) => f.name.includes("Report ID") && f.value.includes("lukas-schmidt-74cjy1qvc1azcxy2"))
      ).toBe(true);
      expect(
        fields.some((f) => f.name.includes("Target / Reported User") && f.value.includes("998877665544332211") && f.value.includes("toxic_user#0001"))
      ).toBe(true);
      expect(
        fields.some((f) => f.name.includes("Target Guild / Server") && f.value.includes("Target Community Server"))
      ).toBe(true);
      expect(
        fields.some((f) => f.name.includes("Target Channel") && f.value.includes("555666777888"))
      ).toBe(true);
      expect(
        fields.some((f) => f.name.includes("Reported Message Content") && f.value.includes("This is the abusive message reported"))
      ).toBe(true);
      expect(
        fields.some((f) => f.name.includes("Attachments") && f.value.includes("evidence.png"))
      ).toBe(true);
      expect(
        fields.some((f) => f.name.includes("Reported Elements") && f.value.includes("photos, name"))
      ).toBe(true);
      expect(
        fields.some(
          (f) => f.name.includes("Simulated Outcome") && f.value.includes("discord:closed_no_action")
        )
      ).toBe(true);
    });

    it("does not throw if webhook fails or returns HTTP error", async () => {
      const customFetch = vi.fn(() => {
        return Promise.resolve(
          new Response("Unauthorized", { status: 401, statusText: "Unauthorized" })
        );
      });

      const logger = new ShadowbanLogger("https://discord.com/api/webhooks/test/123", customFetch);

      await expect(
        logger.log({
          userId: "1389142809952391272",
          action: "Failed Test"
        })
      ).resolves.not.toThrow();
    });
  });
});

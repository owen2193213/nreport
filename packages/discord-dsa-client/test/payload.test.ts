import { describe, expect, it } from "vitest";

import { PayloadValidationError } from "../src/errors.js";
import { buildSubmissionPayload } from "../src/payload.js";
import type { MessageReportDraft } from "../src/types.js";
import { createMessageMenu } from "./fixtures.js";

const draft: MessageReportDraft = {
  flow: "message_urf",
  reporter: {
    country: "DE",
    legalName: "Jason McDonell",
    username: "user3212"
  },
  messageUrl:
    "https://discord.com/channels/1273300509318578227/1526327580456779797/1527300404998832138",
  reportType: "sub_other_cybercrime",
  context: "This person is spreading malware."
};

describe("buildSubmissionPayload", () => {
  it("builds the captured message payload shape from semantic input", () => {
    const payload = buildSubmissionPayload(createMessageMenu(), draft, "token");

    expect(payload.name).toBe("message_urf");
    expect(payload.breadcrumbs).toEqual([64, 60, 147, 150, 78, 77]);
    expect(payload.elements).toMatchObject({
      reporter_country: "DE",
      reporter_legal_name: "Jason McDonell",
      reporter_username: "user3212",
      reported_message_url: draft.messageUrl,
      dsa_free_text: "This person is spreading malware.",
      confirmation_select: ["validation"]
    });
    expect(payload.email_token).toBe("token");
  });

  it("validates the message URL against the live-menu pattern", () => {
    expect(() =>
      buildSubmissionPayload(
        createMessageMenu(),
        { ...draft, messageUrl: "https://example.com/not-a-message" },
        "token"
      )
    ).toThrow(PayloadValidationError);
  });

  it("rejects an invalid country option", () => {
    expect(() =>
      buildSubmissionPayload(
        createMessageMenu(),
        { ...draft, reporter: { ...draft.reporter, country: "US" } },
        "token"
      )
    ).toThrow(PayloadValidationError);
  });
});

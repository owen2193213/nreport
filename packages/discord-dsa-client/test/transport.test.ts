import { describe, expect, it } from "vitest";

import { discordResponseRequestId, summarizeDiscordErrorBody } from "../src/transport.js";

describe("Discord HTTP error sanitization", () => {
  it("extracts structured validation details", () => {
    const summary = summarizeDiscordErrorBody(
      JSON.stringify({
        code: 50035,
        message: "Invalid Form Body",
        errors: {
          elements: {
            reporter_country: {
              _errors: [{ code: "BASE_TYPE_BAD_LENGTH", message: "Must be 2 characters." }]
            }
          }
        }
      })
    );

    expect(summary).toBe(
      "code 50035; Invalid Form Body; elements.reporter_country: BASE_TYPE_BAD_LENGTH: Must be 2 characters."
    );
  });

  it("redacts email addresses and signed token shapes", () => {
    const summary = summarizeDiscordErrorBody(
      JSON.stringify({
        message:
          "Rejected reporter@example.com eyJlbWFpbCI6InVzZXJAZXhhbXBsZS5jb20ifQ.signaturevalue.signaturepayloadvalue"
      })
    );

    expect(summary).toBe("Rejected [redacted-email] [redacted-token]");
  });

  it("does not retain unstructured response bodies", () => {
    expect(summarizeDiscordErrorBody("<html>proxy diagnostic</html>")).toBeUndefined();
  });

  it("keeps Discord request identifiers without retaining other headers", () => {
    expect(discordResponseRequestId({ "x-request-id": "discord-request-1", cookie: "private" })).toBe("discord-request-1");
  });
});

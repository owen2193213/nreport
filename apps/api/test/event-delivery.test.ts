import { describe, expect, it } from "vitest";

import { diagnosticEventDeliveryFailure } from "../src/event-delivery.js";

describe("diagnosticEventDeliveryFailure", () => {
  it("keeps a bounded safe bot webhook failure response", async () => {
    const result = await diagnosticEventDeliveryFailure(new Response(JSON.stringify({ detail: "endpoint rejected event" }), {
      status: 422,
      headers: { "content-type": "application/json", "x-request-id": "bot-request-1" }
    }));
    expect(result).toMatchObject({ httpStatus: 422, requestId: "bot-request-1", response: { body: { detail: "endpoint rejected event" } } });
  });
});

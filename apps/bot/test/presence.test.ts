import { describe, expect, it } from "vitest";

import { BOT_PRESENCE } from "../src/presence.js";

describe("bot presence", () => {
  it("identifies to Discord as online", () => {
    expect(BOT_PRESENCE).toEqual({ status: "online" });
  });
});

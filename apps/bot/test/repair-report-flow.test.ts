import { describe, expect, it } from "vitest";

import { parseRepairArguments } from "../src/repair-report-flow.js";

describe("report-flow repair command arguments", () => {
  it("defaults to a non-mutating preview and requires a preview id for apply", () => {
    expect(parseRepairArguments([])).toEqual({ mode: "dry-run" });
    expect(parseRepairArguments(["--apply", "--run-id", "run-12345"])).toEqual({ mode: "apply", runId: "run-12345" });
    expect(() => parseRepairArguments(["--apply"])).toThrow("--run-id");
  });
});

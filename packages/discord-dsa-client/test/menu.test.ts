import { describe, expect, it } from "vitest";

import { MenuResolutionError } from "../src/errors.js";
import { isValidBreadcrumbPath, resolveBreadcrumbs } from "../src/menu.js";
import { createMessageMenu } from "./fixtures.js";

describe("resolveBreadcrumbs", () => {
  it("resolves the complete message Other -> Cybercrime path", () => {
    const menu = createMessageMenu();
    const path = resolveBreadcrumbs(menu, "sub_other_cybercrime");

    expect(path).toEqual([64, 60, 147, 150, 78, 77]);
    expect(isValidBreadcrumbPath(menu, path)).toBe(true);
  });

  it("rejects an unknown semantic report type", () => {
    expect(() => resolveBreadcrumbs(createMessageMenu(), "unknown")).toThrow(
      MenuResolutionError
    );
  });

  it("rejects paths that skip menu nodes", () => {
    expect(
      isValidBreadcrumbPath(createMessageMenu(), [64, 60, 150, 78, 77])
    ).toBe(false);
  });
});

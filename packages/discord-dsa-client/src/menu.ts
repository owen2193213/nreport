import { MenuResolutionError } from "./errors.js";
import type { MenuNode, ReportMenu } from "./types.js";

function getNode(menu: ReportMenu, id: number): MenuNode {
  const node = menu.nodes[String(id)];
  if (!node) {
    throw new MenuResolutionError(`Menu references missing node ${id}.`);
  }
  return node;
}

function getEdges(menu: ReportMenu, id: number): number[] {
  const node = getNode(menu, id);
  const edges = node.children.map(([, childId]) => childId);
  if (node.button?.target !== null && node.button?.target !== undefined) {
    edges.push(node.button.target);
  }
  return [...new Set(edges)];
}

function findPath(
  menu: ReportMenu,
  startId: number,
  predicate: (node: MenuNode) => boolean
): number[] | null {
  const queue: number[][] = [[startId]];
  const visited = new Set<number>();

  while (queue.length > 0) {
    const path = queue.shift();
    if (!path) continue;
    const currentId = path.at(-1);
    if (currentId === undefined || visited.has(currentId)) continue;
    visited.add(currentId);

    const current = getNode(menu, currentId);
    if (predicate(current)) return path;

    for (const nextId of getEdges(menu, currentId)) {
      if (!visited.has(nextId)) queue.push([...path, nextId]);
    }
  }

  return null;
}

export function validateMenu(menu: ReportMenu, expectedFlow?: string): void {
  if (expectedFlow !== undefined && menu.name !== expectedFlow) {
    throw new MenuResolutionError(
      `Expected menu ${expectedFlow}, received ${menu.name}.`
    );
  }
  getNode(menu, menu.root_node_id);
  getNode(menu, menu.success_node_id);
  getNode(menu, menu.fail_node_id);
}

export function resolveBreadcrumbs(
  menu: ReportMenu,
  reportType: string
): number[] {
  validateMenu(menu);
  const targets = Object.values(menu.nodes).filter(
    (node) => node.report_type === reportType
  );

  if (targets.length !== 1) {
    throw new MenuResolutionError(
      `Expected exactly one node for report type ${reportType}; found ${targets.length}.`
    );
  }

  const target = targets[0];
  if (!target) {
    throw new MenuResolutionError(`No node found for report type ${reportType}.`);
  }

  const prefix = findPath(menu, menu.root_node_id, (node) => node.id === target.id);
  if (!prefix) {
    throw new MenuResolutionError(
      `Report type ${reportType} is not reachable from root node ${menu.root_node_id}.`
    );
  }

  const suffix = findPath(
    menu,
    target.id,
    (node) => node.key === "URF_SUBMIT" || node.button?.type === "submit"
  );
  if (!suffix) {
    throw new MenuResolutionError(
      `No submit node is reachable from report type ${reportType}.`
    );
  }

  return [...prefix, ...suffix.slice(1)];
}

export function isValidBreadcrumbPath(
  menu: ReportMenu,
  breadcrumbs: readonly number[]
): boolean {
  if (breadcrumbs[0] !== menu.root_node_id || breadcrumbs.length < 2) return false;

  for (let index = 0; index < breadcrumbs.length - 1; index += 1) {
    const current = breadcrumbs[index];
    const next = breadcrumbs[index + 1];
    if (current === undefined || next === undefined) return false;
    if (!getEdges(menu, current).includes(next)) return false;
  }

  const finalId = breadcrumbs.at(-1);
  if (finalId === undefined) return false;
  const finalNode = getNode(menu, finalId);
  return finalNode.key === "URF_SUBMIT" || finalNode.button?.type === "submit";
}

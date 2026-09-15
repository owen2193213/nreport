type StatusCardPayload = {
  flags?: unknown;
  components?: unknown;
};

/** Safe structural metadata for a Discord Components V2 status-card payload. */
export function cardPayloadDiagnostics(options: StatusCardPayload, nonce?: string): Record<string, unknown> {
  const components = JSON.parse(JSON.stringify(options.components ?? [])) as unknown;
  const typeCounts: Record<string, number> = {};
  const textLengths: number[] = [];
  const inspect = (value: unknown): void => {
    if (Array.isArray(value)) return void value.forEach(inspect);
    if (typeof value !== "object" || value === null) return;
    const node = value as Record<string, unknown>;
    if (typeof node.type === "number") typeCounts[String(node.type)] = (typeCounts[String(node.type)] ?? 0) + 1;
    if (typeof node.content === "string") textLengths.push(node.content.length);
    if (Array.isArray(node.components)) inspect(node.components);
  };
  inspect(components);
  return {
    flags: options.flags,
    nonceLength: nonce?.length ?? 0,
    componentCount: Object.values(typeCounts).reduce((total, count) => total + count, 0),
    componentTypes: typeCounts,
    maxTextLength: Math.max(0, ...textLengths)
  };
}

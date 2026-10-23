const CLIENT_CAPABILITIES_KEY = 'io.modelcontextprotocol/clientCapabilities';

type HasEnvelope = { mcpReq: { envelope?: object } };

/** The capabilities this one request declared (2026-07-28 clients send them on every request). */
export function declaredCapabilities(ctx: HasEnvelope): Record<string, unknown> {
  const caps = (ctx.mcpReq.envelope as Record<string, unknown> | undefined)?.[CLIENT_CAPABILITIES_KEY];
  return typeof caps === 'object' && caps !== null ? (caps as Record<string, unknown>) : {};
}

/** True when the request declared `elicitation.url`. A bare `elicitation: {}` means form mode only. */
export function clientSupportsUrlElicitation(ctx: HasEnvelope): boolean {
  const elicitation = declaredCapabilities(ctx).elicitation;
  return typeof elicitation === 'object' && elicitation !== null && Object.hasOwn(elicitation, 'url');
}

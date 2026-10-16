import { isRecord } from "@openclaw/normalization-core/record-coerce";

/** Lossless, packet-local references; no previous event or list admission is required. */
export function shareSessionEventFields(payload: Record<string, unknown>): Record<string, unknown> {
  const session = payload.session;
  if (!isRecord(session)) {
    return payload;
  }
  const compact = { ...payload };
  const sessionFields: string[] = [];
  for (const [key, value] of Object.entries(payload)) {
    if (key === "session" || value === undefined || !Object.hasOwn(session, key)) {
      continue;
    }
    if (JSON.stringify(value) === JSON.stringify(session[key])) {
      sessionFields.push(key);
      delete compact[key];
    }
  }
  return { ...compact, sessionFields };
}

export function expandSessionEventFields(payload: unknown): unknown {
  if (!isRecord(payload) || !Array.isArray(payload.sessionFields) || !isRecord(payload.session)) {
    return payload;
  }
  const { sessionFields, ...envelope } = payload;
  const session = payload.session;
  return {
    ...Object.fromEntries(
      sessionFields.flatMap((key: unknown) =>
        typeof key === "string" && Object.hasOwn(session, key) ? [[key, session[key]]] : [],
      ),
    ),
    ...envelope,
  };
}

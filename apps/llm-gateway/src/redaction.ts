interface RedactionResult {
  readonly payload: unknown;
  readonly tokenToOriginal: ReadonlyMap<string, string>;
}

interface RedactionState {
  readonly counts: Map<string, number>;
  readonly originalToToken: Map<string, string>;
  readonly tokenToOriginal: Map<string, string>;
}

const PATTERNS: ReadonlyArray<{ readonly label: string; readonly pattern: RegExp }> = [
  { label: 'NHS', pattern: /\bNHS\s+\d{3}\s+\d{3}\s+\d{4}\b/gi },
  { label: 'DATE', pattern: /\b\d{4}-\d{2}-\d{2}\b/g },
  {
    label: 'ADDRESS',
    pattern:
      /\b\d{1,4}\s+[A-Z][A-Za-z' -]{1,60}\s+(?:Street|St|Road|Rd|Lane|Ln|Avenue|Ave|Close|Drive|Way)\b(?:,\s*[A-Z][A-Za-z' -]+)?/g,
  },
  {
    label: 'PERSON',
    pattern: /\b[A-Z][a-z]+(?:[-'][A-Z]?[a-z]+)?\s+[A-Z][a-z]+(?:[-'][A-Z]?[a-z]+)?\b/g,
  },
];

export function redactPayload(payload: unknown): RedactionResult {
  const state: RedactionState = {
    counts: new Map(),
    originalToToken: new Map(),
    tokenToOriginal: new Map(),
  };

  return {
    payload: redactUnknown(payload, state),
    tokenToOriginal: state.tokenToOriginal,
  };
}

export function rehydratePayload(
  payload: unknown,
  tokenToOriginal: ReadonlyMap<string, string>,
): unknown {
  if (typeof payload === 'string') {
    return rehydrateString(payload, tokenToOriginal);
  }
  if (Array.isArray(payload)) {
    return payload.map((item) => rehydratePayload(item, tokenToOriginal));
  }
  if (isRecord(payload)) {
    return Object.fromEntries(
      Object.entries(payload).map(([key, value]) => [
        key,
        rehydratePayload(value, tokenToOriginal),
      ]),
    );
  }
  return payload;
}

export function rehydrateString(
  value: string,
  tokenToOriginal: ReadonlyMap<string, string>,
): string {
  let result = value;
  for (const [token, original] of tokenToOriginal) {
    result = result.replaceAll(token, original);
  }
  return result;
}

function redactUnknown(value: unknown, state: RedactionState): unknown {
  if (typeof value === 'string') {
    return redactString(value, state);
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactUnknown(item, state));
  }
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, redactUnknown(item, state)]),
    );
  }
  return value;
}

function redactString(value: string, state: RedactionState): string {
  let result = value;
  for (const { label, pattern } of PATTERNS) {
    pattern.lastIndex = 0;
    result = result.replace(pattern, (original: string) => tokenFor(original, label, state));
  }
  return result;
}

function tokenFor(original: string, label: string, state: RedactionState): string {
  const existing = state.originalToToken.get(original);
  if (existing !== undefined) return existing;

  const next = (state.counts.get(label) ?? 0) + 1;
  state.counts.set(label, next);
  const token = `[${label}_${next}]`;
  state.originalToToken.set(original, token);
  state.tokenToOriginal.set(token, original);
  return token;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

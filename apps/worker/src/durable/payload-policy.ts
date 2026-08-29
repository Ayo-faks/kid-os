export const MAX_DURABLE_INSTANCE_ID_LENGTH = 100;
export const MAX_DURABLE_PAYLOAD_BYTES = 900_000;

const FORBIDDEN_PAYLOAD_KEYS = new Set([
  'bodyhtml',
  'bodytext',
  'documentcontent',
  'documenttext',
  'emailbody',
  'extractedtext',
  'formdata',
  'freetext',
  'instructions',
  'message',
  'note',
  'recipient',
  'recipientemail',
  'reason',
  'residentname',
  'summary',
  'title',
  'transcript',
]);

export function assertDurableInstanceId(instanceId: string): string {
  if (instanceId.length === 0 || instanceId.length > MAX_DURABLE_INSTANCE_ID_LENGTH) {
    throw new Error(
      `Durable instance ID length must be between 1 and ${MAX_DURABLE_INSTANCE_ID_LENGTH}.`,
    );
  }
  if (instanceId.startsWith('@')) {
    throw new Error('Durable instance IDs beginning with @ are reserved for entities.');
  }
  for (const character of instanceId) {
    const codePoint = character.codePointAt(0);
    if (codePoint === undefined || codePoint < 0x20 || codePoint > 0x7e) {
      throw new Error('Durable instance IDs must contain printable ASCII characters only.');
    }
  }
  return instanceId;
}

export function assertDurablePayload(payload: unknown, label: string): void {
  let serialized: string;
  try {
    serialized = JSON.stringify(payload);
  } catch {
    throw new Error(`${label} must be JSON serializable.`);
  }
  if (Buffer.byteLength(serialized, 'utf8') > MAX_DURABLE_PAYLOAD_BYTES) {
    throw new Error(`${label} exceeds the ${MAX_DURABLE_PAYLOAD_BYTES}-byte safety budget.`);
  }
  assertNoForbiddenFields(payload, label, new Set<object>());
}

function assertNoForbiddenFields(value: unknown, path: string, seen: Set<object>): void {
  if (typeof value !== 'object' || value === null) return;
  if (seen.has(value)) throw new Error(`${path} must not contain circular references.`);
  seen.add(value);

  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoForbiddenFields(item, `${path}[${index}]`, seen));
    seen.delete(value);
    return;
  }

  for (const [key, child] of Object.entries(value)) {
    const normalizedKey = key.toLowerCase().replaceAll(/[_-]/g, '');
    if (FORBIDDEN_PAYLOAD_KEYS.has(normalizedKey)) {
      throw new Error(`${path}.${key} is forbidden in Durable Task payloads.`);
    }
    assertNoForbiddenFields(child, `${path}.${key}`, seen);
  }
  seen.delete(value);
}

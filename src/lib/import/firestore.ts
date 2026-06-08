// Helpers for unwrapping Google Firestore REST "typed value" JSON.

type FirestoreValue =
  | { stringValue: string }
  | { booleanValue: boolean }
  | { integerValue: string }
  | { doubleValue: number }
  | { timestampValue: string }
  | { nullValue: null }
  | { arrayValue: { values?: FirestoreValue[] } }
  | { mapValue: { fields?: Record<string, FirestoreValue> } };

export type FirestoreDoc = {
  name: string;
  fields?: Record<string, FirestoreValue>;
};

// Recursively unwrap a single typed value into a plain JS value.
export function unwrapValue(value: FirestoreValue): unknown {
  if ("stringValue" in value) return value.stringValue;
  if ("booleanValue" in value) return value.booleanValue;
  if ("integerValue" in value) return Number(value.integerValue);
  if ("doubleValue" in value) return value.doubleValue;
  if ("timestampValue" in value) return value.timestampValue;
  if ("nullValue" in value) return null;
  if ("arrayValue" in value) {
    return (value.arrayValue.values ?? []).map(unwrapValue);
  }
  if ("mapValue" in value) {
    return unwrapFields(value.mapValue.fields ?? {});
  }
  return null;
}

// Unwrap a whole fields object into a plain record.
export function unwrapFields(
  fields: Record<string, FirestoreValue>
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(fields)) {
    out[key] = unwrapValue(val);
  }
  return out;
}

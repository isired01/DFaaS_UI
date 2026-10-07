// The validation rule set, fetched once from the gateway (GET /api/meta/schema)
// and shared by every form. The gateway enforces the same value on every write
// path, so the inline errors here and the 400s there cannot drift.
import { useEffect, useState } from 'react';
import { request } from '../api/client';

let promise = null;

/** Memoised fetch; safe to call from any submit handler. */
export function loadSchema() {
  if (!promise) {
    promise = request('/meta/schema').catch((err) => {
      promise = null; // let the next caller retry
      throw err;
    });
  }
  return promise;
}

/** For components: null until loaded, then the schema object. */
export function useSchema() {
  const [schema, setSchema] = useState(null);
  useEffect(() => {
    let alive = true;
    loadSchema().then((s) => { if (alive) setSchema(s); }).catch(() => {});
    return () => { alive = false; };
  }, []);
  return schema;
}

/** Compile a pattern the gateway serves as a regex source string. */
export const re = (source) => new RegExp(source);

/** Long label for an enum value, falling back to the raw value. */
export function enumLabel(options, value, key = 'label') {
  return options?.find((o) => o.value === value)?.[key] || value;
}

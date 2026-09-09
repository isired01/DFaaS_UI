import { useState, useEffect, useRef, useCallback } from 'react';
import { createPoll } from './resourcePoll.js';

// useResource is the React binding over resourcePoll: data starts null, the
// error survives until the next successful read, one read is in flight at a
// time, and the read is aborted on unmount. resourcePoll.js holds the policy
// and carries the reasoning; this file only wires it to state.
//
// `fetch` receives { signal } and may return anything, including a composite —
// EnvironmentDetail reads an Environment and its LoadTests under one error and
// one spinner.
//
// `shouldPoll(data)` gates the interval only, never the first read, and is
// called with the newest data from a ref. That is why the effect does not need
// the resource's own Phase in its dependency array: LoadTestDetail used to list
// `loadtest?.phase` there behind an eslint-disable, which tore down and re-armed
// the interval and fired a redundant read on every Phase transition.
//
// `setError` is returned because the pages' own download / upload / delete
// handlers write into this same error state.
export function useResource(fetch, { pollMs = 0, shouldPoll, deps = [] } = {}) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  // Read through refs so a fresh closure per render never re-arms the interval.
  const fetchRef = useRef(fetch);
  fetchRef.current = fetch;
  const shouldPollRef = useRef(shouldPoll);
  shouldPollRef.current = shouldPoll;

  const pollRef = useRef(null);

  useEffect(() => {
    const poll = createPoll({
      fetch: (opts) => fetchRef.current(opts),
      onData: (d) => { setData(d); setError(null); },
      onError: (err) => setError(err.message),
      onSettled: () => setLoading(false),
      shouldPoll: (d) => (shouldPollRef.current ? shouldPollRef.current(d) : true),
    });
    pollRef.current = poll;
    poll.load();
    const interval = pollMs > 0 ? setInterval(() => poll.tick(), pollMs) : null;
    return () => {
      if (interval) clearInterval(interval);
      poll.stop();
      pollRef.current = null;
    };
    // The caller's deps are spread in: this effect re-arms when the identity of
    // the resource changes (namespace, name), not when its contents do.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pollMs, ...deps]);

  // A manual refresh shows the spinner; an interval tick never does, so a
  // background poll cannot flash the page back to "Loading...".
  const reload = useCallback(() => {
    setLoading(true);
    return pollRef.current?.load();
  }, []);

  // setData is for the pages that already hold an authoritative object: after
  // an activate or an abort the write path returns the updated LoadTest, and
  // reload() would go through the in-flight guard and be dropped if a poll
  // happened to be running.
  return { data, setData, loading, error, reload, setError };
}

import { useEffect, useState } from "react";
import { listMyAgencies } from "../lib/agencies.js";

const STORAGE_KEY = "rls-watch:agency-id";

function readStored() {
  try {
    return localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

function writeStored(id) {
  try {
    if (id) localStorage.setItem(STORAGE_KEY, id);
  } catch {
    // ignore (private browsing, storage disabled, etc.)
  }
}

/**
 * Which agency the signed-in user is currently looking at, persisted in
 * localStorage so it survives a reload. Falls back to their first agency
 * if the stored id is stale (e.g. they lost access to it).
 */
export function useCurrentAgency() {
  const [agencies, setAgencies] = useState(null); // null = still loading
  const [agencyId, setAgencyId] = useState(readStored);
  const [error, setError] = useState(null);

  useEffect(() => {
    let cancelled = false;
    listMyAgencies()
      .then((list) => {
        if (cancelled) return;
        setAgencies(list);
        setAgencyId((current) => {
          const next = list.some((a) => a.id === current) ? current : (list[0]?.id ?? null);
          writeStored(next);
          return next;
        });
      })
      .catch((e) => !cancelled && setError(e.message));
    return () => {
      cancelled = true;
    };
  }, []);

  function selectAgency(id) {
    setAgencyId(id);
    writeStored(id);
  }

  function addAgency(agency) {
    setAgencies((prev) => [...(prev ?? []), agency]);
    selectAgency(agency.id);
  }

  return { agencies, agencyId, selectAgency, addAgency, error, loading: agencies === null };
}

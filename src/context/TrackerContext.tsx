"use client";

import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import { useLocation } from "@/context/LocationContext";

const STORAGE_KEY = "tracked_sets";
const PROMPT_SEEN_KEY = "tracker_save_prompt_seen";

interface TrackerContextValue {
  tracked: string[];
  hydrated: boolean;
  authenticated: boolean;
  email: string | null;
  alertsEnabled: boolean;
  isTracked: (slug: string) => boolean;
  toggle: (slug: string) => void;
  getShareUrl: (countryCode: string) => string;
  openSavePrompt: () => void;
  logout: () => Promise<void>;
  setAlertsEnabled: (enabled: boolean) => Promise<void>;
}

const TrackerContext = createContext<TrackerContextValue | null>(null);

function readLocalTracker(): string[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed)
      ? Array.from(new Set(parsed.map(String).filter(Boolean))).slice(0, 200)
      : [];
  } catch {
    return [];
  }
}

function writeLocalTracker(slugs: string[]) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(slugs));
}

export function TrackerProvider({ children }: { children: React.ReactNode }) {
  const { countryCode, region, currency } = useLocation();
  const [tracked, setTracked] = useState<string[]>([]);
  const [hydrated, setHydrated] = useState(false);
  const [authenticated, setAuthenticated] = useState(false);
  const [email, setEmail] = useState<string | null>(null);
  const [alertsEnabled, setAlertsState] = useState(true);
  const [savePromptOpen, setSavePromptOpen] = useState(false);

  const applyTracker = useCallback((slugs: string[]) => {
    const unique = Array.from(new Set(slugs)).slice(0, 200);
    setTracked(unique);
    writeLocalTracker(unique);
  }, []);

  const syncAuthenticatedTracker = useCallback(
    async (localSlugs: string[]) => {
      const response = await fetch("/api/tracker/sync", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          slugs: localSlugs,
          countryCode,
          region,
          currency,
        }),
      });
      if (!response.ok) return;
      const data = await response.json();
      applyTracker(Array.isArray(data.slugs) ? data.slugs : localSlugs);
    },
    [applyTracker, countryCode, region, currency]
  );

  const refreshSession = useCallback(
    async (localSlugs = readLocalTracker()) => {
      try {
        const response = await fetch("/api/auth/session", { cache: "no-store" });
        const data = await response.json();
        if (!data.authenticated) {
          setAuthenticated(false);
          setEmail(null);
          applyTracker(localSlugs);
          return false;
        }
        setAuthenticated(true);
        setEmail(data.user.email);
        setAlertsState(data.user.alertsEnabled !== false);
        await syncAuthenticatedTracker(localSlugs);
        return true;
      } catch {
        applyTracker(localSlugs);
        return false;
      }
    },
    [applyTracker, syncAuthenticatedTracker]
  );

  useEffect(() => {
    refreshSession().finally(() => setHydrated(true));
  }, [refreshSession]);

  useEffect(() => {
    if (!authenticated || !hydrated) return;
    fetch("/api/tracker", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ countryCode, region, currency }),
    }).catch(() => {});
  }, [authenticated, hydrated, countryCode, region, currency]);

  const toggle = useCallback(
    (slug: string) => {
      const removing = tracked.includes(slug);
      const next = removing ? tracked.filter((item) => item !== slug) : [...tracked, slug];
      applyTracker(next);

      if (authenticated) {
        fetch(
          removing
            ? `/api/tracker/items/${encodeURIComponent(slug)}`
            : "/api/tracker/items",
          {
            method: removing ? "DELETE" : "POST",
            headers: removing ? undefined : { "Content-Type": "application/json" },
            body: removing ? undefined : JSON.stringify({ slug }),
          }
        ).catch(() => {});
      } else if (!removing && !localStorage.getItem(PROMPT_SEEN_KEY)) {
        localStorage.setItem(PROMPT_SEEN_KEY, "1");
        setSavePromptOpen(true);
      }
    },
    [applyTracker, authenticated, tracked]
  );

  const isTracked = useCallback((slug: string) => tracked.includes(slug), [tracked]);

  const getShareUrl = useCallback(
    (shareCountryCode: string) => {
      const params = new URLSearchParams({
        sets: tracked.join(","),
        country: shareCountryCode,
      });
      return `${window.location.origin}/tracker?${params}`;
    },
    [tracked]
  );

  const logout = useCallback(async () => {
    await fetch("/api/auth/logout", { method: "POST" }).catch(() => {});
    setAuthenticated(false);
    setEmail(null);
  }, []);

  const setAlertsEnabled = useCallback(async (enabled: boolean) => {
    const response = await fetch("/api/tracker", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ alertsEnabled: enabled }),
    });
    if (!response.ok) throw new Error("Could not update alerts");
    setAlertsState(enabled);
  }, []);

  const value = useMemo(
    () => ({
      tracked,
      hydrated,
      authenticated,
      email,
      alertsEnabled,
      isTracked,
      toggle,
      getShareUrl,
      openSavePrompt: () => setSavePromptOpen(true),
      logout,
      setAlertsEnabled,
    }),
    [
      tracked,
      hydrated,
      authenticated,
      email,
      alertsEnabled,
      isTracked,
      toggle,
      getShareUrl,
      logout,
      setAlertsEnabled,
    ]
  );

  return (
    <TrackerContext.Provider value={value}>
      {children}
      <SaveTrackerModal
        open={savePromptOpen}
        slugs={tracked}
        countryCode={countryCode}
        region={region}
        currency={currency}
        onClose={() => setSavePromptOpen(false)}
        onVerified={async () => {
          await refreshSession(readLocalTracker());
          setSavePromptOpen(false);
        }}
      />
    </TrackerContext.Provider>
  );
}

function SaveTrackerModal({
  open,
  slugs,
  countryCode,
  region,
  currency,
  onClose,
  onVerified,
}: {
  open: boolean;
  slugs: string[];
  countryCode: string;
  region: string;
  currency: string;
  onClose: () => void;
  onVerified: () => Promise<void>;
}) {
  const [email, setEmail] = useState("");
  const [otp, setOtp] = useState("");
  const [stage, setStage] = useState<"email" | "code">("email");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [resent, setResent] = useState(false);

  useEffect(() => {
    if (!open) {
      setStage("email");
      setOtp("");
      setError("");
      setBusy(false);
      setResent(false);
    }
  }, [open]);

  useEffect(() => {
    if (!open) return;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = "";
    };
  }, [open]);

  const requestCode = async () => {
    setBusy(true);
    setError("");
    try {
      const response = await fetch("/api/auth/request", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, slugs, countryCode, region, currency }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Could not send email");
      setStage("code");
      setResent(true);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Could not send email");
    } finally {
      setBusy(false);
    }
  };

  const verifyCode = async () => {
    setBusy(true);
    setError("");
    try {
      const response = await fetch("/api/auth/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, otp }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Could not verify code");
      await onVerified();
    } catch (verifyError) {
      setError(verifyError instanceof Error ? verifyError.message : "Could not verify code");
    } finally {
      setBusy(false);
    }
  };

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <button
        className="absolute inset-0 bg-black/45 backdrop-blur-sm"
        onClick={onClose}
        aria-label="Close save tracker dialog"
      />
      <div className="relative w-full max-w-md rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 shadow-2xl">
        <div className="flex items-start justify-between gap-4 border-b border-gray-100 dark:border-gray-800 px-5 py-4">
          <div>
            <h2 className="text-lg font-semibold text-gray-900 dark:text-white">
              Save your tracker
            </h2>
            <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
              Sync your list and receive important keyboard and keycap updates.
            </p>
          </div>
          <button
            onClick={onClose}
            title="Close"
            className="p-1 text-gray-400 hover:text-gray-700 dark:hover:text-gray-200"
          >
            <svg className="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor">
              <path strokeLinecap="round" strokeWidth={2} d="M6 6l12 12M18 6L6 18" />
            </svg>
          </button>
        </div>

        <div className="space-y-4 px-5 py-5">
          {stage === "email" ? (
            <>
              <label className="block">
                <span className="mb-1.5 block text-sm font-medium text-gray-700 dark:text-gray-200">
                  Email address
                </span>
                <input
                  type="email"
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") requestCode();
                  }}
                  autoFocus
                  autoComplete="email"
                  placeholder="you@example.com"
                  className="w-full rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-950 px-3 py-2.5 text-sm text-gray-900 dark:text-white outline-none focus:border-indigo-500 focus:ring-2 focus:ring-indigo-100 dark:focus:ring-indigo-950"
                />
              </label>
              <button
                onClick={requestCode}
                disabled={busy || !email.trim()}
                className="w-full rounded-lg bg-indigo-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-indigo-700 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {busy ? "Sending..." : "Email me a sign-in link"}
              </button>
            </>
          ) : (
            <>
              <div className="rounded-lg border border-indigo-100 dark:border-indigo-900 bg-indigo-50 dark:bg-indigo-950/40 px-3 py-2.5 text-sm text-indigo-800 dark:text-indigo-200">
                Check <strong>{email}</strong> for a magic link or 6-digit code.
              </div>
              <label className="block">
                <span className="mb-1.5 block text-sm font-medium text-gray-700 dark:text-gray-200">
                  Verification code
                </span>
                <input
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  value={otp}
                  onChange={(event) =>
                    setOtp(event.target.value.replace(/\D/g, "").slice(0, 6))
                  }
                  onKeyDown={(event) => {
                    if (event.key === "Enter" && otp.length === 6) verifyCode();
                  }}
                  autoFocus
                  placeholder="000000"
                  className="w-full rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-950 px-3 py-3 text-center font-mono text-2xl tracking-[0.35em] text-gray-900 dark:text-white outline-none focus:border-indigo-500 focus:ring-2 focus:ring-indigo-100 dark:focus:ring-indigo-950"
                />
              </label>
              <button
                onClick={verifyCode}
                disabled={busy || otp.length !== 6}
                className="w-full rounded-lg bg-indigo-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-indigo-700 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {busy ? "Verifying..." : "Verify and sync tracker"}
              </button>
              <div className="flex items-center justify-between text-xs">
                <button
                  onClick={() => {
                    setStage("email");
                    setError("");
                  }}
                  className="text-gray-500 hover:text-gray-800 dark:hover:text-gray-200"
                >
                  Use another email
                </button>
                <button
                  onClick={requestCode}
                  disabled={busy}
                  className="font-medium text-indigo-600 hover:text-indigo-800 disabled:opacity-50"
                >
                  {resent ? "Resend code" : "Send code"}
                </button>
              </div>
            </>
          )}

          {error && (
            <p role="alert" className="text-sm text-red-600 dark:text-red-400">
              {error}
            </p>
          )}
          <p className="text-xs leading-relaxed text-gray-400 dark:text-gray-500">
            Your email is used only for tracker access and alerts you enable. No password
            or marketing signup.
          </p>
        </div>
      </div>
    </div>
  );
}

export function useTracker(): TrackerContextValue {
  const context = useContext(TrackerContext);
  if (!context) throw new Error("useTracker must be used inside TrackerProvider");
  return context;
}

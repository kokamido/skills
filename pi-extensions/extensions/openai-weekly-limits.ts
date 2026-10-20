import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const STATUS = "openai-codex-weekly-limit";
const USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
const RESET_CREDITS_URL = "https://chatgpt.com/backend-api/wham/rate-limit-reset-credits";
const POLL_MS = 5 * 60_000;
const WEEK_SECONDS = 7 * 24 * 60 * 60;

type Window = {
  used_percent?: number;
  limit_window_seconds?: number;
  reset_at?: number;
  reset_after_seconds?: number;
};

function accountIdFromToken(token: string): string | undefined {
  try {
    const payload = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf8"));
    const id = payload?.["https://api.openai.com/auth"]?.chatgpt_account_id;
    return typeof id === "string" && id ? id : undefined;
  } catch {
    return undefined;
  }
}

export function formatWeeklyLimit(data: unknown, now = Date.now()): string {
  const limit = (data as { rate_limit?: { primary_window?: Window; secondary_window?: Window } } | null)?.rate_limit;
  const weekly = [limit?.primary_window, limit?.secondary_window].filter(
    (window): window is Window => window != null &&
      typeof window.limit_window_seconds === "number" &&
      Math.abs(window.limit_window_seconds - WEEK_SECONDS) < 60 * 60,
  );
  if (!weekly.length) return "Codex 7д: нет данных о лимите";

  return weekly.map((window) => {
    const used = window.used_percent;
    if (typeof used !== "number" || !Number.isFinite(used) || used < 0 || used > 100) {
      return "Codex 7д: нет данных о расходе";
    }
    const left = (100 - used).toFixed(1).replace(/\.0$/, "");
    const reset = typeof window.reset_at === "number" && Number.isFinite(window.reset_at)
      ? window.reset_at * 1000
      : typeof window.reset_after_seconds === "number" && Number.isFinite(window.reset_after_seconds)
        ? now + window.reset_after_seconds * 1000
        : undefined;
    if (reset === undefined) return `Codex 7д: ${left}% осталось`;

    const hours = Math.ceil(Math.max(0, reset - now) / 3_600_000);
    const days = Math.floor(hours / 24);
    const remaining = days ? `${days}д ${hours % 24}ч` : `${hours}ч`;
    return `Codex 7д: ${left}% осталось · сброс через ${remaining}`;
  }).join(" | ");
}

export function formatResetCredits(usage: unknown, data: unknown, now = Date.now()): string {
  const summary = usage as { rate_limit_reset_credits?: { available_count?: unknown } } | null;
  const details = data as {
    available_count?: unknown;
    credits?: { status?: string; is_supported_by_plan?: boolean; expires_at?: string | null }[];
  } | null;
  const validCount = (value: unknown): value is number =>
    typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
  const count = validCount(details?.available_count)
    ? details.available_count
    : summary?.rate_limit_reset_credits?.available_count;
  if (!validCount(count)) return "резеты: нет данных";
  if (count === 0) return "резеты: 0";

  const expirations = (Array.isArray(details?.credits) ? details.credits : [])
    .filter((credit) => credit?.status === "available" && credit.is_supported_by_plan !== false)
    .map((credit) => typeof credit.expires_at === "string" ? Date.parse(credit.expires_at) : NaN)
    .filter((expiry) => Number.isFinite(expiry) && expiry > now);
  if (!expirations.length) return `резеты: ${count} · дата сгорания неизвестна`;

  // Show the calendar date in the user's local timezone, like the rest of the TUI.
  const date = new Date(Math.min(...expirations)).toLocaleDateString("ru-RU", {
    day: "2-digit", month: "2-digit", year: "numeric",
  });
  return `резеты: ${count} · ближайший сгорит ${date}`;
}

export default function (pi: ExtensionAPI) {
  let interval: ReturnType<typeof setInterval> | undefined;
  let request: AbortController | undefined;
  let lastAttempt = 0;
  let stopped = false;

  async function update(ctx: ExtensionContext) {
    if (stopped || request) return;
    lastAttempt = Date.now();
    request = new AbortController();
    const controller = request;
    try {
      // Pi resolves/refreshes its OAuth token; no credentials are stored by this extension.
      const token = (await ctx.modelRegistry.getProviderAuth("openai-codex"))?.auth.apiKey;
      if (stopped || controller.signal.aborted) return;
      const accountId = token && accountIdFromToken(token);
      if (!token || !accountId) {
        ctx.ui.setStatus(STATUS, "Codex 7д: нужна авторизация (/login)");
        return;
      }

      const fetchData = async (url: string): Promise<unknown> => {
        const response = await fetch(url, {
          headers: { Authorization: `Bearer ${token}`, "chatgpt-account-id": accountId },
          signal: AbortSignal.any([controller.signal, AbortSignal.timeout(8_000)]),
        });
        if (!response.ok) throw new Error("Usage request failed");
        return response.json();
      };
      // Read-only requests: displaying reset credits never redeems them.
      // Keep either indicator working if the other endpoint is unavailable.
      const [usage, credits] = await Promise.allSettled([
        fetchData(USAGE_URL), fetchData(RESET_CREDITS_URL),
      ]);
      const data = usage.status === "fulfilled" ? usage.value : undefined;
      const resetData = credits.status === "fulfilled" ? credits.value : undefined;
      const weekly = usage.status === "fulfilled" ? formatWeeklyLimit(data) : "Codex 7д: данные недоступны";
      if (!stopped && !controller.signal.aborted) {
        ctx.ui.setStatus(STATUS, `${weekly} | ${formatResetCredits(data, resetData)}`);
      }
    } catch {
      if (!stopped) ctx.ui.setStatus(STATUS, "Codex 7д: данные недоступны | резеты: нет данных");
    } finally {
      if (request === controller) request = undefined;
    }
  }

  pi.on("session_start", (_event, ctx) => {
    if (ctx.mode !== "tui") return;
    stopped = false;
    void update(ctx);
    interval = setInterval(() => void update(ctx), POLL_MS);
  });

  pi.on("agent_settled", (_event, ctx) => {
    if (ctx.mode === "tui" && Date.now() - lastAttempt >= 60_000) void update(ctx);
  });

  pi.on("session_shutdown", (_event, ctx) => {
    stopped = true;
    if (interval) clearInterval(interval);
    interval = undefined;
    request?.abort();
    ctx.ui.setStatus(STATUS, undefined);
  });
}

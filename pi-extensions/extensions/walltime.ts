import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// Sort before longer extension statuses so the clock stays visible on narrow terminals.
const STATUS = "00-walltime";

export function formatWalltime(milliseconds: number): string {
  const seconds = Math.max(0, Math.floor(milliseconds / 1000));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor(seconds / 60) % 60;
  return [hours, minutes, seconds % 60].map((part) => String(part).padStart(2, "0")).join(":");
}

export default function (pi: ExtensionAPI) {
  let interval: ReturnType<typeof setInterval> | undefined;

  function stop() {
    if (interval !== undefined) clearInterval(interval);
    interval = undefined;
  }

  pi.on("session_start", (_event, ctx) => {
    stop();
    if (ctx.mode !== "tui") return;

    // Deliberately not persisted: startup/resume/new/fork/reload start from zero.
    // Monotonic elapsed time includes idle time and is unaffected by clock adjustments.
    const startedAt = performance.now();
    const update = () => ctx.ui.setStatus(STATUS, `walltime ${formatWalltime(performance.now() - startedAt)}`);
    update();
    interval = setInterval(update, 1000);
    interval.unref();
  });

  pi.on("session_shutdown", (_event, ctx) => {
    stop();
    if (ctx.mode === "tui") ctx.ui.setStatus(STATUS, undefined);
  });
}

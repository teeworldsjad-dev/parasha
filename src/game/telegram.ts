/**
 * telegram.ts — optional Telegram Mini Apps integration. Everything is feature-detected:
 * inside a normal browser every call is a no-op, so the game runs identically outside Telegram.
 * (No external script is loaded; the Telegram webview injects window.Telegram itself.)
 */

interface TgHaptic {
  impactOccurred?: (style: "light" | "medium" | "heavy" | "rigid" | "soft") => void;
  notificationOccurred?: (type: "error" | "success" | "warning") => void;
}

interface TgWebApp {
  ready?: () => void;
  expand?: () => void;
  disableVerticalSwipes?: () => void;
  setHeaderColor?: (color: string) => void;
  setBackgroundColor?: (color: string) => void;
  hapticFeedback?: TgHaptic;
}

function tg(): TgWebApp | null {
  const w = window as unknown as { Telegram?: { WebApp?: TgWebApp } };
  return w.Telegram?.WebApp ?? null;
}

/** call once at boot */
export function initTelegram(): void {
  const app = tg();
  if (!app) return;
  try {
    app.ready?.();
    app.expand?.();
    app.disableVerticalSwipes?.();
    app.setHeaderColor?.("#0d1420");
    app.setBackgroundColor?.("#0d1420");
  } catch {
    // never let Telegram integration break the game
  }
}

export function hapticImpact(style: "light" | "medium" | "heavy"): void {
  try {
    tg()?.hapticFeedback?.impactOccurred?.(style);
  } catch {
    /* noop */
  }
}

export function hapticNotify(type: "error" | "success" | "warning"): void {
  try {
    tg()?.hapticFeedback?.notificationOccurred?.(type);
  } catch {
    /* noop */
  }
}

/** true when running inside a Telegram webview */
export function isTelegram(): boolean {
  return tg() !== null;
}

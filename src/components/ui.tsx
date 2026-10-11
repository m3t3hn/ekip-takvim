"use client";

import clsx from "clsx";
import { Check } from "lucide-react";
import {
  createContext,
  useCallback,
  useContext,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type ComponentProps,
  type ReactNode,
  type SelectHTMLAttributes,
} from "react";
import { colorStyle } from "@/lib/colors";

export const cn = clsx;

export function firstName(name: string): string {
  return name.split(/\s+/)[0];
}

export function initials(name: string): string {
  const parts = name.trim().split(/\s+/);
  return ((parts[0]?.[0] ?? "") + (parts.length > 1 ? parts[parts.length - 1][0] : "")).toLocaleUpperCase("tr");
}

const focusRing =
  "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent";

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "outlined" | "tonal" | "primary" | "danger" | "text";
};

export function Button({ variant = "outlined", className, ...props }: ButtonProps) {
  return (
    <button
      type="button"
      className={cn(
        "inline-flex h-9 items-center justify-center gap-2 rounded-full px-4 text-sm font-medium whitespace-nowrap transition-colors select-none disabled:opacity-50",
        focusRing,
        variant === "outlined" && "border border-grid-strong text-fg-2 hover:bg-hover",
        variant === "tonal" && "bg-accent-container text-on-accent-container hover:brightness-95",
        variant === "primary" && "bg-accent text-on-accent hover:brightness-110",
        variant === "danger" && "border border-danger/50 text-danger hover:bg-danger-container",
        variant === "text" && "px-3 text-accent hover:bg-hover",
        className,
      )}
      {...props}
    />
  );
}

export function IconButton({
  className,
  size = "md",
  ...props
}: ComponentProps<"button"> & { size?: "sm" | "md" }) {
  return (
    <button
      type="button"
      className={cn(
        "inline-grid shrink-0 place-items-center rounded-full text-fg-2 transition-colors hover:bg-hover disabled:opacity-50",
        size === "md" ? "size-10" : "size-8",
        focusRing,
        className,
      )}
      {...props}
    />
  );
}

export function Select({
  className,
  children,
  ...props
}: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select
      className={cn(
        "h-9 cursor-pointer appearance-none rounded-full border border-grid-strong bg-transparent pr-8 pl-4 text-sm font-medium text-fg-2 hover:bg-hover",
        "bg-[length:14px] bg-[right_10px_center] bg-no-repeat",
        focusRing,
        className,
      )}
      style={{
        backgroundImage:
          "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='%235f6368'%3E%3Cpath d='M7 10l5 5 5-5z'/%3E%3C/svg%3E\")",
      }}
      {...props}
    >
      {children}
    </select>
  );
}

export function Avatar({
  name,
  color,
  size = 32,
  className,
}: {
  name: string;
  color: string;
  size?: number;
  className?: string;
}) {
  return (
    <span
      aria-hidden
      className={cn(
        "swatch inline-grid shrink-0 place-items-center rounded-full font-medium text-[var(--pc-on)]",
        className,
      )}
      style={{ ...colorStyle(color), width: size, height: size, fontSize: size * 0.4 }}
    >
      {initials(name)}
    </span>
  );
}

export function ColorCheckbox({
  checked,
  color,
  label,
  onChange,
  children,
}: {
  checked: boolean;
  color: string;
  label: string;
  onChange: (checked: boolean) => void;
  children: ReactNode;
}) {
  return (
    <label
      className={cn(
        "group flex h-8 cursor-pointer items-center gap-3 rounded-full pr-2 pl-3 text-sm text-fg-2 hover:bg-hover",
        "has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-accent",
      )}
    >
      <input
        type="checkbox"
        className="sr-only"
        checked={checked}
        aria-label={label}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span
        aria-hidden
        className={cn(
          "grid size-[18px] shrink-0 place-items-center rounded-[3px] border-2 border-[var(--pc)]",
          checked && "swatch",
        )}
        style={colorStyle(color)}
      >
        {checked && <Check className="size-3.5 text-[var(--pc-on)]" strokeWidth={3.5} />}
      </span>
      {children}
    </label>
  );
}

const ToastContext = createContext<(message: string) => void>(() => {});

export function ToastProvider({ children }: { children: ReactNode }) {
  const [message, setMessage] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const notify = useCallback((m: string) => {
    setMessage(m);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setMessage(null), 2600);
  }, []);
  return (
    <ToastContext.Provider value={notify}>
      {children}
      <div
        role="status"
        aria-live="polite"
        className={cn(
          "pointer-events-none fixed bottom-6 left-6 z-50 transition-all duration-200 max-sm:right-6",
          message ? "translate-y-0 opacity-100" : "translate-y-3 opacity-0",
        )}
      >
        {message && (
          <div className="rounded-md bg-snackbar px-4 py-3.5 font-body text-sm text-on-snackbar shadow-[var(--shadow-card)]">
            {message}
          </div>
        )}
      </div>
    </ToastContext.Provider>
  );
}

export function useNotify() {
  return useContext(ToastContext);
}

// The async clipboard API only exists on https/localhost; on a plain-http
// intranet address fall back to the old select-and-copy trick.
function legacyCopy(text: string): boolean {
  const area = document.createElement("textarea");
  area.value = text;
  area.setAttribute("readonly", "");
  area.style.position = "fixed";
  area.style.opacity = "0";
  document.body.appendChild(area);
  area.select();
  let ok = false;
  try {
    ok = document.execCommand("copy");
  } catch {}
  area.remove();
  return ok;
}

export function useCopy() {
  const notify = useNotify();
  return useCallback(
    async (text: string, message = "Copied to clipboard") => {
      try {
        if (!navigator.clipboard || !window.isSecureContext) throw new Error("no clipboard api");
        await navigator.clipboard.writeText(text);
        notify(message);
      } catch {
        notify(legacyCopy(text) ? message : "Couldn't copy — your browser blocked clipboard access");
      }
    },
    [notify],
  );
}

/** Two overlapping circles: everyone's calendars, and the time they share. */
export function LogoMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 32" className={className} aria-hidden>
      <defs>
        <clipPath id="logo-left">
          <circle cx="12.5" cy="16" r="6.5" />
        </clipPath>
      </defs>
      <rect width="32" height="32" rx="9" fill="#5145cd" />
      <circle cx="19.5" cy="16" r="6.5" fill="#7ee2a8" clipPath="url(#logo-left)" />
      <circle cx="12.5" cy="16" r="6.5" fill="none" stroke="#fff" strokeWidth="2.2" />
      <circle cx="19.5" cy="16" r="6.5" fill="none" stroke="#fff" strokeWidth="2.2" />
    </svg>
  );
}

export function Input({ className, ...props }: ComponentProps<"input">) {
  return (
    <input
      className={cn(
        "h-10 w-full rounded-lg border border-grid-strong bg-surface px-3 font-body text-sm text-fg placeholder:text-fg-3",
        "focus:border-accent focus:outline-2 focus:outline-offset-0 focus:outline-accent/30",
        className,
      )}
      {...props}
    />
  );
}

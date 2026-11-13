import Link from "next/link";
import { buttonClass, type ButtonSize, type ButtonVariant } from "@/lib/ui";

type Common = { variant?: ButtonVariant; size?: ButtonSize; className?: string; children: React.ReactNode };
type AsLink = Common & { href: string; onClick?: never; disabled?: never; loading?: never };
type AsButton = Common & { href?: undefined; onClick?: () => void; disabled?: boolean; loading?: boolean; type?: "button" | "submit" };

/** One button for the whole app. With `href` it is a real link (navigation); otherwise a real <button> (action). Loading disables it and says so to screen readers. */
export default function Button(p: AsLink | AsButton) {
  const cls = buttonClass(p.variant, p.size, p.className);
  if (p.href !== undefined) return <Link className={cls} href={p.href}>{p.children}</Link>;
  const b = p as AsButton;
  return <button type={b.type ?? "button"} className={cls} onClick={b.onClick} disabled={b.disabled || b.loading} aria-busy={b.loading || undefined}>{b.children}</button>;
}

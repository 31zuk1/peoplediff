import clsx from "clsx";
import type { PairStatus } from "@/lib/types";

const styles: Record<PairStatus, string> = {
  MATCHED: "border-emerald-300/30 bg-emerald-400/12 text-emerald-200",
  "CN ONLY": "border-cyan-300/30 bg-cyan-400/12 text-cyan-100",
  "JP ONLY": "border-violet-300/30 bg-violet-400/12 text-violet-100",
  "TARGET ONLY": "border-violet-300/30 bg-violet-400/12 text-violet-100",
  "FRAMING SHIFT": "border-amber-300/40 bg-amber-400/14 text-amber-100",
  "BODY DIFFERENCE": "border-rose-300/35 bg-rose-400/12 text-rose-100"
};

export default function StatusBadge({
  status,
  label,
  className
}: {
  status: PairStatus;
  label?: string;
  className?: string;
}) {
  return (
    <span
      className={clsx(
        "inline-flex items-center rounded border px-2 py-1 text-[10px] font-semibold uppercase tracking-[0.16em]",
        styles[status],
        className
      )}
    >
      {label ?? status}
    </span>
  );
}

import { cn } from "@/lib/utils";

export function MetricStat({
  label,
  value,
  hint,
  accent,
}: {
  label: string;
  value: string | number;
  hint?: string;
  accent?: boolean;
}) {
  return (
    <div className="rounded-lg border border-border/60 bg-muted/30 px-3 py-2.5">
      <p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
        {label}
      </p>
      <p
        className={cn(
          "mt-0.5 font-mono text-lg font-semibold tabular-nums",
          accent ? "text-chart-2" : "text-foreground",
        )}
      >
        {value}
      </p>
      {hint && (
        <p className="mt-1 text-[10px] leading-snug text-muted-foreground/80">
          {hint}
        </p>
      )}
    </div>
  );
}

import type { ComponentType, ReactNode } from "react";
import { Card, CardContent } from "@/components/ui/card";
import {
  Tooltip as UITooltip, TooltipContent, TooltipProvider, TooltipTrigger,
} from "@/components/ui/tooltip";

export type KpiAccent = "primary" | "success" | "warning" | "info" | "danger";

const accentMap: Record<KpiAccent, { border: string; bg: string; icon: string }> = {
  primary: { border: "border-l-primary", bg: "bg-primary/10", icon: "text-primary" },
  success: { border: "border-l-emerald-500", bg: "bg-emerald-500/10", icon: "text-emerald-600" },
  warning: { border: "border-l-amber-500", bg: "bg-amber-500/10", icon: "text-amber-600" },
  info: { border: "border-l-sky-500", bg: "bg-sky-500/10", icon: "text-sky-600" },
  danger: { border: "border-l-red-500", bg: "bg-red-500/10", icon: "text-red-600" },
};

export function KpiCard({
  title, value, icon: Icon, sub, footer, accent = "primary", onClick, tooltip,
}: {
  title: string;
  value: string;
  icon: ComponentType<{ className?: string }>;
  sub?: string;
  footer?: ReactNode;
  accent?: KpiAccent;
  onClick?: () => void;
  tooltip?: string;
}) {
  const a = accentMap[accent];
  const card = (
    <Card
      className={`border-l-4 ${a.border} h-full ${onClick ? "cursor-pointer transition-shadow hover:shadow-md" : ""}`}
      onClick={onClick}
    >
      <CardContent className="p-5">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <p className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wider leading-tight min-h-[28px]">{title}</p>
            <p className="text-[1.35rem] leading-tight font-bold mt-1 whitespace-nowrap" title={tooltip}>{value}</p>
            {sub && <p className="text-xs text-muted-foreground mt-1 leading-snug">{sub}</p>}
          </div>
          <div className={`p-2 rounded-lg ${a.bg} ${a.icon} shrink-0`}>
            <Icon className="h-5 w-5" />
          </div>
        </div>
        {footer && <div className="mt-3 text-xs font-semibold">{footer}</div>}
      </CardContent>
    </Card>
  );

  if (!tooltip) return card;
  return (
    <TooltipProvider delayDuration={200}>
      <UITooltip>
        <TooltipTrigger asChild><div className="h-full">{card}</div></TooltipTrigger>
        <TooltipContent side="bottom">{tooltip}</TooltipContent>
      </UITooltip>
    </TooltipProvider>
  );
}

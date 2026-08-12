import { useMemo, useState } from "react";
import { ChevronDown, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { ALL, stripAccents } from "@/lib/dashboard/domain";

export function MultiSelectFilter({
  label, selected, options, onChange, searchable = true,
}: {
  label: string;
  selected: string[];
  options: string[];
  onChange: (v: string[]) => void;
  searchable?: boolean;
}) {
  const [query, setQuery] = useState("");
  const isAll = selected.length === 0;
  const display = isAll ? ALL : selected.length === 1 ? selected[0] : `${selected.length} selecionados`;

  const visible = useMemo(() => {
    const q = stripAccents(query).trim().toUpperCase();
    if (!q) return options;
    return options.filter((o) => stripAccents(o).toUpperCase().includes(q));
  }, [options, query]);

  const toggle = (opt: string) => {
    if (selected.includes(opt)) onChange(selected.filter((s) => s !== opt));
    else onChange([...selected, opt]);
  };

  return (
    <div className="flex flex-col gap-1.5 min-w-[170px] flex-1">
      <label className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider">
        {label}
        {!isAll && (
          <span className="ml-1.5 text-primary normal-case">({selected.length})</span>
        )}
      </label>
      <Popover>
        <PopoverTrigger asChild>
          <Button
            variant="outline"
            className={`h-9 justify-between bg-card font-normal ${isAll ? "" : "border-primary/60 text-primary"}`}
          >
            <span className="truncate">{display}</span>
            <ChevronDown className="h-4 w-4 opacity-50 shrink-0" />
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-[280px] p-0" align="start">
          <div className="flex items-center justify-between px-3 py-2 border-b">
            <button onClick={() => onChange([])} className="text-xs font-medium text-primary hover:underline">
              Selecionar {ALL}
            </button>
            <span className="text-xs text-muted-foreground">
              {isAll ? ALL : `${selected.length} selecionado(s)`}
            </span>
          </div>
          {searchable && options.length > 8 && (
            <div className="flex items-center gap-2 px-3 py-2 border-b">
              <Search className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Buscar…"
                className="w-full bg-transparent text-sm outline-none placeholder:text-muted-foreground"
              />
            </div>
          )}
          <div className="max-h-[240px] overflow-y-auto py-1">
            {visible.length === 0 && (
              <p className="px-3 py-4 text-xs text-muted-foreground text-center">Nenhuma opção encontrada.</p>
            )}
            {visible.map((opt) => (
              <button
                key={opt}
                type="button"
                onClick={() => toggle(opt)}
                className="w-full flex items-center gap-2 px-3 py-1.5 hover:bg-muted cursor-pointer text-sm text-left"
              >
                <Checkbox checked={selected.includes(opt)} className="pointer-events-none" />
                <span className="truncate" title={opt}>{opt}</span>
              </button>
            ))}
          </div>
        </PopoverContent>
      </Popover>
    </div>
  );
}

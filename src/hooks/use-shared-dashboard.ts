import { useCallback, useEffect, useRef, useState } from "react";
import { createClient, type Session, type SupabaseClient } from "@supabase/supabase-js";
import { getDashboardState, publishSharedDashboard } from "@/lib/api/dashboard.functions";
import { publicationSchema, type ImportRecord, type Publication } from "@/lib/dashboard/shared";
import type { Row, Meta } from "@/lib/dashboard/domain";

export function useSharedDashboard(initial: Awaited<ReturnType<typeof getDashboardState>>) {
  const [client, setClient] = useState<SupabaseClient | null>(null);
  const [session, setSession] = useState<Session | null>(null);
  const [isAdmin, setIsAdmin] = useState(false);
  const [history, setHistory] = useState<ImportRecord[]>([]);
  const [dataset, setDataset] = useState<{
    faturamento: Row[];
    metas: Meta[];
    import: ImportRecord | null;
  } | null>(() => {
    if (!initial.ok) return null;
    const base = initial.snapshot ?? initial.embedded;
    return base
      ? {
          faturamento: base.faturamento,
          metas: base.metas,
          import: initial.snapshot?.import ?? null,
        }
      : null;
  });
  const [loading, setLoading] = useState(false);
  const [blocked, setBlocked] = useState(
    !initial.ok && ["forbidden", "unauthorized"].includes(initial.code),
  );
  const [message, setMessage] = useState(initial.message);
  const generation = useRef(0);
  const clientRef = useRef<SupabaseClient | null>(null);
  const tokenRef = useRef<string | undefined>(undefined);
  const versionRef = useRef<string | null>(null);

  const reload = useCallback(async () => {
    const current = ++generation.current;
    setLoading(true);
    try {
      const result = await getDashboardState({
        headers: tokenRef.current ? { Authorization: `Bearer ${tokenRef.current}` } : {},
      });
      if (current !== generation.current) return false;
      if (result.config && !clientRef.current) {
        const sdk = createClient(result.config.url, result.config.publishableKey);
        clientRef.current = sdk;
        setClient(sdk);
      }
      if (!result.ok) {
        setIsAdmin(false);
        setHistory([]);
        setMessage(result.message);
        setBlocked(result.code === "forbidden" || result.code === "unauthorized");
        return false;
      }
      setBlocked(false);
      setIsAdmin(result.isAdmin);
      setHistory(result.history);
      setMessage(result.message);
      const base = result.snapshot ?? result.embedded;
      versionRef.current = result.snapshot?.import.id ?? null;
      if (base)
        setDataset({
          faturamento: base.faturamento,
          metas: base.metas,
          import: result.snapshot?.import ?? null,
        });
      return true;
    } catch {
      if (current === generation.current)
        setMessage(
          "Não foi possível carregar a base compartilhada. Tente recarregar; a publicação anterior foi preservada.",
        );
      return false;
    } finally {
      if (current === generation.current) setLoading(false);
    }
  }, []);

  const invalidatePending = useCallback(() => {
    generation.current++;
  }, []);
  useEffect(() => {
    void reload();
    return invalidatePending;
  }, [reload, invalidatePending]);
  useEffect(() => {
    if (!client) return;
    const { data } = client.auth.onAuthStateChange((_event, next) => {
      setSession(next);
      tokenRef.current = next?.access_token;
      // Do not await Auth calls inside the SDK auth listener.
      queueMicrotask(() => {
        void reload();
      });
    });
    return () => data.subscription.unsubscribe();
  }, [client, reload]);

  const signIn = async (email: string, password: string) => {
    if (!client) throw new Error("Configure o Supabase antes de entrar.");
    const { error } = await client.auth.signInWithPassword({ email, password });
    if (error) throw new Error("Não foi possível entrar. Confira e-mail e senha.");
  };
  const signOut = async () => {
    if (!client) return;
    const { error } = await client.auth.signOut();
    if (error) throw new Error("Não foi possível encerrar a sessão. Tente novamente.");
    setIsAdmin(false);
    setHistory([]);
  };
  const publish = async (payload: Omit<Publication, "expectedVersion">) => {
    const value = publicationSchema.parse({ ...payload, expectedVersion: versionRef.current });
    const result = await publishSharedDashboard({
      data: value,
      headers: tokenRef.current ? { Authorization: `Bearer ${tokenRef.current}` } : {},
    });
    if (!result.ok) throw new Error(result.message);
    if (!(await reload()))
      throw new Error(
        "Publicação confirmada, mas a leitura falhou. Recarregue para consultar a base publicada; repetir a mesma importação não cria duplicatas.",
      );
  };
  return {
    session,
    isAdmin,
    history,
    dataset,
    loading,
    blocked,
    message,
    configured: Boolean(client),
    reload,
    signIn,
    signOut,
    publish,
  };
}
export type SharedDashboard = ReturnType<typeof useSharedDashboard>;

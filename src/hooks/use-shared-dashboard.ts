import { useCallback, useEffect, useRef, useState } from "react";
import { createClient, type Session, type SupabaseClient } from "@supabase/supabase-js";
import { authorizeDashboardManagement, getDashboardState } from "@/lib/api/dashboard.functions";
import {
  beginSharedUpload,
  appendSharedUpload,
  commitSharedUpload,
  readSharedPage,
} from "@/lib/api/dashboard-upload.functions";
import { assembleSnapshot, transferUpload } from "@/lib/dashboard/batches";
import { publicationSchema, type ImportRecord, type Publication } from "@/lib/dashboard/shared";
import type { Row, Meta } from "@/lib/dashboard/domain";

export function useSharedDashboard(initial: Awaited<ReturnType<typeof getDashboardState>>) {
  const [client, setClient] = useState<SupabaseClient | null>(null);
  const [session, setSession] = useState<Session | null>(null);
  const [isAdmin, setIsAdmin] = useState(initial.ok && initial.isAdmin);
  const [history, setHistory] = useState<ImportRecord[]>(initial.ok ? initial.history : []);
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
  const [loading, setLoading] = useState(initial.ok && Boolean(initial.manifest));
  const [blocked, setBlocked] = useState(
    !initial.ok && ["forbidden", "unauthorized"].includes(initial.code),
  );
  const [message, setMessage] = useState(initial.message);
  const generation = useRef(0);
  const clientRef = useRef<SupabaseClient | null>(null);
  const tokenRef = useRef<string | undefined>(undefined);
  const versionRef = useRef<string | null>(
    initial.ok ? (initial.snapshot?.import.id ?? null) : null,
  );

  const reload = useCallback(async (provided?: Awaited<ReturnType<typeof getDashboardState>>) => {
    const current = ++generation.current;
    setLoading(true);
    try {
      const result =
        provided ??
        (await getDashboardState({
          headers: tokenRef.current ? { Authorization: `Bearer ${tokenRef.current}` } : {},
        }));
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
      const snapshot = result.manifest
        ? await assembleSnapshot(
            result.manifest,
            async (data) => {
              const response = await readSharedPage({
                data,
                headers: tokenRef.current ? { Authorization: `Bearer ${tokenRef.current}` } : {},
              });
              if (!response.ok) throw new Error(response.message);
              return response.data;
            },
            () => current === generation.current,
          )
        : result.snapshot;
      if (current !== generation.current) return false;
      const base = snapshot ?? result.embedded;
      versionRef.current = snapshot?.import.id ?? null;
      if (base)
        setDataset({
          faturamento: base.faturamento,
          metas: base.metas,
          import: snapshot?.import ?? null,
        });
      return { version: snapshot?.import.id ?? null };
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
    // The route loader already supplied the snapshot. Hydration only needs
    // the Auth SDK; a restored session will trigger an authenticated read.
    if (initial.config && !clientRef.current) {
      const sdk = createClient(initial.config.url, initial.config.publishableKey);
      clientRef.current = sdk;
      setClient(sdk);
    }
    if (initial.ok && initial.manifest) void reload(initial);
    return invalidatePending;
  }, [initial, invalidatePending, reload]);
  useEffect(() => {
    if (!client) return;
    let active = true;
    const { data } = client.auth.onAuthStateChange((_event, next) => {
      if (!active) return;
      const nextToken = next?.access_token;
      const changed = tokenRef.current !== nextToken;
      setSession(next);
      tokenRef.current = nextToken;
      if (!changed) return;
      // Do not retain the previous actor's management permission during refresh.
      setIsAdmin(false);
      setHistory([]);
      // Do not await Auth calls inside the SDK auth listener.
      queueMicrotask(() => {
        if (active) void reload();
      });
    });
    return () => {
      active = false;
      data.subscription.unsubscribe();
    };
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
    const headers = (): Record<string, string> =>
      tokenRef.current ? { Authorization: `Bearer ${tokenRef.current}` } : {};
    const id = await transferUpload(value, {
      begin: async (data) => {
        const result = await beginSharedUpload({ data, headers: headers() });
        if (!result.ok) throw new Error(result.message);
        return result.data;
      },
      chunk: async (data) => {
        const result = await appendSharedUpload({ data, headers: headers() });
        if (!result.ok) throw new Error(result.message);
        return result.data;
      },
      commit: async (data) => {
        const result = await commitSharedUpload({ data, headers: headers() });
        if (!result.ok) throw new Error(result.message);
        return result.data;
      },
    });
    const refreshed = await reload();
    if (!refreshed)
      throw new Error(
        "Publicação confirmada, mas a leitura falhou. Recarregue para consultar a base publicada; repetir a mesma importação não cria duplicatas.",
      );
    if (refreshed.version !== id)
      throw new Error(
        "A importação já está registrada no histórico, mas outra base está ativa. Confira a última atualização. Se desejar publicar uma nova versão deste arquivo, selecione-o novamente.",
      );
  };
  const authorizeManagement = async () => {
    if (!tokenRef.current) throw new Error("Entre com uma conta administrativa.");
    const result = await authorizeDashboardManagement({
      headers: { Authorization: `Bearer ${tokenRef.current}` },
    });
    if (!result.ok) {
      setIsAdmin(false);
      setHistory([]);
      throw new Error(result.message);
    }
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
    authorizeManagement,
  };
}
export type SharedDashboard = ReturnType<typeof useSharedDashboard>;

import { useEffect, useMemo, useState } from "react";
import { fmtCompact, fmtPct } from "@/lib/dashboard/domain";

type GeoGeometry = { type: "Polygon" | "MultiPolygon"; coordinates: number[][][] | number[][][][] };
type GeoFeature = { properties?: { codarea?: string }; geometry: GeoGeometry };
type FeatureCollection = { features: GeoFeature[] };
type MapStatus = "loading" | "success" | "error";

const IBGE_GEOJSON = "https://servicodados.ibge.gov.br/api/v3/malhas/paises/BR?formato=application/vnd.geo%2Bjson&qualidade=minima&intrarregiao=UF";
export const UF_BY_IBGE: Record<string, string> = {
  "11": "RO", "12": "AC", "13": "AM", "14": "RR", "15": "PA", "16": "AP", "17": "TO",
  "21": "MA", "22": "PI", "23": "CE", "24": "RN", "25": "PB", "26": "PE", "27": "AL",
  "28": "SE", "29": "BA", "31": "MG", "32": "ES", "33": "RJ", "35": "SP", "41": "PR",
  "42": "SC", "43": "RS", "50": "MS", "51": "MT", "52": "GO", "53": "DF",
};
export const UF_NAME_BY_CODE: Record<string, string> = {
  "11": "Rondônia", "12": "Acre", "13": "Amazonas", "14": "Roraima", "15": "Pará", "16": "Amapá", "17": "Tocantins",
  "21": "Maranhão", "22": "Piauí", "23": "Ceará", "24": "Rio Grande do Norte", "25": "Paraíba", "26": "Pernambuco", "27": "Alagoas",
  "28": "Sergipe", "29": "Bahia", "31": "Minas Gerais", "32": "Espírito Santo", "33": "Rio de Janeiro", "35": "São Paulo",
  "41": "Paraná", "42": "Santa Catarina", "43": "Rio Grande do Sul", "50": "Mato Grosso do Sul", "51": "Mato Grosso",
  "52": "Goiás", "53": "Distrito Federal",
};
export const isBrazilUF = (uf: string) => Object.values(UF_BY_IBGE).includes(uf.trim().toUpperCase());

/** Identificadores observados na dimensão UF do Hospital, resolvidos pelo código IBGE oficial. */
const HOSPITAL_UF_SOURCE_TO_IBGE: Record<string, string> = {
  SOU: "13",
  AMAZONAS: "13",
  "BR-AM": "13",
  "13": "13",
};

export const normalizeHospitalUF = (raw: string) => {
  const value = raw.trim().toUpperCase();
  const ibgeCode = HOSPITAL_UF_SOURCE_TO_IBGE[value];
  return ibgeCode ? UF_BY_IBGE[ibgeCode] : value;
};

const FETCH_TIMEOUT_MS = 10_000;
let cachedFeatures: GeoFeature[] | null = null;

const validFeature = (feature: unknown): feature is GeoFeature => {
  if (!feature || typeof feature !== "object") return false;
  const candidate = feature as GeoFeature;
  const code = String(candidate.properties?.codarea ?? "").slice(0, 2);
  return Boolean(
    UF_BY_IBGE[code] &&
    candidate.geometry &&
    (candidate.geometry.type === "Polygon" || candidate.geometry.type === "MultiPolygon") &&
    Array.isArray(candidate.geometry.coordinates),
  );
};

const validatedFeatures = (payload: unknown) => {
  const collection = payload as Partial<FeatureCollection>;
  if (!Array.isArray(collection?.features)) throw new Error("GeoJSON do IBGE sem features");
  const features = collection.features.filter(validFeature);
  const ufs = new Set(features.map((feature) => UF_BY_IBGE[String(feature.properties?.codarea).slice(0, 2)]));
  if (ufs.size !== 27) throw new Error("GeoJSON do IBGE não contém as 27 UFs válidas");
  return features;
};

const rings = (geometry: GeoGeometry): number[][][] =>
  geometry.type === "Polygon"
    ? (geometry.coordinates as number[][][])
    : (geometry.coordinates as number[][][][]).flat();

const point = ([lon, lat]: number[]) => `${(lon + 74) * 12},${(6 - lat) * 12}`;
const pathFor = (geometry: GeoGeometry) =>
  rings(geometry).map((ring) => `M${ring.map(point).join("L")}Z`).join("");

export function BrazilHospitalMap({ data }: { data: Array<{ name: string; value: number }> }) {
  const [features, setFeatures] = useState<GeoFeature[]>(() => cachedFeatures ?? []);
  const [status, setStatus] = useState<MapStatus>(() => cachedFeatures ? "success" : "loading");
  const values = useMemo(() => new Map(data.map((item) => [item.name.trim().toUpperCase(), item.value])), [data]);
  const total = data.reduce((sum, item) => sum + item.value, 0);
  const max = Math.max(0, ...data.map((item) => item.value));

  useEffect(() => {
    if (cachedFeatures) {
      setFeatures(cachedFeatures);
      setStatus("success");
      return;
    }

    let active = true;
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    setStatus("loading");

    fetch(IBGE_GEOJSON, { signal: controller.signal })
      .then((response) => {
        if (!response.ok) throw new Error(`IBGE respondeu HTTP ${response.status}`);
        return response.json() as Promise<unknown>;
      })
      .then(validatedFeatures)
      .then((geoFeatures) => {
        cachedFeatures = geoFeatures;
        if (!active) return;
        setFeatures(geoFeatures);
        setStatus("success");
      })
      .catch(() => {
        if (active) setStatus("error");
      })
      .finally(() => window.clearTimeout(timeout));

    return () => {
      active = false;
      controller.abort();
      window.clearTimeout(timeout);
    };
  }, []);

  if (status === "loading") {
    return <div className="flex h-[360px] items-center justify-center text-sm text-muted-foreground">Carregando mapa do Brasil...</div>;
  }
  if (status === "error") {
    return <div className="flex h-[360px] items-center justify-center px-4 text-center text-sm text-muted-foreground">Não foi possível carregar o mapa neste momento.</div>;
  }

  return (
    <div className="min-w-0">
      {data.length === 0 && (
        <p className="mb-2 text-center text-sm text-muted-foreground">Não há dados de UF do Hospital para o recorte selecionado.</p>
      )}
      <svg viewBox="0 0 500 450" role="img" aria-label="Mapa do faturamento FY26 por UF do Hospital" className="h-auto max-h-[430px] w-full">
        {features.map((feature) => {
          const uf = UF_BY_IBGE[String(feature.properties?.codarea ?? "").slice(0, 2)];
          const value = values.get(uf) ?? 0;
          const intensity = max > 0 ? value / max : 0;
          const fill = value > 0 ? `hsl(173 70% ${88 - intensity * 54}%)` : "var(--muted)";
          return (
            <path key={uf} d={pathFor(feature.geometry)} fill={fill} stroke="var(--background)" strokeWidth="1.2" className="transition-opacity hover:opacity-80">
              <title>{`${uf}\nFaturamento FY26: ${fmtCompact(value)}\nParticipação: ${fmtPct(total > 0 ? value / total * 100 : 0)}`}</title>
            </path>
          );
        })}
      </svg>
    </div>
  );
}

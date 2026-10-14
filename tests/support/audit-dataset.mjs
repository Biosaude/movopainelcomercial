// Same published version for both actors, with every analytical dimension populated.
export const auditGroup = (g) => ({
  gr: g % 4 < 2 ? "GR A" : "GR B",
  rep: `REP-${g % 4}`,
  uf: g % 2 ? "PA" : "AP",
  ufHospital: g % 2 ? "PA" : "AP",
  ufCliente: g % 2 ? "CE" : "PB",
  marca: g % 2 ? "MARCA A" : "MARCA B",
  topico: g % 2 ? "01 - Tópico A" : "02 - Tópico B",
  tipo: g % 2 ? "Tipo A" : "Tipo B",
  cliente: `Cliente ${g % 4} ${"X".repeat(400)}`,
  medico: `Médico ${g % 4}`,
  hospital: `Hospital ${g % 4}`,
  assessor: `Assessor ${g % 4}`,
  periodo: `${g % 2 ? "Q1" : "Q3"} ${g < 4 ? 2025 : 2026}`,
  mes: g % 2 ? "02" : "08",
});
export const auditDataset = () => ({
  faturamento: Array.from({ length: 13759 }, (_, i) => ({
    ...auditGroup(i % 8),
    valor: 10000 + i / 100,
  })),
  metas: Array.from({ length: 633 }, (_, i) => {
    const g = auditGroup(4 + (i % 4));
    return {
      gr: g.gr,
      rep: g.rep,
      uf: g.uf,
      marca: g.marca,
      topico: g.topico,
      tipo: g.tipo,
      periodo: g.periodo,
      meta: 1000 + i,
      metaFinanceira: 900 + i,
    };
  }),
});

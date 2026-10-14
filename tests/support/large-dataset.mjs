// Fictional records only. The default counts reproduce the reported import.
export function largeDataset(revenueCount = 13759, targetCount = 633) {
  return {
    faturamento: Array.from({ length: revenueCount }, (_, index) => ({
      gr: "TEST",
      rep: `REP-${index}`,
      uf: index % 2 ? "PA" : "AP",
      marca: "MARCA",
      topico: "TEST",
      tipo: "TEST",
      periodo: "Q3 2026",
      valor: index / 100,
      ufHospital: index % 2 ? "PA" : "AP",
      ufCliente: "CE",
      cliente: `Cliente fictício ${index} 😀 O'Connor "teste" ${"X".repeat(400)}`,
      hospital: `Hospital fictício ${index}`,
      medico: `Médico fictício ${index}`,
      assessor: `Assessor fictício ${index}`,
      data: "24/08/2026",
      mes: "08",
    })),
    metas: Array.from({ length: targetCount }, (_, index) => ({
      gr: "TEST",
      rep: `META-${index}`,
      uf: index % 2 ? "PA" : "AP",
      marca: "MARCA",
      topico: "TEST",
      tipo: "TEST",
      periodo: "Q3 2026",
      meta: 1000 + index,
      metaFinanceira: 900 + index,
    })),
  };
}

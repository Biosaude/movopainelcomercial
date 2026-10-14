import { expect, test } from "bun:test";
import { fmtCompact, fmtBRLFull } from "../src/lib/dashboard/domain";

test("monetary KPI abbreviations stay compact and preserve full-value precision", () => {
  for (const [value, expected] of [
    [77_500_000, "R$ 77,5 mi"],
    [82_900_000, "R$ 82,9 mi"],
    [117_400_000, "R$ 117,4 mi"],
    [105_700_000, "R$ 105,7 mi"],
    [-77_500_000, "R$ -77,5 mi"],
    [77_549_999.99, "R$ 77,5 mi"],
  ] as const)
    expect(fmtCompact(value)).toBe(expected);
  expect(fmtBRLFull(77_549_999.99).replaceAll("\u00a0", " ")).toBe("R$ 77.549.999,99");
  expect(fmtCompact(999)).toBe(fmtBRLFull(999).replace(",00", ""));
  expect(fmtCompact(1_000)).toBe("R$ 1 mil");
});

import { afterEach, describe, expect, it, vi } from "vitest";

import { formatQuotaCommand } from "../src/lib/quota-command-format.js";
import type { QuotaRenderData } from "../src/lib/quota-render-data.js";
import { formatQuotaRowsGrouped } from "../src/lib/toast-format-grouped.js";
import { buildCompactQuotaStatusLine } from "../src/lib/tui-compact-format.js";
import { buildSidebarQuotaPanelLines } from "../src/lib/tui-sidebar-format.js";

const quotaAccounting = {
  resultType: "quota" as const,
  acquisitionMethod: "remote_api" as const,
  ownership: "maintained" as const,
  authority: "locally_derived" as const,
};
const balanceAccounting = {
  resultType: "balance" as const,
  acquisitionMethod: "remote_api" as const,
  ownership: "maintained" as const,
  authority: "provider_reported" as const,
};
const resetTimeIso = "2099-02-01T00:00:00.000Z";

afterEach(() => {
  vi.useRealTimers();
});

function renderFourSurfaces(data: QuotaRenderData): string[] {
  return [
    formatQuotaCommand({ ...data, generatedAtMs: 0 }),
    formatQuotaRowsGrouped(data),
    buildSidebarQuotaPanelLines({
      data,
      config: { formatStyle: "allWindows", percentDisplayMode: "remaining" },
    }).join("\n"),
    buildCompactQuotaStatusLine({
      data,
      percentDisplayMode: "remaining",
      maxWidth: 240,
    }),
  ];
}

describe("Kilo Gateway four-surface formatting", () => {
  it("shows Credits, percent, and amount left without used, base, or bonus amounts", () => {
    const data: QuotaRenderData = {
      entries: [
        {
          accounting: quotaAccounting,
          name: "Kilo Gateway Credits",
          group: "Kilo Gateway",
          label: "Credits:",
          metricLabel: "Credits",
          right: "$12.50 left",
          percentRemaining: 83.33333333333334,
          resetTimeIso,
        },
        {
          kind: "value",
          accounting: quotaAccounting,
          name: "Kilo Gateway Remaining Credits",
          group: "Kilo Gateway",
          label: "Left:",
          metricLabel: "Left",
          value: "$12.50",
        },
      ],
      errors: [],
    };

    const outputs = renderFourSurfaces(data);
    for (const output of outputs) {
      expect(output).toContain("Kilo Gateway");
      expect(output).toContain("Credits");
      expect(output).toContain("83%");
      expect(output).toContain("$12.50");
      expect(output).not.toContain("$2.50");
      expect(output).not.toContain("$10.00");
      expect(output).not.toContain("$5.00");
      expect(output.toLowerCase()).not.toContain("used");
      expect(output.toLowerCase()).not.toContain("bonus");
      expect(output.toLowerCase()).not.toContain("base");
    }

    for (const groupedOutput of outputs.slice(1, 3)) {
      const leftLine = groupedOutput.split("\n").find((line) => line.startsWith("Left:"));
      expect(leftLine?.trim().replace(/\s+/gu, " ")).toBe("Left: $12.50");
    }
  });

  it("shows only the Left value when total Kilo Pass credits are zero", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2099-01-01T00:00:00.000Z"));

    const data: QuotaRenderData = {
      entries: [
        {
          kind: "value",
          accounting: quotaAccounting,
          name: "Kilo Gateway Remaining Credits",
          group: "Kilo Gateway",
          label: "Left:",
          metricLabel: "Left",
          value: "$0.00",
          resetTimeIso,
        },
      ],
      errors: [],
    };

    const outputs = renderFourSurfaces(data);
    for (const output of outputs) {
      expect(output).toContain("Kilo Gateway");
      expect(output).toContain("$0.00");
      expect(output).not.toContain("%");
    }
    // Chinese fork adaptation: the countdown renders in Chinese units
    // ("31天"/"31天后重置") instead of the upstream English "31d".
    for (const output of outputs.slice(0, 3)) {
      expect(output).toMatch(/\d+天/u);
    }
  });

  it("hides overage details on every human surface", () => {
    const data: QuotaRenderData = {
      entries: [
        {
          accounting: quotaAccounting,
          name: "Kilo Gateway Credits",
          group: "Kilo Gateway",
          label: "Credits:",
          metricLabel: "Credits",
          right: "$0.00 left",
          percentRemaining: 0,
        },
        {
          kind: "value",
          accounting: quotaAccounting,
          name: "Kilo Gateway Remaining Credits",
          group: "Kilo Gateway",
          label: "Left:",
          metricLabel: "Left",
          value: "$0.00",
        },
      ],
      errors: [],
    };

    for (const output of renderFourSurfaces(data)) {
      expect(output).toContain("0%");
      expect(output).toContain("$0.00");
      expect(output).not.toContain("$2.00");
      expect(output.toLowerCase()).not.toContain("overage");
      expect(output.toLowerCase()).not.toContain("used");
      expect(output.toLowerCase()).not.toContain("bonus");
      expect(output.toLowerCase()).not.toContain("base");
    }
  });

  it("keeps Gateway fallback balance-only on every human surface", () => {
    const data: QuotaRenderData = {
      entries: [
        {
          kind: "value",
          accounting: balanceAccounting,
          name: "Kilo Gateway Balance",
          group: "Kilo Gateway",
          label: "Balance:",
          value: "$8.25",
        },
      ],
      errors: [],
    };

    for (const output of renderFourSurfaces(data)) {
      expect(output).toContain("Kilo Gateway");
      expect(output).toContain("$8.25");
      expect(output).not.toContain("%");
      expect(output.toLowerCase()).not.toContain("left");
      expect(output.toLowerCase()).not.toContain("used");
      expect(output.toLowerCase()).not.toContain("reset");
    }
  });
});

export const TUI_PROVIDER_AVAILABILITY_WARMUPS = 3;
export const TUI_PROVIDER_AVAILABILITY_SAMPLES = 30;
export const TUI_PROVIDER_AVAILABILITY_HORIZON_MS = 10_000;
export const TUI_PROVIDER_AVAILABILITY_JITTER_OFFSETS_MS = [0, 3, 7, 1, 5] as const;

export type ProviderAvailabilityMetricAggregate = {
  min: number | null;
  median: number | null;
  p95: number | null;
  max: number | null;
  censored: number;
};

export type ProviderAvailabilityTimingSample = {
  scenario: string;
  controlledDelayMs: number;
  readyCompactMs: number | null;
  homeCompletionMs: number | null;
  callsByProvider: Record<string, number>;
  totalAvailabilityCalls: number;
  fetchesByProvider: Record<string, number>;
  totalFetches: number;
  outputSignature: string | null;
  censored: boolean;
};

export type ProviderAvailabilityTimingResult = {
  scenario: string;
  delayDescription: string;
  samples: ProviderAvailabilityTimingSample[];
  readyCompact: ProviderAvailabilityMetricAggregate;
  homeCompletion: ProviderAvailabilityMetricAggregate;
  distinctCallCountVectors: string[];
  distinctFetchCountVectors: string[];
  distinctOutputSignatures: string[];
};

export function getProviderAvailabilityJitterOffsetMs(sampleIndex: number): number {
  if (sampleIndex < 0) return 0;
  return (
    TUI_PROVIDER_AVAILABILITY_JITTER_OFFSETS_MS[
      sampleIndex % TUI_PROVIDER_AVAILABILITY_JITTER_OFFSETS_MS.length
    ] ?? 0
  );
}

function aggregate(values: Array<number | null>): ProviderAvailabilityMetricAggregate {
  const recorded = values
    .filter((value): value is number => value !== null)
    .sort((left, right) => left - right);

  if (recorded.length === 0) {
    return {
      min: null,
      median: null,
      p95: null,
      max: null,
      censored: values.length,
    };
  }

  const valueAt = (index: number): number => {
    const value = recorded[index];
    if (value === undefined) throw new Error(`Missing aggregate value at index ${index}`);
    return value;
  };
  const medianIndex = Math.floor(recorded.length / 2);

  return {
    min: valueAt(0),
    median:
      recorded.length % 2 === 0
        ? (valueAt(medianIndex - 1) + valueAt(medianIndex)) / 2
        : valueAt(medianIndex),
    p95: valueAt(Math.ceil(recorded.length * 0.95) - 1),
    max: valueAt(recorded.length - 1),
    censored: values.length - recorded.length,
  };
}

function countVector(
  counts: Record<string, number>,
  orderedProviderIds: readonly string[],
  total: number,
): string {
  return [
    ...orderedProviderIds.map((providerId) => `${providerId}=${counts[providerId] ?? 0}`),
    `total=${total}`,
  ].join(",");
}

export async function runProviderAvailabilityTimingSamples(params: {
  scenario: string;
  delayDescription: string;
  orderedProviderIds: readonly string[];
  runSample: (sampleIndex: number) => Promise<ProviderAvailabilityTimingSample>;
}): Promise<ProviderAvailabilityTimingResult> {
  for (let index = 0; index < TUI_PROVIDER_AVAILABILITY_WARMUPS; index += 1) {
    await params.runSample(-(index + 1));
  }

  const samples: ProviderAvailabilityTimingSample[] = [];
  for (let index = 0; index < TUI_PROVIDER_AVAILABILITY_SAMPLES; index += 1) {
    samples.push(await params.runSample(index));
  }

  return {
    scenario: params.scenario,
    delayDescription: params.delayDescription,
    samples,
    readyCompact: aggregate(samples.map((sample) => sample.readyCompactMs)),
    homeCompletion: aggregate(samples.map((sample) => sample.homeCompletionMs)),
    distinctCallCountVectors: [
      ...new Set(
        samples.map((sample) =>
          countVector(
            sample.callsByProvider,
            params.orderedProviderIds,
            sample.totalAvailabilityCalls,
          ),
        ),
      ),
    ],
    distinctFetchCountVectors: [
      ...new Set(
        samples.map((sample) =>
          countVector(sample.fetchesByProvider, params.orderedProviderIds, sample.totalFetches),
        ),
      ),
    ],
    distinctOutputSignatures: [
      ...new Set(
        samples
          .map((sample) => sample.outputSignature)
          .filter((value): value is string => value !== null),
      ),
    ],
  };
}

function formatMetric(value: number | null): string {
  return value === null ? "N/A" : String(value);
}

function formatRange(metric: ProviderAvailabilityMetricAggregate): string {
  if (metric.min === null || metric.max === null) return "N/A";
  return String(metric.max - metric.min);
}

export function formatProviderAvailabilityTimingReport(
  results: readonly ProviderAvailabilityTimingResult[],
): string {
  const lines = [
    "TUI home provider availability measurement (virtual ms)",
    `Warmups: ${TUI_PROVIDER_AVAILABILITY_WARMUPS}; recorded: ${TUI_PROVIDER_AVAILABILITY_SAMPLES}; horizon: ${TUI_PROVIDER_AVAILABILITY_HORIZON_MS} ms; no discarded samples`,
    `Deterministic jitter offsets: ${TUI_PROVIDER_AVAILABILITY_JITTER_OFFSETS_MS.join(",")}`,
    "| Scenario | Delay | Metric | Min | Median | p95 | Max | Censored | Range | Availability calls | Fetches |",
    "|---|---|---|---:|---:|---:|---:|---:|---:|---|---|",
  ];

  for (const result of results) {
    const metric =
      result.readyCompact.censored < result.samples.length
        ? result.readyCompact
        : result.homeCompletion;
    const metricLabel =
      result.readyCompact.censored < result.samples.length ? "ready compact" : "home completion";
    lines.push(
      `| ${result.scenario} | ${result.delayDescription} | ${metricLabel} | ${formatMetric(metric.min)} | ${formatMetric(metric.median)} | ${formatMetric(metric.p95)} | ${formatMetric(metric.max)} | ${metric.censored} | ${formatRange(metric)} | ${result.distinctCallCountVectors.join(" || ")} | ${result.distinctFetchCountVectors.join(" || ")} |`,
    );
    lines.push(
      `Output signatures (${result.scenario}): ${result.distinctOutputSignatures.join(" || ")}`,
    );
  }

  return lines.join("\n");
}

export const TUI_RUNTIME_RESOLUTION_WARMUPS = 3;
export const TUI_RUNTIME_RESOLUTION_SAMPLES = 30;
export const TUI_RUNTIME_RESOLUTION_HORIZON_MS = 10_000;

export type StartupRuntimePhase =
  | "registration"
  | "initial-session"
  | "initial-home"
  | "home-export"
  | "recovery-session"
  | "event-session"
  | "event-home"
  | "interval-session"
  | "interval-home"
  | "refresh-session"
  | "refresh-home";

export type StartupTraceEvent = {
  sequence: number;
  phase: StartupRuntimePhase;
  operation: "runtime-context" | "config-load";
  edge: "start" | "complete";
  atMs: number;
  configGeneration?: number;
};

export type StartupMilestones = {
  sidebarMs: number | null;
  compactMs: number | null;
  homeMs: number | null;
  firstContentMs: number | null;
  allInitialContentMs: number | null;
};

export type StartupRuntimeSample = {
  controlledDelayMs: number;
  milestones: StartupMilestones;
  trace: StartupTraceEvent[];
  sessionLoaderInvocations: number;
  homeLoaderInvocations: number;
  rendered: {
    sidebar: boolean;
    compact: boolean;
    home: boolean;
  };
};

export type MetricAggregate = {
  min: number | null;
  median: number | null;
  p95: number | null;
  max: number | null;
  censored: number;
};

type InitialCallCounts = {
  runtimeStarts: number;
  runtimeCompletions: number;
  configStarts: number;
  configCompletions: number;
};

export type StartupRuntimeResult = {
  controlledDelayMs: number;
  samples: StartupRuntimeSample[];
  milestones: Record<keyof StartupMilestones, MetricAggregate>;
  countsAtMilestones: Record<keyof StartupMilestones, InitialCallCounts[]>;
  distinctCountVectors: string[];
  sessionLoaderInvocations: MetricAggregate;
  homeLoaderInvocations: MetricAggregate;
};

const INITIAL_PHASES = new Set<StartupRuntimePhase>([
  "registration",
  "initial-session",
  "initial-home",
]);

function aggregate(values: Array<number | null>): MetricAggregate {
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

function countInitialCallsAt(sample: StartupRuntimeSample, atMs: number | null): InitialCallCounts {
  if (atMs === null) {
    return { runtimeStarts: 0, runtimeCompletions: 0, configStarts: 0, configCompletions: 0 };
  }

  const events = sample.trace.filter(
    (event) => INITIAL_PHASES.has(event.phase) && event.atMs <= atMs,
  );
  return {
    runtimeStarts: events.filter(
      (event) => event.operation === "runtime-context" && event.edge === "start",
    ).length,
    runtimeCompletions: events.filter(
      (event) => event.operation === "runtime-context" && event.edge === "complete",
    ).length,
    configStarts: events.filter(
      (event) => event.operation === "config-load" && event.edge === "start",
    ).length,
    configCompletions: events.filter(
      (event) => event.operation === "config-load" && event.edge === "complete",
    ).length,
  };
}

function countVector(sample: StartupRuntimeSample): string {
  const parts = (Object.keys(sample.milestones) as Array<keyof StartupMilestones>).map((key) => {
    const counts = countInitialCallsAt(sample, sample.milestones[key]);
    return `${key}:${counts.runtimeStarts}/${counts.runtimeCompletions}/${counts.configStarts}/${counts.configCompletions}`;
  });
  parts.push(`loaders:${sample.sessionLoaderInvocations}/${sample.homeLoaderInvocations}`);
  return parts.join(";");
}

export async function runStartupRuntimeSamples(
  controlledDelayMs: number,
  runSample: (controlledDelayMs: number, sampleIndex: number) => Promise<StartupRuntimeSample>,
): Promise<StartupRuntimeResult> {
  for (let index = 0; index < TUI_RUNTIME_RESOLUTION_WARMUPS; index += 1) {
    await runSample(controlledDelayMs, -(index + 1));
  }

  const samples: StartupRuntimeSample[] = [];
  for (let index = 0; index < TUI_RUNTIME_RESOLUTION_SAMPLES; index += 1) {
    samples.push(await runSample(controlledDelayMs, index));
  }

  const milestoneKeys = Object.keys(samples[0]?.milestones ?? {}) as Array<keyof StartupMilestones>;
  const milestones = Object.fromEntries(
    milestoneKeys.map((key) => [key, aggregate(samples.map((sample) => sample.milestones[key]))]),
  ) as Record<keyof StartupMilestones, MetricAggregate>;
  const countsAtMilestones = Object.fromEntries(
    milestoneKeys.map((key) => [
      key,
      samples.map((sample) => countInitialCallsAt(sample, sample.milestones[key])),
    ]),
  ) as Record<keyof StartupMilestones, InitialCallCounts[]>;

  return {
    controlledDelayMs,
    samples,
    milestones,
    countsAtMilestones,
    distinctCountVectors: [...new Set(samples.map(countVector))],
    sessionLoaderInvocations: aggregate(samples.map((sample) => sample.sessionLoaderInvocations)),
    homeLoaderInvocations: aggregate(samples.map((sample) => sample.homeLoaderInvocations)),
  };
}

function formatMetric(value: number | null): string {
  return value === null ? "CENSORED" : String(value);
}

function formatCountRange(counts: InitialCallCounts[]): string {
  const vectors = [
    ...new Set(
      counts.map(
        (count) =>
          `${count.runtimeStarts}/${count.runtimeCompletions} runtime, ${count.configStarts}/${count.configCompletions} config`,
      ),
    ),
  ];
  return vectors.join(" | ");
}

function formatTrace(trace: StartupTraceEvent[]): string {
  return trace
    .map(
      (event) =>
        `${event.atMs}:${event.phase}:${event.operation}:${event.edge}${
          event.configGeneration === undefined ? "" : `:g${event.configGeneration}`
        }`,
    )
    .join(" -> ");
}

export function formatStartupRuntimeReport(results: StartupRuntimeResult[]): string {
  const lines = [
    "TUI startup runtime/config resolution measurement (virtual ms)",
    `Warmups: ${TUI_RUNTIME_RESOLUTION_WARMUPS}; recorded: ${TUI_RUNTIME_RESOLUTION_SAMPLES}; horizon: ${TUI_RUNTIME_RESOLUTION_HORIZON_MS} ms; no discarded samples`,
    "Counts are start/complete. Home export is traced but excluded from startup counts.",
    "| Delay | Milestone | Min | Median | p95 | Max | Censored | Runtime/config counts at milestone |",
    "|---:|---|---:|---:|---:|---:|---:|---|",
  ];

  for (const result of results) {
    for (const [key, label] of [
      ["sidebarMs", "sidebar"],
      ["compactMs", "compact"],
      ["homeMs", "home"],
      ["firstContentMs", "first content"],
      ["allInitialContentMs", "all initial"],
    ] as const) {
      const metric = result.milestones[key];
      lines.push(
        `| ${result.controlledDelayMs} | ${label} | ${formatMetric(metric.min)} | ${formatMetric(metric.median)} | ${formatMetric(metric.p95)} | ${formatMetric(metric.max)} | ${metric.censored} | ${formatCountRange(result.countsAtMilestones[key])} |`,
      );
    }

    lines.push(
      `| ${result.controlledDelayMs} | loader calls | ${formatMetric(result.sessionLoaderInvocations.min)}/${formatMetric(result.homeLoaderInvocations.min)} | ${formatMetric(result.sessionLoaderInvocations.median)}/${formatMetric(result.homeLoaderInvocations.median)} | ${formatMetric(result.sessionLoaderInvocations.p95)}/${formatMetric(result.homeLoaderInvocations.p95)} | ${formatMetric(result.sessionLoaderInvocations.max)}/${formatMetric(result.homeLoaderInvocations.max)} | ${result.sessionLoaderInvocations.censored + result.homeLoaderInvocations.censored} | session/home |`,
    );
    lines.push(
      `Count vectors: ${result.distinctCountVectors.length} distinct (${result.distinctCountVectors.join(" || ")})`,
    );
    const sample = result.samples[0];
    if (sample)
      lines.push(
        `Ordering (${result.controlledDelayMs} ms sample 0): ${formatTrace(sample.trace)}`,
      );
    const allCounts = result.countsAtMilestones.allInitialContentMs[0];
    if (allCounts) {
      lines.push(
        `Aggregate controlled config delay before all initial content: ${allCounts.configStarts * result.controlledDelayMs} ms; critical path median: ${formatMetric(result.milestones.allInitialContentMs.median)} ms`,
      );
    }
  }

  return lines.join("\n");
}

/**
 * What the server does with each new quota snapshot besides telling the TUIs: publish the
 * OpenTelemetry gauges and write the export file, each only when its setting is on. Neither
 * asks a provider again. While one publication runs, only the newest snapshot waits.
 */
import { buildQuotaExportFromSnapshot, resolveExportPath, writeQuotaExport, } from "../lib/quota-export.js";
import { configureQuotaTelemetry, disposeQuotaTelemetryOwner, publishQuotaTelemetry, } from "../lib/quota-telemetry.js";
export function createSnapshotPublisher(params) {
    // The telemetry owner: its gauges replace each other and go away with it.
    const owner = {};
    let next;
    let running;
    let disposed = false;
    async function publishNow(snapshot) {
        const settings = await params.loadSettings();
        if (disposed)
            return;
        const token = configureQuotaTelemetry({
            owner,
            enabled: settings.telemetry,
            identity: "quota-snapshot-v6",
        });
        publishQuotaTelemetry(token, snapshot);
        if (settings.export.enabled) {
            const path = resolveExportPath(settings.export.path);
            await writeQuotaExport(buildQuotaExportFromSnapshot(snapshot), path);
        }
    }
    async function drain() {
        while (next) {
            const snapshot = next;
            next = undefined;
            try {
                await publishNow(snapshot);
            }
            catch (error) {
                params.log("could not publish the quota snapshot", error);
            }
        }
        running = undefined;
    }
    return {
        publish(snapshot) {
            if (disposed)
                return;
            next = snapshot;
            running ??= drain();
        },
        idle: () => running ?? Promise.resolve(),
        dispose() {
            disposed = true;
            next = undefined;
            disposeQuotaTelemetryOwner(owner);
        },
    };
}

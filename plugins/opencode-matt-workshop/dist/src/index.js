import { applyWorkshopConfig } from "./config.js";
import { parseWorkshopOptions } from "./options.js";
import { OrchestrationManager } from "./orchestration/manager.js";
import { buildWorkshopTools } from "./tools.js";
const workshopPlugin = async function workshopPlugin(input, rawOptions) {
    const options = parseWorkshopOptions(rawOptions);
    const manager = new OrchestrationManager(input.client, { maxParallelMakers: options.max_parallel_makers, maxParallelSupport: options.max_parallel_support, supportRoleLimits: { inspector: options.max_parallel_inspectors, archivist: options.max_parallel_archivists, surveyor: options.max_parallel_surveyors }, permissionTemplateVersion: options.permission_template_version });
    return {
        config: async (config) => applyWorkshopConfig(config, options),
        tool: buildWorkshopTools(input, manager),
        event: async ({ event }) => manager.handleEvent(event),
    };
};
export default workshopPlugin;

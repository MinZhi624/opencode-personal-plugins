import { applyWorkshopConfig } from "./config.js";
import { parseWorkshopOptions } from "./options.js";
export default async function workshopPlugin(_input, rawOptions) {
    const options = parseWorkshopOptions(rawOptions);
    return { config: async (config) => applyWorkshopConfig(config, options) };
}

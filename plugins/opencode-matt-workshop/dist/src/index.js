import { applyWorkshopConfig } from "./config.js";
import { parseWorkshopOptions } from "./options.js";
const workshopPlugin = async (_input, rawOptions) => {
    const options = parseWorkshopOptions(rawOptions);
    return {
        config: async (config) => {
            applyWorkshopConfig(config, options);
        },
    };
};
export default workshopPlugin;
//# sourceMappingURL=index.js.map
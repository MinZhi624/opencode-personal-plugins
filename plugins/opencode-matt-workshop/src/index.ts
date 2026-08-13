import type { Plugin } from "@opencode-ai/plugin"
import { applyWorkshopConfig } from "./config.js"
import { parseWorkshopOptions } from "./options.js"

const opencodeMattWorkshop: Plugin = async (_input, rawOptions) => {
  const options = parseWorkshopOptions(rawOptions)
  return {
    config: async (config) => applyWorkshopConfig(config, options),
  }
}

export default opencodeMattWorkshop

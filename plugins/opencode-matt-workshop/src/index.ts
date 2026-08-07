import { applyWorkshopConfig } from "./config.js"
import { parseWorkshopOptions } from "./options.js"
export default async function workshopPlugin(_input: unknown, rawOptions: unknown) {
  const options = parseWorkshopOptions(rawOptions)
  return { config: async (config: unknown) => applyWorkshopConfig(config, options) }
}

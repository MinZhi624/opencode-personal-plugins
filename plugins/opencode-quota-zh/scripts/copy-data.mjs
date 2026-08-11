import { mkdir, copyFile } from "fs/promises";
import { join, dirname } from "path";

const files = [
  {
    src: join("src", "data", "modelsdev-pricing.min.json"),
    dst: join("dist", "data", "modelsdev-pricing.min.json"),
  },
];

for (const f of files) {
  await mkdir(dirname(f.dst), { recursive: true });
  await copyFile(f.src, f.dst);
}

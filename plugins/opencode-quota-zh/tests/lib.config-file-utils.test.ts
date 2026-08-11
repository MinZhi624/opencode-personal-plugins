import { afterEach, describe, expect, it } from "vitest";
import { join } from "node:path";

import {
  getEffectiveConfigRoot,
  resolveRuntimeContextRoots,
} from "../src/lib/config-file-utils.js";

describe("getEffectiveConfigRoot", () => {
  const original = process.env.OPENCODE_CONFIG_DIR;

  afterEach(() => {
    if (original === undefined) {
      delete process.env.OPENCODE_CONFIG_DIR;
    } else {
      process.env.OPENCODE_CONFIG_DIR = original;
    }
  });

  it("returns fallback when OPENCODE_CONFIG_DIR is not set", () => {
    delete process.env.OPENCODE_CONFIG_DIR;
    expect(getEffectiveConfigRoot("/home/user/project")).toBe("/home/user/project");
  });

  it("returns OPENCODE_CONFIG_DIR when set", () => {
    process.env.OPENCODE_CONFIG_DIR = "/custom/config";
    expect(getEffectiveConfigRoot("/home/user/project")).toBe("/custom/config");
  });

  it("resolves relative OPENCODE_CONFIG_DIR from fallback", () => {
    process.env.OPENCODE_CONFIG_DIR = ".opencode";
    expect(getEffectiveConfigRoot("/home/user/project")).toBe(
      join("/home/user/project", ".opencode"),
    );
  });

  it("ignores whitespace-only OPENCODE_CONFIG_DIR", () => {
    process.env.OPENCODE_CONFIG_DIR = "   ";
    expect(getEffectiveConfigRoot("/home/user/project")).toBe("/home/user/project");
  });
});

describe("resolveRuntimeContextRoots", () => {
  const original = process.env.OPENCODE_CONFIG_DIR;

  afterEach(() => {
    if (original === undefined) {
      delete process.env.OPENCODE_CONFIG_DIR;
    } else {
      process.env.OPENCODE_CONFIG_DIR = original;
    }
  });

  it("uses OPENCODE_CONFIG_DIR only when explicit configRoot is absent", () => {
    process.env.OPENCODE_CONFIG_DIR = ".opencode";
    expect(
      resolveRuntimeContextRoots({
        workspaceRoot: "/work/repo",
        fallbackDirectory: "/work/repo/packages/app",
      }),
    ).toEqual({
      workspaceRoot: "/work/repo",
      configRoot: "/work/repo/.opencode",
    });
  });

  it("uses explicit configRoot as-is without re-applying OPENCODE_CONFIG_DIR", () => {
    process.env.OPENCODE_CONFIG_DIR = ".opencode";
    expect(
      resolveRuntimeContextRoots({
        workspaceRoot: "/work/repo",
        configRoot: "/work/repo/.explicit",
        fallbackDirectory: "/work/repo/packages/app",
      }),
    ).toEqual({
      workspaceRoot: "/work/repo",
      configRoot: "/work/repo/.explicit",
    });
  });
});

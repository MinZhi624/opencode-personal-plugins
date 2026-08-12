import { execFile } from "node:child_process";
import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
const exec = promisify(execFile);
const git = async (cwd, args) => (await exec("git", args, { cwd, maxBuffer: 4 * 1024 * 1024 })).stdout.trim();
const safeId = (value) => value.replace(/[^a-zA-Z0-9._-]/g, "-").slice(0, 80);
export class GitWorkspace {
    integrations = new Map();
    async integration(parentSessionId, directory) {
        const existing = this.integrations.get(parentSessionId);
        if (existing)
            return existing;
        const root = await git(directory, ["rev-parse", "--show-toplevel"]);
        if (await git(root, ["status", "--porcelain"]))
            throw new Error("Workshop implementation requires a clean Git worktree");
        const baseline = await git(root, ["rev-parse", "HEAD"]);
        const originalBranch = await git(root, ["rev-parse", "--abbrev-ref", "HEAD"]);
        const branch = `workshop/integration-${safeId(parentSessionId)}`;
        const target = join(tmpdir(), "opencode", "workshop", safeId(parentSessionId), "integration");
        await mkdir(resolve(target, ".."), { recursive: true });
        await git(root, ["worktree", "add", "-b", branch, target, baseline]);
        const value = { root, originalBranch, baseline, branch, directory: target };
        this.integrations.set(parentSessionId, value);
        return value;
    }
    async createSlice(parentSessionId, sliceId, directory, checkpoint) {
        const integration = await this.integration(parentSessionId, directory);
        const actual = await git(integration.directory, ["rev-parse", "HEAD"]);
        if (actual !== checkpoint)
            throw new Error(`Stale integration checkpoint: expected ${actual}`);
        const branch = `workshop/slice-${safeId(parentSessionId)}-${safeId(sliceId)}`;
        const target = join(tmpdir(), "opencode", "workshop", safeId(parentSessionId), "slices", safeId(sliceId));
        await mkdir(resolve(target, ".."), { recursive: true });
        await git(integration.root, ["worktree", "add", "-b", branch, target, checkpoint]);
        return { integration, branch, directory: target };
    }
    async changedPaths(directory) {
        const changed = await git(directory, ["diff", "--name-only", "HEAD"]);
        const untracked = await git(directory, ["ls-files", "--others", "--exclude-standard"]);
        return [...new Set([...changed.split("\n"), ...untracked.split("\n")].filter(Boolean))];
    }
    async addedPaths(directory) {
        const added = await git(directory, ["diff", "--name-only", "--diff-filter=A", "HEAD"]);
        const untracked = await git(directory, ["ls-files", "--others", "--exclude-standard"]);
        return [...new Set([...added.split("\n"), ...untracked.split("\n")].filter(Boolean))];
    }
    async accept(directory, integration, sliceId, ticketRef) {
        await git(directory, ["add", "-A"]);
        if (!await git(directory, ["diff", "--cached", "--name-only"]))
            throw new Error("Cannot accept a Slice with no changes");
        await git(directory, ["commit", "-m", `feat(workshop): accept ${sliceId}${ticketRef ? ` (${ticketRef})` : ""}`]);
        const commit = await git(directory, ["rev-parse", "HEAD"]);
        await git(integration.directory, ["cherry-pick", commit]);
        return { commit, integrationCheckpoint: await git(integration.directory, ["rev-parse", "HEAD"]) };
    }
    async summary(parentSessionId) {
        const integration = this.integrations.get(parentSessionId);
        if (!integration)
            throw new Error("No Integration Branch for this Foreman session");
        const originalTip = await git(integration.root, ["rev-parse", integration.originalBranch]);
        const integrationTip = await git(integration.directory, ["rev-parse", "HEAD"]);
        const changes = await git(integration.root, ["diff", "--stat", `${originalTip}..${integrationTip}`]);
        const commits = await git(integration.root, ["log", "--oneline", `${originalTip}..${integrationTip}`]);
        return { originalBranch: integration.originalBranch, baseline: integration.baseline, originalTip, integrationBranch: integration.branch, integrationTip, changes, commits };
    }
    async finalize(parentSessionId) {
        const integration = this.integrations.get(parentSessionId);
        if (!integration)
            throw new Error("No Integration Branch for this Foreman session");
        if (await git(integration.root, ["status", "--porcelain"]))
            throw new Error("Final integration blocked: the user's original worktree is dirty");
        const currentBranch = await git(integration.root, ["rev-parse", "--abbrev-ref", "HEAD"]);
        if (currentBranch !== integration.originalBranch)
            throw new Error(`Final integration blocked: expected original branch ${integration.originalBranch}`);
        const originalTip = await git(integration.root, ["rev-parse", "HEAD"]);
        if (originalTip !== integration.baseline)
            throw new Error("Final integration blocked: original branch advanced; create a new Final Integration flow");
        await git(integration.root, ["merge", "--no-ff", integration.branch, "-m", `merge(workshop): integrate ${integration.branch}`]);
        return { branch: integration.originalBranch, commit: await git(integration.root, ["rev-parse", "HEAD"]) };
    }
    async removeWorktree(root, directory) {
        await git(root, ["worktree", "remove", directory]);
        await rm(directory, { recursive: true, force: true }).catch(() => undefined);
    }
}

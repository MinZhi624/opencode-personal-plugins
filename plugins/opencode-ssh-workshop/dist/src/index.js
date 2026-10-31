import { Plugin } from "@opencode/plugin";
import { createSessionManager } from "./session/manager.js";
import { createRuntime, createWorkspaceRegistry } from "./workspace.js";
import { createDeviceStore } from "./devices/store.js";
import { DeviceError, deviceOptions, deviceTarget } from "./devices/types.js";
import { SshDevicesRpc } from "./devices/rpc.js";
import { connectSession } from "./connect-core.js";
import { LOCAL_TOOLS_TO_HIDE, buildSshAgents, counterpartAgentID, isSshAgent, mergeSshPermissions } from "./agents.js";
import { assertSshSessionAgent, guardToolCall } from "./agent-guard.js";
import { parseSshOptions } from "./options.js";
import { createConnectTool } from "./tools/connect.js";
import { createExecuteTool } from "./tools/execute.js";
import { createDisconnectTool, createInfoTool } from "./tools/session.js";
import { createDownloadTool, createUploadTool } from "./tools/transfer.js";
import { createRemoteFileTools } from "./tools/remote-files.js";
import { createDevicesTool } from "./tools/devices-tool.js";
import { assertPermissionApi } from "./permission.js";
export default Plugin.define({
    id: "opencode-ssh-workshop",
    async setup(context) {
        // 先检查权限能力，再注册任何工具或角色；缺失时直接拒绝加载，绝不降级。
        assertPermissionApi(context);
        const options = parseSshOptions(context.options);
        const sessions = createSessionManager();
        const workspaces = createWorkspaceRegistry(context);
        const devices = createDeviceStore(context);
        const runtime = createRuntime(context, sessions, workspaces, devices, options.rememberDevices);
        // 工具层：上游六项基础能力 + 设备管理 + 四个远端文件工具。
        await context.tool.transform((editor) => {
            const files = createRemoteFileTools(runtime);
            editor.add(createConnectTool(runtime));
            editor.add(createExecuteTool(runtime));
            editor.add(createDisconnectTool(runtime));
            editor.add(createInfoTool(runtime));
            editor.add(createUploadTool(runtime));
            editor.add(createDownloadTool(runtime));
            editor.add(createDevicesTool(runtime));
            editor.add(files.read);
            editor.add(files.write);
            editor.add(files.glob);
            editor.add(files.grep);
        });
        // 角色层：七个 SSH 角色。它们必须先在配置的 `agents` 里声明，
        // 这里只做 update，与 Workshop 原角色同一套路。
        const definitions = buildSshAgents(options.agents);
        await context.agent.transform((editor) => {
            for (const [id, definition] of Object.entries(definitions)) {
                // 未显式覆盖时继承对应 Workshop 角色的模型：Workshop 插件先加载并已写入
                // drafter／tinker／… 的 model，这里读到的就是最终生效值。
                const counterpart = counterpartAgentID(id);
                const source = counterpart ? editor.get(counterpart) : undefined;
                const inheritedModel = source?.model
                    ? { ...source.model }
                    : undefined;
                editor.update(id, (agent) => {
                    const draft = agent;
                    draft.description = definition.description;
                    draft.mode = definition.mode;
                    draft.color = definition.color;
                    draft.steps = definition.steps;
                    draft.system = definition.prompt;
                    const layers = definition.permissions;
                    draft.permissions = mergeSshPermissions((agent.permissions ?? []), layers);
                    const model = definition.model;
                    if (model) {
                        const [providerID, ...rest] = model.split("/");
                        const variant = definition.variant;
                        draft.model = {
                            providerID,
                            id: rest.join("/"),
                            ...(variant ? { variant } : {}),
                        };
                    }
                    else if (inheritedModel) {
                        draft.model = inheritedModel;
                    }
                });
            }
        });
        // SSH 角色不使用本机文件与 shell 工具：读写搜索命令全部走远端对应物。
        // 这样一条「写 /etc/hosts」的请求不可能落到本机同名路径上。
        await context.session.hook("context", (event) => {
            if (!isSshAgent(event.agent))
                return;
            for (const name of LOCAL_TOOLS_TO_HIDE)
                delete event.tools[name];
        });
        // 兜底：本地工具不能被 SSH 角色触达；非 SSH 角色也不能进入 SSH 工具或
        // 通过本机 shell 执行 ssh／scp／sftp。使用事件里的真实角色，不信任工具参数。
        await context.tool.hook("execute.before", (event) => guardToolCall(event.agent, event.tool, event.input));
        // 设备档案的 RPC：`/ssh-devices` 界面通过它读写与连接，
        // 与 ssh_devices 工具操作同一份数据。
        const rpc = await context.rpc.register(SshDevicesRpc, {
            list: async () => ({ devices: await devices.list() }),
            save: async (input, callContext) => {
                const args = input;
                try {
                    const device = await devices.save({
                        id: args.id,
                        name: args.name,
                        host: args.host,
                        user: args.user,
                        port: args.port,
                        identityFile: args.identityFile,
                        options: args.options,
                        remoteDirectory: args.remoteDirectory,
                    });
                    return { device, devices: await devices.list() };
                }
                catch (error) {
                    const message = error instanceof DeviceError ? error.issue : String(error);
                    return callContext.error("invalid", message, { message });
                }
            },
            remove: async (input, callContext) => {
                const { id } = input;
                const removed = await devices.remove(id);
                if (!removed) {
                    const message = `未找到设备 ${id}`;
                    return callContext.error("invalid", message, { message });
                }
                return { removed, devices: await devices.list() };
            },
            connect: async (input, callContext) => {
                const { sessionID, deviceID } = input;
                const profile = await devices.get(deviceID);
                if (!profile) {
                    const message = `未找到设备 ${deviceID}`;
                    return callContext.error("invalid", message, { message });
                }
                const target = deviceTarget(profile);
                // 设备界面同样只接受 SSH 角色；角色必须从服务端会话读取，
                // 不能让界面或调用方自行上报一个“已切换”的角色。
                try {
                    const session = await context.session.get({ sessionID });
                    assertSshSessionAgent(session?.agent);
                }
                catch (error) {
                    const message = error instanceof Error ? error.message : String(error);
                    return callContext.error("invalid", message, { message });
                }
                // 界面只是「发起者」，不是跳过授权的理由：这里仍走 V2 原生权限检查，
                // 因此配置里针对该设备的 deny 规则照样生效。
                try {
                    await context.permission.assert({
                        sessionID,
                        action: "ssh_connect",
                        resources: [target],
                        save: [target],
                        metadata: { host: target, device: profile.name, source: "tui" },
                    });
                }
                catch (error) {
                    const message = String(error instanceof Error ? error.message : error);
                    return callContext.error("invalid", message, { message });
                }
                const rootID = await workspaces.resolveRoot(sessionID);
                try {
                    const message = await connectSession(runtime, rootID, {
                        target,
                        options: deviceOptions(profile),
                        remoteDirectory: profile.remoteDirectory,
                        deviceID: profile.id,
                        remember: false,
                        signal: callContext.signal,
                    });
                    await devices.touch(profile.id, Date.now()).catch(() => undefined);
                    return { message, host: profile.host, remoteDirectory: profile.remoteDirectory };
                }
                catch (error) {
                    const message = String(error instanceof Error ? error.message : error);
                    return callContext.error("invalid", message, { message });
                }
            },
            status: async (input) => {
                const { sessionID } = input;
                const rootID = await workspaces.resolveRoot(sessionID);
                const state = sessions.peek(rootID);
                const workspace = workspaces.get(rootID);
                const profile = state?.deviceID ? await devices.get(state.deviceID) : undefined;
                return {
                    connected: Boolean(state?.proc && !state.readerDone),
                    host: state?.host ?? null,
                    deviceName: profile?.name ?? null,
                    remoteDirectory: state?.remoteDirectory ?? workspace?.remoteDirectory ?? null,
                };
            },
        });
        // 会话清理：主会话被删除时关掉它的连接；子会话删除只清解析缓存，
        // 不牵连主会话的共享连接（上游按单会话清理，这里对应改成按主会话）。
        const controller = new AbortController();
        void (async () => {
            for await (const event of context.event.subscribe({ signal: controller.signal })) {
                const type = event.type;
                if (type !== "session.deleted" && type !== "session.error")
                    continue;
                const sessionID = event.data?.sessionID;
                if (!sessionID)
                    continue;
                const rootID = await workspaces.resolveRoot(sessionID).catch(() => sessionID);
                workspaces.forgetSession(sessionID);
                if (type === "session.deleted" && rootID === sessionID) {
                    workspaces.clear(rootID);
                    sessions.remove(rootID);
                }
            }
        })().catch(() => undefined);
        return () => {
            controller.abort();
            void rpc.dispose();
            sessions.dispose();
        };
    },
});

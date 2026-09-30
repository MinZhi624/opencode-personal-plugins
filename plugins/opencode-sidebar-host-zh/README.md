# 独立侧栏宿主

OpenCode V2 TUI 插件，仅负责 `sidebar.content` 追加、注册、排序和显隐，不读取会话统计或 Provider 凭据。跨插件 JSX 注册是针对 OpenCode 2.0.18 验证的自有同进程接合处，并非官方跨插件 UI API；升级须复验。

完整对接方式见 [下游侧栏卡片对接指南](./INTEGRATION.md)。排序／显隐以全局 `cli.json` 的 `options.sidebarCards` 为准，菜单写回同一位置，不再用旧 storage 覆盖文件。未适配插件由作者或适配器维护者完成接入，不提供通用自动适配器。本次文件配置改动仅作静态检查，运行验收由使用者完成。

第三方卡片在自己的 TUI 插件 `setup` 中导入 `opencode-sidebar-host-zh/card`（本地发行包可按相对路径导入 `../opencode-sidebar-host-zh/src/register-card.ts`），调用：

```ts
const registration = registerSidebarCard({
  id: "vendor.example", owner: "vendor-example-plugin", title: "示例",
  requiredSeam: 1,
  render: ({ sessionID }) => /* 卡片自身的 Solid JSX */ null,
})
return () => registration.dispose()
```

`render` 由卡片拥有，宿主只传 `sessionID`。缺少宿主时排队而不另行插槽；卸载卡片时 `dispose()` 撤回排队并撤销按所有者注册的记录。相同 ID 的不同 owner 和不兼容版本确定性拒绝，卡片渲染错误单卡隔离。`/sidebar-cards` 提供排序／显隐菜单，`/sidebar-host-status` 显示脱敏诊断。

## 文件配置

在 `~/.config/opencode/cli.json`（设置 `XDG_CONFIG_HOME` 时为 `$XDG_CONFIG_HOME/opencode/cli.json`）把唯一宿主条目改为：

```json
{
  "package": "./opencode-zh-bundle/plugins/opencode-sidebar-host-zh",
  "options": {
    "sidebarCards": {
      "order": ["sessionOverview", "quota", "subagents", "skill"],
      "hidden": []
    }
  }
}
```

`order`／`hidden` 使用卡片 ID，不是目录名；隐藏和未加载项保留位置，新注册卡片在内存追加到尾，不自动改文件。对新卡执行菜单操作时才把完整序列保存。`hidden` 中未列入 `order` 的 ID 也会追加占位。卡片私有业务参数仍放在各自插件的 `options`。

`/sidebar-cards` 或 `/sidebar-host-show|hide|up|down <卡片ID>` 安全写回文件并重新读取确认，本窗口立即应用；其他窗口未同步时重启 TUI。`/sidebar-host-status` 展示文件路径、来源、可写状态、实际顺序与脱敏诊断。直接编辑文件依赖 CLI 重载；未同步时重启 TUI，或打开 `/sidebar-cards` 重新读取。

写入只定位当前宿主实际目录或已知宿主包名，保留其他插件／选项／注释，不重新序列化整份文件。多 TUI 写入使用同目录短期独占锁，重新读取并检查外部修改，再以保留权限的临时文件原子替换；外部编辑器不遵守锁，仍存在最后检查和替换间的竞争窗口，不承诺任意外部写入的绝对事务。

缺文件、不可解析、宿主条目不唯一、符号链接、权限不足、文件占用或 `OPENCODE_CLI_CONFIG_CONTENT` 已设置时拒写并提供手动片段，不回退写 storage。异常退出若遗留 `cli.json.sidebar-host.lock`，关闭全部 TUI 并确认没有写入进程后再手动删除该锁；不要删除 `cli.json`。菜单改过的配置视为用户自定义，安装器默认保留。

## 旧设置导入

文件没有 `sidebarCards` 时，通过 `/sidebar-cards` 的导入项或 `/sidebar-host-import` 选择旧宿主 storage、旧聚合 storage 或 `legacySettings` 选项来源，预览并确认后写入文件。已存在 `sidebarCards`（即使为空）时不允许旧设置覆盖；没有旧设置或不可写时不自动迁移。

跨插件存储读不到时，可在宿主选项提供 `legacySettings: {version: 1, order: ["quota", "sessionOverview", "subagents", "skill"], hidden: []}` 作为人工候选，再显式导入。旧存档不删除、不参与常规排序；不要把读不到存档视为已迁移。回退时只保留旧聚合入口，不同时加载新卡片。

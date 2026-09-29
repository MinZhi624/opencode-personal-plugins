# 共享会话统计

独立 TUI 插件 `opencode-session-data` 是会话消息分页、费用／Token 汇总与 TPS 的唯一新入口。每个 TUI 实例只有一份有效运行时，跨标签与会话位置共享；缓存按会话 ID 分区。最后一个消费者离开后停止监听与刷新。`/session-data-status` 只显示脱敏计数。

概览与子代理卡片从 `src/use-session-data.ts` 取得可释放的句柄；模块缺席时显示“共享会话数据不可用”，不自行创建一份统计运行时。费用依据价格快照估算，不等于实际账单。数据模块只负责业务统计，不依赖排序宿主、quota 凭据或任一卡片。

跨插件 `globalThis[Symbol.for(...)]` 接合处限定 OpenCode 2.0.18 的已测环境；正式安装和连接切换仍须逐项人工验收，未勾选项不能视为通过。

接合处 v2 不再按当前会话位置拆分运行时；切换标签时共享同一 TUI 运行时，旧版 v1 位置表在新版安装时撤销并通知消费者。热重载旧代的迟到清理不会卸载已接管运行时。可用 `node --experimental-strip-types --test tests/session-data-seam.test.mjs` 检查接合处行为；这不能替代当前 OpenCode 版本的 TUI 人工验收。

/**
 * 模型分配编排台的前端。
 *
 * 数据事实全部来自 Server 的 RPC（经本地 HTTP 宿主转发）；页面只维护一份草稿，
 * 显式“保存 / 保存并应用”才写回。模型链按顺序保存，Server 加载时取第一个可用项。
 */
const TOKEN = new URLSearchParams(location.search).get("token") || ""
const ROLE_IDS = ["drafter", "tinker", "foreman", "maker", "inspector", "archivist", "surveyor"]

const app = {
  state: null,
  presets: {},
  active: null,
  editing: null,
  selectedRole: "tinker",
  dirty: false,
  filter: "all",
  query: "",
  saving: false,
}

const el = {
  fileChip: document.getElementById("file-chip"),
  presetList: document.getElementById("preset-list"),
  roleList: document.getElementById("role-list"),
  modelList: document.getElementById("model-list"),
  libraryCount: document.getElementById("library-count"),
  modelCount: document.getElementById("model-count"),
  roleCount: document.getElementById("role-count"),
  activeName: document.getElementById("active-name"),
  selectedRole: document.getElementById("selected-role"),
  search: document.getElementById("search"),
  filters: document.getElementById("filters"),
  errorBanner: document.getElementById("error-banner"),
  statusText: document.getElementById("status-text"),
  dirtyDot: document.getElementById("dirty-dot"),
  filePath: document.getElementById("file-path"),
  toast: document.getElementById("toast"),
  save: document.getElementById("save"),
  saveApply: document.getElementById("save-apply"),
  refresh: document.getElementById("refresh"),
  newPreset: document.getElementById("new-preset"),
  duplicatePreset: document.getElementById("duplicate-preset"),
  deletePreset: document.getElementById("delete-preset"),
  copyJson: document.getElementById("copy-json"),
  modal: document.getElementById("modal"),
  modalTitle: document.getElementById("modal-title"),
  modalDesc: document.getElementById("modal-desc"),
  modalInput: document.getElementById("modal-input"),
  modalOk: document.getElementById("modal-ok"),
  modalCancel: document.getElementById("modal-cancel"),
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[char])
}

function modelKey(model) {
  return `${model.providerID}/${model.id}`
}

function modelById(id) {
  return (app.state?.models ?? []).find((model) => modelKey(model) === id)
}

function modelLabel(id) {
  const model = modelById(id)
  if (model) return model.name || model.id
  const parts = String(id).split("/")
  return parts[parts.length - 1] || id
}

function formatContext(value) {
  if (!value) return "-"
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(value % 1_000_000 === 0 ? 0 : 1)}M`
  if (value >= 1_000) return `${Math.round(value / 1_000)}k`
  return String(value)
}

function formatCost(model) {
  if (model.free) return "免费"
  return `$${model.inputCost}/$${model.outputCost} per 1M`
}

function roleById(id) {
  return (app.state?.roles ?? []).find((role) => role.id === id)
}

function currentPreset() {
  return app.editing ? app.presets[app.editing] ?? null : null
}

function ensurePreset() {
  if (!app.editing) {
    let name = "default"
    let index = 2
    while (app.presets[name]) name = `default-${index++}`
    app.presets[name] = { agents: {} }
    app.editing = name
  }
  if (!app.presets[app.editing]) app.presets[app.editing] = { agents: {} }
  if (!app.presets[app.editing].agents) app.presets[app.editing].agents = {}
  return app.presets[app.editing]
}

function baseChain(roleID) {
  const base = app.state?.base?.[roleID]
  if (!base) return []
  if (Array.isArray(base.models)) return [...base.models]
  return base.model ? [base.model] : []
}

function chainInfo(roleID) {
  const override = currentPreset()?.agents?.[roleID]
  const overrideChain = override
    ? (Array.isArray(override.models) ? override.models : override.model ? [override.model] : [])
    : []
  const inheritedChain = baseChain(roleID)
  const chain = overrideChain.length > 0 ? overrideChain : inheritedChain
  return {
    chain: [...chain],
    variant: override?.variant ?? app.state?.base?.[roleID]?.variant,
    source: overrideChain.length > 0 ? "preset" : inheritedChain.length > 0 ? "base" : "none",
    override,
  }
}

function markDirty() {
  app.dirty = true
  renderStatus()
  renderPresetList()
}

function selectedRole() {
  return roleById(app.selectedRole) ?? roleById("tinker")
}

function selectRole(roleID) {
  if (app.selectedRole !== roleID) {
    app.selectedRole = roleID
    // 只切换高亮，不重建角色列表，避免点输入框时焦点被卸载。
    for (const card of el.roleList.querySelectorAll("[data-role]")) {
      card.classList.toggle("selected", card.dataset.role === roleID)
    }
  }
  renderModels()
  renderSelectedRole()
}

function renderSelectedRole() {
  const role = selectedRole()
  el.selectedRole.innerHTML = role
    ? `目标角色 <b>${escapeHtml(role.label)}</b> · ${escapeHtml(role.name)}`
    : "未选择角色"
}

function renderPresetList() {
  const names = Object.keys(app.presets)
  if (names.length === 0) {
    el.presetList.innerHTML = `<div class="empty-state">还没有预设。点右上角 + 新建。</div>`
    return
  }
  el.presetList.innerHTML = names.map((name) => {
    const preset = app.presets[name]
    const count = Object.keys(preset.agents ?? {}).length
    const applied = app.active === name
    const unsaved = !app.state || !Object.hasOwn(app.state.presets ?? {}, name)
    return `<button class="preset-item ${app.editing === name ? "editing" : ""} ${applied ? "applied" : ""}" data-preset="${escapeHtml(name)}">
      <span class="preset-dot"></span>
      <span class="preset-name">${escapeHtml(name)}</span>
      <span class="preset-meta">
        <span class="preset-count">${count}</span>
        ${applied ? `<span class="applied-tag">使用中</span>` : ""}
        ${unsaved ? `<span class="unsaved-tag">未保存</span>` : ""}
      </span>
    </button>`
  }).join("")
}

function slotBadges(id, variant, source) {
  const model = modelById(id)
  const badges = []
  if (model?.vision) badges.push(`<span class="badge vision">视觉</span>`)
  if (model?.free) badges.push(`<span class="badge free">免费</span>`)
  if (model && model.status !== "active") badges.push(`<span class="badge">${escapeHtml(model.status)}</span>`)
  if (variant) badges.push(`<span class="badge variant">${escapeHtml(variant)}</span>`)
  if (source === "base") badges.push(`<span class="badge base">base</span>`)
  return badges.join("")
}

function slotHtml(role, id, index, chain, info) {
  const variant = info.variant
  return `<div class="model-slot ${index === 0 ? "first" : "fallback"}">
    <span class="idx">${index + 1}</span>
    <div class="model-main">
      <div class="model-name">${escapeHtml(modelLabel(id))}</div>
      <div class="model-id">${escapeHtml(id)}</div>
    </div>
    <div class="slot-badges">${slotBadges(id, index === 0 ? variant : undefined, info.source)}</div>
    <div class="slot-actions">
      <button title="上移" data-up="${role.id}" data-index="${index}" ${index === 0 ? "disabled" : ""}>↑</button>
      <button title="下移" data-down="${role.id}" data-index="${index}" ${index === chain.length - 1 ? "disabled" : ""}>↓</button>
      <button class="remove" title="移除" data-remove="${role.id}" data-index="${index}">×</button>
    </div>
  </div>`
}

function renderRoles() {
  const roles = app.state?.roles ?? []
  el.roleList.innerHTML = roles.map((role) => {
    const info = chainInfo(role.id)
    const slots = info.chain.map((id, index) => slotHtml(role, id, index, info.chain, info)).join("")
    const chain = slots || `<div class="chain-empty">尚未分配模型。从右侧模型库点选，或输入自定义 id。</div>`
    const hint = info.source === "base" ? "继承 base" : info.source === "preset" ? "本地覆盖" : "未配置"
    return `<article class="role-card ${app.selectedRole === role.id ? "selected" : ""}" data-role="${role.id}" style="--role-color:${escapeHtml(role.color)}">
      <div class="role-accent"></div>
      <div class="role-main">
        <div class="role-head">
          <div class="role-title">
            <h3>${escapeHtml(role.label)}</h3>
            <span class="role-cn">${escapeHtml(role.name)}</span>
            <span class="mode-badge ${role.mode === "primary" ? "primary" : ""}">${role.mode}</span>
          </div>
          <div class="role-tools">
            <input class="variant-input" data-variant="${role.id}" value="${escapeHtml(info.variant ?? "")}" placeholder="variant" title="可选：思考强度 / reasoning variant" />
            <button class="link-btn" data-reset="${role.id}" title="删除本预设对该角色的覆盖，恢复 base">还原</button>
          </div>
        </div>
        <p class="role-desc">${escapeHtml(role.description)}</p>
        <div class="chain">${chain}</div>
        <div class="add-row">
          <input class="custom-input" data-custom="${role.id}" placeholder="自定义模型 id（provider/model）" autocomplete="off" spellcheck="false" />
          <button class="add-btn" data-add-custom="${role.id}">添加</button>
          <span class="inherit-hint">${hint}</span>
        </div>
      </div>
    </article>`
  }).join("")
}

function setChain(roleID, chain) {
  const preset = ensurePreset()
  const existing = { ...(preset.agents[roleID] ?? {}) }
  if (chain.length > 0) {
    existing.models = chain
    delete existing.model
  } else {
    delete existing.models
    delete existing.model
  }
  if (!existing.models && !existing.model && !existing.variant && existing.temperature === undefined) {
    delete preset.agents[roleID]
  } else {
    preset.agents[roleID] = existing
  }
  markDirty()
  renderRoles()
  renderModels()
}

function setVariant(roleID, value) {
  const preset = ensurePreset()
  const existing = { ...(preset.agents[roleID] ?? {}) }
  const trimmed = value.trim()
  if (trimmed) existing.variant = trimmed
  else delete existing.variant
  if (!existing.models && !existing.model && !existing.variant && existing.temperature === undefined) {
    delete preset.agents[roleID]
  } else {
    preset.agents[roleID] = existing
  }
  markDirty()
  renderRoles()
}

function resetRole(roleID) {
  const preset = ensurePreset()
  delete preset.agents[roleID]
  markDirty()
  renderRoles()
  renderModels()
}

function addModel(id) {
  const role = selectedRole()
  if (!role) return
  const info = chainInfo(role.id)
  if (info.chain.includes(id)) {
    showToast(`${role.label} 的候选链里已经有 ${id}`, "warning")
    return
  }
  setChain(role.id, [...info.chain, id])
  showToast(`已加入 ${role.label}：${modelLabel(id)}`, "success")
}

function moveSlot(roleID, index, delta) {
  const info = chainInfo(roleID)
  const next = [...info.chain]
  const target = index + delta
  if (target < 0 || target >= next.length) return
  const [item] = next.splice(index, 1)
  next.splice(target, 0, item)
  setChain(roleID, next)
}

function renderModels() {
  const models = app.state?.models ?? []
  const query = app.query.trim().toLowerCase()
  const filtered = models.filter((model) => {
    const key = modelKey(model)
    if (query && !`${model.name} ${key} ${model.providerName}`.toLowerCase().includes(query)) return false
    if (app.filter === "vision" && !model.vision) return false
    if (app.filter === "free" && !model.free) return false
    if (app.filter === "big" && model.context < 200_000) return false
    return true
  })

  el.libraryCount.textContent = `${filtered.length}/${models.length}`
  el.modelCount.textContent = String(models.length)

  if (filtered.length === 0) {
    el.modelList.innerHTML = `<div class="empty-state">没有匹配的模型。</div>`
    return
  }

  const selected = selectedRole()
  const inChain = new Set(selected ? chainInfo(selected.id).chain : [])
  let lastProvider = null
  el.modelList.innerHTML = filtered.map((model) => {
    const key = modelKey(model)
    const providerLabel = model.providerName !== lastProvider
      ? `<div class="provider-label">${escapeHtml(model.providerName)}</div>`
      : ""
    lastProvider = model.providerName
    const badges = [
      model.vision ? `<span class="badge vision">视觉</span>` : "",
      model.free ? `<span class="badge free">免费</span>` : "",
      model.status !== "active" ? `<span class="badge">${escapeHtml(model.status)}</span>` : "",
      inChain.has(key) ? `<span class="in-chain-mark">✓ 已在链中</span>` : "",
    ].join("")
    return `${providerLabel}<button class="model-card ${inChain.has(key) ? "in-chain" : ""}" data-model="${escapeHtml(key)}" title="加入 ${escapeHtml(selected?.label ?? "选中角色")}">
      <div class="model-top">
        <span class="model-name">${escapeHtml(model.name || model.id)}</span>
        <span class="provider">${escapeHtml(model.providerID)}</span>
      </div>
      <div class="model-id">${escapeHtml(key)}</div>
      <div class="model-badges">${badges}</div>
      <div class="model-meta">ctx ${formatContext(model.context)} · ${formatCost(model)}</div>
    </button>`
  }).join("")
}

function renderStatus() {
  const state = app.state
  const canWrite = Boolean(state?.writable) && !state?.error && !app.saving
  el.save.disabled = !canWrite
  el.saveApply.disabled = !canWrite
  el.refresh.disabled = app.saving
  el.newPreset.disabled = app.saving
  el.duplicatePreset.disabled = app.saving || !app.editing
  el.deletePreset.disabled = app.saving || !app.editing

  const preset = currentPreset()
  const count = preset ? Object.keys(preset.agents ?? {}).length : 0
  el.roleCount.textContent = `${count} / ${ROLE_IDS.length}`
  el.activeName.textContent = app.active ?? "base"
  el.activeName.title = app.active ?? "base（插件 options）"

  el.dirtyDot.className = `dot ${state?.error ? "error" : app.dirty ? "dirty" : ""}`
  if (state?.error) el.statusText.textContent = state.error
  else if (app.saving) el.statusText.textContent = "正在写入预设…"
  else if (app.dirty) el.statusText.textContent = "有未保存修改"
  else if (state?.exists) el.statusText.textContent = "已连接 · 预设已加载"
  else el.statusText.textContent = "已连接 · 尚未创建预设文件"

  const path = state?.filePath ?? ""
  el.fileChip.textContent = path ? path.split("/").pop() : "未连接"
  el.fileChip.title = path
  el.filePath.textContent = path

  if (state?.error) {
    el.errorBanner.hidden = false
    el.errorBanner.textContent = `${state.error} 请先手动修复文件；为避免覆盖原内容，保存已禁用。`
  } else if (state && !state.writable) {
    el.errorBanner.hidden = false
    el.errorBanner.textContent = "预设文件不可写。请检查目录权限，或用插件选项 presetsFile 指定可写路径。"
  } else {
    el.errorBanner.hidden = true
  }
}

function renderAll() {
  renderPresetList()
  renderRoles()
  renderModels()
  renderSelectedRole()
  renderStatus()
}

function showToast(message, variant = "info") {
  el.toast.hidden = false
  el.toast.className = `toast ${variant}`
  el.toast.textContent = message
  clearTimeout(showToast.timer)
  showToast.timer = setTimeout(() => { el.toast.hidden = true }, 4200)
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: {
      "content-type": "application/json",
      "x-preset-token": TOKEN,
      ...(options.headers ?? {}),
    },
  })
  const data = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`)
  return data
}

function hydrate(state, options = {}) {
  app.state = state
  app.presets = structuredClone(state.presets ?? {})
  app.active = state.active ?? null
  const names = Object.keys(app.presets)
  if (names.length === 0) {
    app.presets = { default: { agents: {} } }
    app.editing = "default"
  } else {
    app.editing = options.keepEditing && app.presets[app.editing]
      ? app.editing
      : state.active && app.presets[state.active]
        ? state.active
        : names[0]
  }
  app.dirty = false
  if (!roleById(app.selectedRole)) app.selectedRole = "tinker"
  renderAll()
}

async function load() {
  try {
    hydrate(await api("/api/state"))
  } catch (error) {
    el.statusText.textContent = `连接失败：${error.message}`
    el.dirtyDot.className = "dot error"
    showToast(`连接本地预设服务失败：${error.message}`, "error")
  }
}

async function save(apply) {
  if (!app.state) return
  ensurePreset()
  app.saving = true
  renderStatus()
  try {
    const active = apply ? app.editing : app.active
    const state = await api("/api/save", {
      method: "POST",
      body: JSON.stringify({ presets: app.presets, active }),
    })
    hydrate(state, { keepEditing: true })
    showToast(apply ? `已保存并应用「${app.editing}」` : "已保存", "success")
  } catch (error) {
    showToast(`保存失败：${error.message}`, "error")
  } finally {
    app.saving = false
    renderStatus()
  }
}

function askText({ title, desc = "", value = "", ok = "确定" }) {
  return new Promise((resolve) => {
    el.modalTitle.textContent = title
    el.modalDesc.textContent = desc
    el.modalInput.value = value
    el.modalOk.textContent = ok
    el.modal.hidden = false
    el.modalInput.focus()
    el.modalInput.select()

    const cleanup = () => {
      el.modal.hidden = true
      el.modalOk.removeEventListener("click", confirm)
      el.modalCancel.removeEventListener("click", cancel)
      el.modalInput.removeEventListener("keydown", keydown)
      el.modal.removeEventListener("mousedown", backdrop)
    }
    const confirm = () => {
      const text = el.modalInput.value.trim()
      cleanup()
      resolve(text || null)
    }
    const cancel = () => {
      cleanup()
      resolve(null)
    }
    const keydown = (event) => {
      if (event.key === "Enter") { event.preventDefault(); confirm() }
      if (event.key === "Escape") { event.preventDefault(); cancel() }
    }
    const backdrop = (event) => {
      if (event.target === el.modal) cancel()
    }
    el.modalOk.addEventListener("click", confirm)
    el.modalCancel.addEventListener("click", cancel)
    el.modalInput.addEventListener("keydown", keydown)
    el.modal.addEventListener("mousedown", backdrop)
  })
}

async function newPreset() {
  const name = await askText({
    title: "新建预设",
    desc: "预设名用于 presets.json；建议用场景命名，例如 cheap、thinking、review。",
    value: `preset-${Object.keys(app.presets).length + 1}`,
    ok: "创建",
  })
  if (!name) return
  if (app.presets[name]) { showToast(`预设「${name}」已存在`, "warning"); return }
  app.presets[name] = { agents: {} }
  app.editing = name
  markDirty()
  renderAll()
}

async function duplicatePreset() {
  const current = currentPreset()
  if (!current) return
  const name = await askText({
    title: "复制预设",
    desc: `复制「${app.editing}」的全部角色覆盖。`,
    value: `${app.editing}-copy`,
    ok: "复制",
  })
  if (!name) return
  if (app.presets[name]) { showToast(`预设「${name}」已存在`, "warning"); return }
  app.presets[name] = structuredClone(current)
  app.editing = name
  markDirty()
  renderAll()
}

function deletePreset() {
  if (!app.editing) return
  if (!window.confirm(`删除预设「${app.editing}」？保存后才会写入文件。`)) return
  delete app.presets[app.editing]
  if (app.active === app.editing) app.active = null
  app.editing = Object.keys(app.presets)[0] ?? null
  markDirty()
  renderAll()
}

async function copyJson() {
  const payload = {
    version: 1,
    ...(app.active ? { active: app.active } : {}),
    presets: app.presets,
  }
  const text = JSON.stringify(payload, null, 2)
  try {
    await navigator.clipboard.writeText(text)
    showToast("预设 JSON 已复制", "success")
  } catch {
    const area = document.createElement("textarea")
    area.value = text
    document.body.appendChild(area)
    area.select()
    document.execCommand("copy")
    area.remove()
    showToast("预设 JSON 已复制", "success")
  }
}

el.presetList.addEventListener("click", (event) => {
  const item = event.target.closest("[data-preset]")
  if (!item) return
  app.editing = item.dataset.preset
  renderAll()
})

el.roleList.addEventListener("click", (event) => {
  const card = event.target.closest("[data-role]")
  if (card && !event.target.closest("button, input")) selectRole(card.dataset.role)

  const up = event.target.closest("[data-up]")
  if (up) return moveSlot(up.dataset.up, Number(up.dataset.index), -1)
  const down = event.target.closest("[data-down]")
  if (down) return moveSlot(down.dataset.down, Number(down.dataset.index), 1)
  const remove = event.target.closest("[data-remove]")
  if (remove) {
    const roleID = remove.dataset.remove
    const index = Number(remove.dataset.index)
    const chain = chainInfo(roleID).chain
    return setChain(roleID, chain.filter((_, position) => position !== index))
  }
  const reset = event.target.closest("[data-reset]")
  if (reset) return resetRole(reset.dataset.reset)
  const add = event.target.closest("[data-add-custom]")
  if (add) {
    const roleID = add.dataset.addCustom
    const input = el.roleList.querySelector(`[data-custom="${roleID}"]`)
    return addCustom(roleID, input?.value ?? "")
  }
})

el.roleList.addEventListener("focusin", (event) => {
  const card = event.target.closest("[data-role]")
  if (card) selectRole(card.dataset.role)
})

el.roleList.addEventListener("change", (event) => {
  const variant = event.target.closest("[data-variant]")
  if (variant) setVariant(variant.dataset.variant, variant.value)
})

el.roleList.addEventListener("keydown", (event) => {
  if (event.key !== "Enter") return
  const custom = event.target.closest("[data-custom]")
  if (!custom) return
  event.preventDefault()
  addCustom(custom.dataset.custom, custom.value)
})

function addCustom(roleID, value) {
  const id = value.trim()
  if (!/^[^/\s]+\/[^/\s]+$/.test(id)) {
    showToast("模型 id 必须是 provider/model，例如 opencode-go/deepseek-v4.1-flash", "warning")
    return
  }
  const info = chainInfo(roleID)
  if (info.chain.includes(id)) {
    showToast(`候选链里已经有 ${id}`, "warning")
    return
  }
  setChain(roleID, [...info.chain, id])
  const input = el.roleList.querySelector(`[data-custom="${roleID}"]`)
  if (input) input.value = ""
}

el.modelList.addEventListener("click", (event) => {
  const card = event.target.closest("[data-model]")
  if (!card) return
  addModel(card.dataset.model)
})

el.filters.addEventListener("click", (event) => {
  const chip = event.target.closest("[data-filter]")
  if (!chip) return
  app.filter = chip.dataset.filter
  for (const item of el.filters.querySelectorAll("[data-filter]")) {
    item.classList.toggle("active", item === chip)
  }
  renderModels()
})

el.search.addEventListener("input", () => {
  app.query = el.search.value
  renderModels()
})

el.save.addEventListener("click", () => void save(false))
el.saveApply.addEventListener("click", () => void save(true))
el.refresh.addEventListener("click", () => {
  if (app.dirty && !window.confirm("有未保存修改，刷新会丢弃它们。继续？")) return
  void load()
})
el.newPreset.addEventListener("click", () => void newPreset())
el.duplicatePreset.addEventListener("click", () => void duplicatePreset())
el.deletePreset.addEventListener("click", deletePreset)
el.copyJson.addEventListener("click", () => void copyJson())

window.addEventListener("beforeunload", (event) => {
  if (!app.dirty) return
  event.preventDefault()
  event.returnValue = ""
})

window.addEventListener("keydown", (event) => {
  const mod = event.ctrlKey || event.metaKey
  if (!mod || event.key.toLowerCase() !== "s") return
  event.preventDefault()
  if (!el.save.disabled) void save(event.shiftKey)
})

renderSelectedRole()
void load()

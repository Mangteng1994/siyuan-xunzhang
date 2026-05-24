"use strict";

const {
  Plugin,
  Menu,
  confirm,
  fetchSyncPost,
  showMessage,
  openTab,
  openMobileFileById,
  getFrontend,
  Constants,
} = require("siyuan");

const MARK_START = "aacc1";
const MARK_END = "aacc2";
const MARK_TARGET = "aacc3";
const MARK_ALIASES = {
  [MARK_START]: [MARK_START, "批量开始"],
  [MARK_END]: [MARK_END, "批量结束"],
  [MARK_TARGET]: [MARK_TARGET, "批量目标"],
};
const PLUGIN_VERSION = "0.3.2";
const HIGHLIGHT_CLASS = "siyuan-xunzhang-highlight";
const ACTIVE_WND_CLASS = "layout__wnd--active";
const BLOCK_ID_RE = /^\d{14}-[0-9a-z]{7}$/i;
const LOCK_NAME = "siyuan-xunzhang-long-content-ops";

function isBlockId(value) {
  return BLOCK_ID_RE.test(String(value || "").trim());
}

function uniq(values) {
  return Array.from(new Set(values.map((value) => String(value || "").trim()).filter(Boolean)));
}

function escapeSql(value) {
  return String(value || "").replaceAll("'", "''");
}

function sqlValueList(values) {
  return values.map((value) => `'${escapeSql(value)}'`).join(", ");
}

function normalizeMarker(value) {
  const text = String(value || "").trim();
  for (const [marker, aliases] of Object.entries(MARK_ALIASES)) {
    if (aliases.includes(text)) return marker;
  }
  return "";
}

function markerLabel(marker) {
  return MARK_ALIASES[marker].join(" 或 ");
}

function escapeSelector(value) {
  if (globalThis.CSS && typeof globalThis.CSS.escape === "function") return globalThis.CSS.escape(value);
  return String(value || "").replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

async function api(path, data = {}) {
  const result = await fetchSyncPost(path, data);
  if (!result || result.code !== 0) {
    throw new Error((result && result.msg) || `${path} failed`);
  }
  return result.data;
}

async function sql(stmt) {
  const data = await api("/api/query/sql", { stmt });
  return Array.isArray(data) ? data : [];
}

function ask(title, message) {
  return new Promise((resolve) => confirm(title, message, () => resolve(true), () => resolve(false)));
}

function notify(message, isError = false, timeout = 3000) {
  showMessage(message, timeout, isError ? "error" : "info");
}

function getAppId() {
  return Constants?.SIYUAN_APPID || window.siyuan?.ws?.app?.appId || "siyuan";
}

async function transactions(doOperations, undoOperations = []) {
  if (!doOperations || doOperations.length === 0) return null;
  return api("/api/transactions", {
    session: getAppId(),
    app: getAppId(),
    transactions: [{ doOperations, undoOperations }],
    reqId: Date.now(),
  });
}

function transDeleteBlocks(ids) {
  return uniq(ids).filter(isBlockId).map((id) => ({ action: "delete", id }));
}

function transMoveBlocksAfter(ids, previousID) {
  return uniq(ids).filter(isBlockId).slice().reverse().map((id) => ({ action: "move", id, previousID }));
}

function transInsertBlocksAfter(domStrings, previousID) {
  return domStrings.slice().reverse().map((data) => ({ action: "insert", data, previousID }));
}

function transInsertBlockAt(data, anchor) {
  const operation = { action: "insert", data };
  if (anchor?.previousID) operation.previousID = anchor.previousID;
  else if (anchor?.nextID) operation.nextID = anchor.nextID;
  else if (anchor?.parentID) operation.parentID = anchor.parentID;
  return operation;
}

function transInsertBlocksAt(domStrings, anchor) {
  if (anchor?.previousID) return domStrings.slice().reverse().map((data) => transInsertBlockAt(data, anchor));
  return domStrings.map((data) => transInsertBlockAt(data, anchor));
}

function getDocIdFromContainer(container) {
  if (!container?.querySelector) return "";
  const selectors = [
    ".protyle:not(.fn__none) .protyle-title[data-node-id]",
    ".protyle:not(.fn__none) .protyle-background[data-node-id]",
    ".protyle-title[data-node-id]",
    ".protyle-background[data-node-id]",
  ];
  for (const selector of selectors) {
    const id = container.querySelector(selector)?.getAttribute("data-node-id");
    if (isBlockId(id)) return id;
  }
  return "";
}

function getActiveDocId(preferredPart) {
  const activeProtyle = document.activeElement?.closest?.(".protyle");
  const activeWnd = activeProtyle?.closest?.(".layout__wnd");
  const containers = [
    activeProtyle,
    activeWnd,
    preferredPart,
    document.querySelector(`.${ACTIVE_WND_CLASS}`),
    document.querySelector(".layout__wnd"),
  ].filter((container, index, list) => container && list.indexOf(container) === index);
  for (const container of containers) {
    const id = getDocIdFromContainer(container);
    if (id) return id;
  }
  return "";
}

function getElementFromNode(node) {
  if (!node) return null;
  return node.nodeType === 1 ? node : node.parentElement;
}

function getSelectionBlockId(preferredPart) {
  const selection = window.getSelection?.();
  const nodes = [selection?.anchorNode, selection?.focusNode];
  for (const node of nodes) {
    const block = getElementFromNode(node)?.closest?.(".protyle-wysiwyg [data-node-id]");
    const id = block?.getAttribute("data-node-id");
    if (isBlockId(id) && (!preferredPart || preferredPart.contains(block))) return id;
  }
  return "";
}

function getActiveBlockId(preferredPart, fallbackId = "") {
  const selectedId = getSelectionBlockId(preferredPart) || getSelectionBlockId(null);
  if (selectedId) return selectedId;

  const containers = [
    document.activeElement?.closest?.(".protyle"),
    document.activeElement?.closest?.(".layout__wnd"),
    preferredPart,
    document.querySelector(`.${ACTIVE_WND_CLASS}`),
  ].filter((container, index, list) => container && list.indexOf(container) === index);

  for (const container of containers) {
    const selected = container.querySelector?.(".protyle-wysiwyg--select[data-node-id]");
    const selectedId = selected?.getAttribute("data-node-id");
    if (isBlockId(selectedId)) return selectedId;

    const activeBlock = document.activeElement?.closest?.(".protyle-wysiwyg [data-node-id]");
    const activeId = activeBlock?.getAttribute("data-node-id");
    if (activeBlock && container.contains(activeBlock) && isBlockId(activeId)) return activeId;
  }
  return isBlockId(fallbackId) ? fallbackId : "";
}

function getFileDock() {
  const layout = window.siyuan?.layout;
  return layout?.leftDock?.data?.file || layout?.rightDock?.data?.file || layout?.bottomDock?.data?.file;
}

function openFileDock() {
  const fileButton = document.querySelector('[data-type="file"]');
  if (!fileButton) return false;
  if (!fileButton.classList.contains("dock__item--active")) fileButton.click();
  return true;
}

function focusActiveWindow(activePart) {
  const part = activePart || document.querySelector(`.${ACTIVE_WND_CLASS}`);
  part?.classList?.add(ACTIVE_WND_CLASS);
  document.querySelector('[data-type="focus"]')?.click();
  part?.classList?.remove(ACTIVE_WND_CLASS);
}

function highlight(element) {
  if (!element) return;
  element.scrollIntoView({ block: "center", behavior: "smooth" });
  element.classList.remove(HIGHLIGHT_CLASS);
  window.requestAnimationFrame(() => {
    element.classList.add(HIGHLIGHT_CLASS);
    window.setTimeout(() => element.classList.remove(HIGHLIGHT_CLASS), 2200);
  });
}

function findFileTreeNode(id) {
  return document.querySelector(`.file-tree [data-node-id="${escapeSelector(id)}"], .file-tree [data-id="${escapeSelector(id)}"]`);
}

function newBlockId() {
  if (globalThis.Lute?.NewNodeID) return globalThis.Lute.NewNodeID();
  const pad = (value) => String(value).padStart(2, "0");
  const now = new Date();
  const stamp = [
    now.getFullYear(),
    pad(now.getMonth() + 1),
    pad(now.getDate()),
    pad(now.getHours()),
    pad(now.getMinutes()),
    pad(now.getSeconds()),
  ].join("");
  const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
  let tail = "";
  for (let i = 0; i < 7; i += 1) tail += alphabet[Math.floor(Math.random() * alphabet.length)];
  return `${stamp}-${tail}`;
}

function cloneBlockElement(element) {
  const clone = element.cloneNode(true);
  clone.classList.remove("protyle-wysiwyg--select");
  clone.querySelectorAll('[contenteditable="false"]').forEach((node) => node.setAttribute("contenteditable", "true"));
  clone.setAttribute("data-node-id", newBlockId());
  clone.querySelectorAll("[data-node-id]").forEach((node) => node.setAttribute("data-node-id", newBlockId()));
  clone.removeAttribute("updated");
  clone.querySelectorAll("[updated]").forEach((node) => node.removeAttribute("updated"));
  return { id: clone.getAttribute("data-node-id"), dom: clone.outerHTML };
}

function blockDom(item) {
  return item?.element?.outerHTML || "";
}

function anchorAt(children, index, parentID, excludedIds = new Set()) {
  for (let i = index - 1; i >= 0; i -= 1) {
    const id = children[i]?.id;
    if (isBlockId(id) && !excludedIds.has(id)) return { previousID: id };
  }
  for (let i = index + 1; i < children.length; i += 1) {
    const id = children[i]?.id;
    if (isBlockId(id) && !excludedIds.has(id)) return { nextID: id };
  }
  return { parentID };
}

async function getDocChildren(docId) {
  const data = await api("/api/block/getBlockDOM", { id: docId });
  const dom = data?.dom || "";
  if (!dom) throw new Error(`无法读取文档 DOM：${docId}`);
  const wrapper = document.createElement("div");
  wrapper.innerHTML = `<div>${dom}</div>`;
  const root = wrapper.firstElementChild;
  const children = Array.from(root?.children || [])
    .filter((element) => element?.getAttribute)
    .map((element) => ({ id: element.getAttribute("data-node-id"), element }))
    .filter((item) => isBlockId(item.id));
  return { root, children };
}

async function findMarkers(needsTarget) {
  const activeDocId = getActiveDocId();
  const rows = await sql(`
    SELECT id, root_id, content, markdown
    FROM blocks
    WHERE type = 'p'
      AND (
        trim(content) IN (${sqlValueList(Object.values(MARK_ALIASES).flat())})
        OR trim(markdown) IN (${sqlValueList(Object.values(MARK_ALIASES).flat())})
      )
    ORDER BY id
  `);
  const markerRows = rows.map((row) => ({
    ...row,
    marker: normalizeMarker(row.markdown || row.content),
  }));
  const rowsInActiveDoc = activeDocId ? markerRows.filter((row) => row.root_id === activeDocId) : [];
  const sourceRows = rowsInActiveDoc.length > 0 ? rowsInActiveDoc : markerRows;
  const starts = sourceRows.filter((row) => row.marker === MARK_START);
  const targetRows = rowsInActiveDoc.length > 0 ? rowsInActiveDoc : markerRows;
  const target = targetRows.find((row) => row.marker === MARK_TARGET);

  for (const start of starts) {
    const end = sourceRows.find((row) => row.marker === MARK_END && row.root_id === start.root_id && row.id > start.id);
    if (!end) continue;
    return { start, end, target: needsTarget ? target : null };
  }

  return { start: starts[0], end: null, target: needsTarget ? target : null };
}

async function buildMarkerPlan(needsTarget) {
  const { start, end, target } = await findMarkers(needsTarget);
  if (!start?.id) return { error: `${markerLabel(MARK_START)} not found` };
  if (!end?.id) return { error: `${markerLabel(MARK_END)} not found` };
  if (start.root_id !== end.root_id) return { error: `${markerLabel(MARK_START)} ${markerLabel(MARK_END)} must be in the same doc` };
  if (needsTarget && !target?.id) return { error: `${markerLabel(MARK_TARGET)} not found` };

  const { children } = await getDocChildren(start.root_id);
  const startIndex = children.findIndex((child) => child.id === start.id);
  const endIndex = children.findIndex((child) => child.id === end.id);
  if (startIndex < 0 || endIndex < 0 || startIndex >= endIndex) {
    return { error: `${markerLabel(MARK_START)}/${markerLabel(MARK_END)} 必须是同一文档中的顶层段落标记，并且开始标记在前` };
  }

  const content = children.slice(startIndex + 1, endIndex);
  if (content.length === 0) return { error: `${markerLabel(MARK_START)} 到 ${markerLabel(MARK_END)} 之间没有可处理内容块` };

  const sourceDeletedIds = new Set([start.id, end.id, ...content.map((item) => item.id)]);
  let targetBlock = null;
  let targetAnchor = null;
  if (needsTarget && target?.id) {
    const targetDoc = target.root_id === start.root_id ? { children } : await getDocChildren(target.root_id);
    const targetIndex = targetDoc.children.findIndex((child) => child.id === target.id);
    if (targetIndex < 0) return { error: `${markerLabel(MARK_TARGET)} 必须是顶层段落标记` };
    targetBlock = targetDoc.children[targetIndex];
    targetAnchor = anchorAt(targetDoc.children, targetIndex, target.root_id, new Set([...sourceDeletedIds, target.id]));
  }

  return {
    startId: start.id,
    endId: end.id,
    targetId: needsTarget ? target.id : "",
    sourceRootId: start.root_id,
    startBlock: children[startIndex],
    endBlock: children[endIndex],
    sourceRangeAnchor: anchorAt(children, startIndex, start.root_id, sourceDeletedIds),
    startAnchor: anchorAt(children, startIndex, start.root_id, new Set([start.id, end.id, target?.id].filter(Boolean))),
    endAnchor: anchorAt(children, endIndex, start.root_id, new Set([start.id, end.id, target?.id].filter(Boolean))),
    targetBlock,
    targetAnchor,
    content,
  };
}

async function withLock(task, label) {
  if (!navigator.locks?.request) return task();
  return navigator.locks.request(LOCK_NAME, { ifAvailable: true }, async (lock) => {
    if (!lock) {
      notify(`${label}：已有批量任务正在执行，请稍后再试`, true, 3500);
      return null;
    }
    return task();
  });
}

class XunzhangPlugin extends Plugin {
  constructor(...args) {
    super(...args);
    this.topBarElement = null;
    this.lastActivePart = null;
    this.lastActiveBlockId = "";
    this.batchUndoStack = [];
    this.activeObserver = null;
    this.onKeyDown = this.onKeyDown.bind(this);
    this.onContentMenu = this.onContentMenu.bind(this);
    this.onBlockMenu = this.onBlockMenu.bind(this);
    this.onTopBarContextMenu = this.onTopBarContextMenu.bind(this);
    this.rememberActiveBlock = this.rememberActiveBlock.bind(this);
  }

  onload() {
    this.markLoaded("onload");

    try {
      this.addIcons(`
        <symbol id="iconSyBatchLocate" viewBox="0 0 32 32">
          <path d="M2 15V2h13v3H5v10H2zm15-13h13v13h-3V5H17V2zM2 17h3v10h10v3H2V17zm25 0h3v13H17v-3h10V17z"/>
          <circle cx="16" cy="16" r="3.8" fill="none" stroke="currentColor" stroke-width="2.4"/>
        </symbol>
      `);

      this.topBarElement = this.addTopBar({
        icon: "iconSyBatchLocate",
        title: "突出定位文档 Alt+Enter，右键打开批量菜单",
        position: "left",
        callback: () => this.locateCurrentDoc(),
      });
      this.topBarElement?.addEventListener("contextmenu", this.onTopBarContextMenu);

      this.registerCommands();
      this.trackActiveWindow();
      this.rememberActiveBlock();
      document.addEventListener("selectionchange", this.rememberActiveBlock, true);
      document.addEventListener("keyup", this.rememberActiveBlock, true);
      document.addEventListener("mouseup", this.rememberActiveBlock, true);
      document.addEventListener("keydown", this.onKeyDown, true);
      this.eventBus.on("open-menu-content", this.onContentMenu);
      this.eventBus.on("click-blockicon", this.onBlockMenu);
    } catch (error) {
      const message = `寻章加载失败：${error.message || error}`;
      console.error("[siyuan-xunzhang] onload failed", error);
      notify(message, true, 6000);
    }
  }

  onLayoutReady() {
    this.markLoaded("layout");
  }

  markLoaded(stage) {
    window.__syXunzhangLoaded = PLUGIN_VERSION;
    console.info(`[siyuan-xunzhang] ${stage} v${PLUGIN_VERSION}`);
  }

  onunload() {
    this.topBarElement?.removeEventListener("contextmenu", this.onTopBarContextMenu);
    document.removeEventListener("selectionchange", this.rememberActiveBlock, true);
    document.removeEventListener("keyup", this.rememberActiveBlock, true);
    document.removeEventListener("mouseup", this.rememberActiveBlock, true);
    document.removeEventListener("keydown", this.onKeyDown, true);
    this.eventBus.off("open-menu-content", this.onContentMenu);
    this.eventBus.off("click-blockicon", this.onBlockMenu);
    this.activeObserver?.disconnect();
  }

  registerCommands() {
    this.addCommand({
      langKey: "siyuan-xunzhang-locate-doc",
      langText: "突出定位文档",
      hotkey: "⌥↩",
      callback: () => this.locateCurrentDoc(),
      editorCallback: () => this.locateCurrentDoc(),
      globalCallback: () => this.locateCurrentDoc(),
    });
    this.addCommand({
      langKey: "siyuan-xunzhang-delete-range",
      langText: "批量删除大量连续内容块",
      hotkey: "⌥⇧;",
      callback: () => this.deleteMarkedRange(),
      editorCallback: () => this.deleteMarkedRange(),
      globalCallback: () => this.deleteMarkedRange(),
    });
    this.addCommand({
      langKey: "siyuan-xunzhang-move-range",
      langText: "批量移动大量连续内容块",
      hotkey: "⌥⇧'",
      callback: () => this.moveMarkedRange(),
      editorCallback: () => this.moveMarkedRange(),
      globalCallback: () => this.moveMarkedRange(),
    });
    this.addCommand({
      langKey: "siyuan-xunzhang-copy-range",
      langText: "批量复制大量连续内容块",
      hotkey: "⌥⇧Q",
      callback: () => this.copyMarkedRange(),
      editorCallback: () => this.copyMarkedRange(),
      globalCallback: () => this.copyMarkedRange(),
    });
  }

  trackActiveWindow() {
    const layouts = document.getElementById("layouts") || document.body;
    this.lastActivePart = document.querySelector(`.${ACTIVE_WND_CLASS}`);
    this.activeObserver = new MutationObserver((records) => {
      for (const record of records) {
        if (record.type !== "attributes" || record.attributeName !== "class") continue;
        const target = record.target;
        if (target?.classList?.contains(ACTIVE_WND_CLASS)) this.lastActivePart = target;
      }
    });
    this.activeObserver.observe(layouts, { attributes: true, childList: true, subtree: true });
  }

  rememberActiveBlock() {
    const blockId = getActiveBlockId(this.lastActivePart, "");
    if (blockId) this.lastActiveBlockId = blockId;
  }

  onKeyDown(event) {
    if (!event.defaultPrevented && (event.ctrlKey || event.metaKey) && !event.shiftKey && !event.altKey && String(event.key || "").toLowerCase() === "z") {
      if (this.batchUndoStack.length > 0) {
        event.preventDefault();
        event.stopPropagation();
        this.undoLastBatchOperation();
      }
      return;
    }
    if (event.defaultPrevented || !event.altKey) return;
    if (!event.shiftKey && (event.code === "Enter" || event.key === "Enter")) {
      event.preventDefault();
      event.stopPropagation();
      this.locateCurrentDoc();
      return;
    }
    if (!event.shiftKey) return;
    const key = String(event.key || "").toLowerCase();
    if (event.code === "Semicolon" || event.key === ";" || event.key === "；") {
      event.preventDefault();
      event.stopPropagation();
      this.deleteMarkedRange();
    } else if (event.code === "Quote" || event.key === "'" || event.key === "’") {
      event.preventDefault();
      event.stopPropagation();
      this.moveMarkedRange();
    } else if (event.code === "KeyQ" || key === "q") {
      event.preventDefault();
      event.stopPropagation();
      this.copyMarkedRange();
    }
  }

  onContentMenu({ detail }) {
    if (!detail?.menu) return;
    this.addBatchMenuItems(detail.menu);
  }

  onBlockMenu({ detail }) {
    if (!detail?.menu) return;
    this.addBatchMenuItems(detail.menu);
  }

  onTopBarContextMenu(event) {
    event.preventDefault();
    event.stopPropagation();
    this.openTopBarMenu(event);
  }

  addBatchMenuItems(menu) {
    menu.addItem({
      icon: "iconFocus",
      label: "定位当前打开文档",
      accelerator: "Alt+Enter",
      click: () => this.locateCurrentDoc(),
    });
    menu.addSeparator?.();
    menu.addItem({
      icon: "iconUndo",
      label: "撤销上一次批量操作",
      accelerator: "Ctrl+Z",
      click: () => this.undoLastBatchOperation(),
    });
    menu.addSeparator?.();
    menu.addItem({
      icon: "iconAdd",
      label: "插入开始标记：当前块前",
      click: () => this.insertMarkerBlock(MARK_START, "before"),
    });
    menu.addItem({
      icon: "iconAdd",
      label: "插入结束标记：当前块后",
      click: () => this.insertMarkerBlock(MARK_END, "after"),
    });
    menu.addItem({
      icon: "iconAdd",
      label: "插入目标标记：当前块后",
      click: () => this.insertMarkerBlock(MARK_TARGET, "after"),
    });
    menu.addItem({
      icon: "iconHelp",
      label: "标记说明：也兼容 aacc1/aacc2/aacc3",
      click: () => notify("可用标记：批量开始/批量结束/批量目标；也兼容 aacc1/aacc2/aacc3", false, 6000),
    });
    menu.addSeparator?.();
    menu.addItem({
      icon: "iconTrashcan",
      label: "删除：批量开始 到 批量结束",
      accelerator: "Alt+Shift+;",
      click: () => this.deleteMarkedRange(),
    });
    menu.addItem({
      icon: "iconMove",
      label: "移动：开始-结束 到 批量目标",
      accelerator: "Alt+Shift+'",
      click: () => this.moveMarkedRange(),
    });
    menu.addItem({
      icon: "iconCopy",
      label: "复制：开始-结束 到 批量目标",
      accelerator: "Alt+Shift+Q",
      click: () => this.copyMarkedRange(),
    });
  }

  openTopBarMenu() {
    const menu = new Menu("siyuan-xunzhang-menu");
    this.addBatchMenuItems(menu);
    const rect = this.topBarElement?.getBoundingClientRect();
    menu.open(rect && rect.width > 0 ? { x: rect.left, y: rect.bottom } : { x: 80, y: 48 });
  }

  async insertMarkerBlock(marker, position) {
    const text = MARK_ALIASES[marker]?.[1] || marker;
    try {
      this.rememberActiveBlock();
      const blockId = getActiveBlockId(this.lastActivePart, this.lastActiveBlockId);
      const docId = getActiveDocId(this.lastActivePart);
      if (!blockId && !docId) {
        notify("未找到当前光标所在块", true, 3500);
        return;
      }

      const payload = {
        dataType: "markdown",
        data: text,
      };
      if (blockId) {
        if (position === "before") payload.nextID = blockId;
        else payload.previousID = blockId;
      } else {
        payload.parentID = docId;
      }

      await api("/api/block/insertBlock", payload);
      await api("/api/sqlite/flushTransaction", {}).catch(() => null);
      notify(`已插入标记：${text}`, false, 2500);
    } catch (error) {
      console.error("[siyuan-xunzhang] insertMarkerBlock failed", error);
      notify(`插入标记失败：${error.message || error}`, true, 5000);
    }
  }

  pushBatchUndo(label, operations) {
    if (!operations?.length) return;
    this.batchUndoStack.push({ label, operations });
    if (this.batchUndoStack.length > 5) this.batchUndoStack.shift();
  }

  async undoLastBatchOperation() {
    const item = this.batchUndoStack.pop();
    if (!item) {
      notify("没有可撤销的批量操作", true, 2500);
      return;
    }
    try {
      await transactions(item.operations);
      await api("/api/sqlite/flushTransaction", {}).catch(() => null);
      notify(`已撤销：${item.label}`, false, 3000);
    } catch (error) {
      this.batchUndoStack.push(item);
      console.error("[siyuan-xunzhang] undoLastBatchOperation failed", error);
      notify(`撤销失败：${error.message || error}`, true, 5000);
    }
  }

  async locateCurrentDoc() {
    try {
      const docId = getActiveDocId(this.lastActivePart);
      if (!docId) {
        notify("未找到当前文档", true, 3000);
        return;
      }

      openFileDock();
      const fileDock = getFileDock();
      const info = await api("/api/block/getBlockInfo", { id: docId });
      if (fileDock?.selectItem && info?.box && info?.path) {
        fileDock.selectItem(info.box, info.path);
      }
      focusActiveWindow(this.lastActivePart);

      window.setTimeout(() => {
        const node = findFileTreeNode(docId);
        if (node) highlight(node);
      }, 80);

      notify("已突出定位当前文档", false, 1800);
    } catch (error) {
      console.error("[siyuan-xunzhang] locateCurrentDoc failed", error);
      await this.openBlock(getActiveDocId(this.lastActivePart));
      notify(`突出定位失败：${error.message || error}`, true, 4500);
    }
  }

  async openBlock(id) {
    if (!isBlockId(id)) return;
    if (getFrontend && String(getFrontend()).includes("mobile") && openMobileFileById) {
      openMobileFileById(window.siyuan.ws.app, id);
      return;
    }
    await openTab({
      app: this.app,
      doc: { id, action: ["cb-get-context", "cb-get-focus"], zoomIn: false },
      keepCursor: false,
      removeCurrentTab: false,
    });
  }

  async deleteMarkedRange() {
    return withLock(async () => {
      try {
        notify("批量删除正在检查数据...", false, 1600);
        const plan = await buildMarkerPlan(false);
        if (plan.error) {
          notify(plan.error, true, 4000);
          return;
        }
        const ok = await ask(
          "批量删除大量连续内容块",
          `将删除 ${markerLabel(MARK_START)} 到 ${markerLabel(MARK_END)} 之间的 ${plan.content.length} 个内容块，并删除两个标记行。确认继续？`,
        );
        if (!ok) return;

        const deletedIds = [plan.startId, ...plan.content.map((item) => item.id), plan.endId];
        const deletedDoms = [plan.startBlock, ...plan.content, plan.endBlock].map(blockDom);
        const undoOperations = transInsertBlocksAt(deletedDoms, plan.sourceRangeAnchor);
        await transactions(transDeleteBlocks(deletedIds));
        this.pushBatchUndo("批量删除", undoOperations);
        await api("/api/sqlite/flushTransaction", {}).catch(() => null);
        notify(`批量删除完成：${plan.content.length} 个内容块`, false, 3000);
      } catch (error) {
        console.error("[siyuan-xunzhang] deleteMarkedRange failed", error);
        notify(`批量删除失败：${error.message || error}`, true, 5000);
      }
    }, "批量删除");
  }

  async moveMarkedRange() {
    return withLock(async () => {
      try {
        notify("批量移动正在检查数据...", false, 1600);
        const plan = await buildMarkerPlan(true);
        if (plan.error) {
          notify(plan.error, true, 4000);
          return;
        }
        const contentIds = plan.content.map((item) => item.id);
        if ([plan.startId, plan.endId, ...contentIds].includes(plan.targetId)) {
          notify(`${markerLabel(MARK_TARGET)} 不能放在 ${markerLabel(MARK_START)}/${markerLabel(MARK_END)} 源范围内`, true, 4000);
          return;
        }
        const ok = await ask(
          "批量移动大量连续内容块",
          `将移动 ${contentIds.length} 个内容块到 ${MARK_TARGET} 位置，并删除三个标记行。确认继续？`,
        );
        if (!ok) return;

        const operations = [
          ...transMoveBlocksAfter(contentIds, plan.targetId),
          ...transDeleteBlocks([plan.startId, plan.endId, plan.targetId]),
        ];
        const undoOperations = [
          transInsertBlockAt(blockDom(plan.startBlock), plan.sourceRangeAnchor),
          ...transMoveBlocksAfter(contentIds, plan.startId),
          transInsertBlockAt(blockDom(plan.endBlock), { previousID: contentIds[contentIds.length - 1] }),
          transInsertBlockAt(blockDom(plan.targetBlock), plan.targetAnchor),
        ];
        await transactions(operations);
        this.pushBatchUndo("批量移动", undoOperations);
        await api("/api/sqlite/flushTransaction", {}).catch(() => null);
        await this.openBlock(contentIds[0]);
        notify(`批量移动完成：${contentIds.length} 个内容块`, false, 3000);
      } catch (error) {
        console.error("[siyuan-xunzhang] moveMarkedRange failed", error);
        notify(`批量移动失败：${error.message || error}`, true, 5000);
      }
    }, "批量移动");
  }

  async copyMarkedRange() {
    return withLock(async () => {
      try {
        notify("批量复制正在检查数据...", false, 1600);
        const plan = await buildMarkerPlan(true);
        if (plan.error) {
          notify(plan.error, true, 4000);
          return;
        }
        const ok = await ask(
          "批量复制大量连续内容块",
          `将复制 ${plan.content.length} 个内容块到 ${MARK_TARGET} 位置，并删除三个标记行。确认继续？`,
        );
        if (!ok) return;

        const clonedBlocks = plan.content.map((item) => cloneBlockElement(item.element));
        const operations = [
          ...transInsertBlocksAfter(clonedBlocks.map((item) => item.dom), plan.targetId),
          ...transDeleteBlocks([plan.startId, plan.endId, plan.targetId]),
        ];
        const undoOperations = [
          ...transDeleteBlocks(clonedBlocks.map((item) => item.id)),
          transInsertBlockAt(blockDom(plan.startBlock), plan.startAnchor),
          transInsertBlockAt(blockDom(plan.endBlock), plan.endAnchor),
          transInsertBlockAt(blockDom(plan.targetBlock), plan.targetAnchor),
        ];
        await transactions(operations);
        this.pushBatchUndo("批量复制", undoOperations);
        await api("/api/sqlite/flushTransaction", {}).catch(() => null);
        notify(`批量复制完成：${plan.content.length} 个内容块`, false, 3000);
      } catch (error) {
        console.error("[siyuan-xunzhang] copyMarkedRange failed", error);
        notify(`批量复制失败：${error.message || error}`, true, 5000);
      }
    }, "批量复制");
  }
}

module.exports = XunzhangPlugin;

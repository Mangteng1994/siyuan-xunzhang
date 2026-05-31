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
const PLUGIN_VERSION = "0.3.5";
const DEBUG_XUNZHANG = false;
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

function cleanMarkerText(value) {
  return String(value || "").replace(/[\s\u00a0\u200b\ufeff]/g, "").trim();
}

function normalizeMarker(value) {
  const text = cleanMarkerText(value);
  for (const [marker, aliases] of Object.entries(MARK_ALIASES)) {
    if (aliases.some((alias) => cleanMarkerText(alias) === text)) return marker;
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

function debugLog(scope, payload) {
  if (!DEBUG_XUNZHANG) return;
  console.info(`[siyuan-xunzhang][debug] ${scope}`, payload);
}

async function getBlockRow(id) {
  if (!isBlockId(id)) return null;
  const rows = await sql(`
    SELECT id, root_id, type, content, markdown
    FROM blocks
    WHERE id = '${escapeSql(id)}'
    LIMIT 1
  `);
  return rows[0] || null;
}

function wait(ms) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function markerStateList() {
  return [MARK_START, MARK_END, MARK_TARGET];
}

async function readMarkerRef(marker, ref, fallbackId = "") {
  const ids = uniq([ref?.id, fallbackId]).filter(isBlockId);
  for (const id of ids) {
    const row = await getBlockRow(id);
    if (!row) continue;
    const normalized = normalizeMarker(row.markdown || row.content);
    if (normalized !== marker) continue;
    return { ...row, marker: normalized };
  }
  return null;
}

async function resolveMarkerRefs(markerRefs = {}, markerBlockIds = {}) {
  const resolved = {};
  for (const marker of markerStateList()) {
    resolved[marker] = await readMarkerRef(marker, markerRefs?.[marker], markerBlockIds?.[marker]);
  }
  return resolved;
}

async function queryMarkerRows(rootId) {
  if (!isBlockId(rootId)) return [];
  const allAliases = uniq(Object.values(MARK_ALIASES).flat());
  const likeClauses = allAliases
    .map((value) => {
      const escaped = escapeSql(value).replaceAll("%", "\\%").replaceAll("_", "\\_");
      return `content LIKE '%${escaped}%' ESCAPE '\\' OR markdown LIKE '%${escaped}%' ESCAPE '\\'`;
    })
    .join("\n        OR ");
  const rows = await sql(`
    SELECT id, root_id, type, content, markdown
    FROM blocks
    WHERE root_id = '${escapeSql(rootId)}'
      AND (
        ${likeClauses}
      )
  `);
  return rows
    .map((row) => ({
      ...row,
      marker: normalizeMarker(row.markdown || row.content),
    }));
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

function describeActiveElement() {
  const element = document.activeElement;
  if (!element) return null;
  return {
    tagName: element.tagName || "",
    id: element.id || "",
    className: typeof element.className === "string" ? element.className : "",
    datasetNodeId: element.getAttribute?.("data-node-id") || "",
  };
}

function getCurrentBlockElement(preferredPart) {
  const selection = window.getSelection?.();
  const nodes = [selection?.anchorNode, selection?.focusNode];
  for (const node of nodes) {
    const block = getElementFromNode(node)?.closest?.(".protyle-wysiwyg [data-node-id]");
    if (block && (!preferredPart || preferredPart.contains(block))) return block;
  }

  const activeBlock = document.activeElement?.closest?.(".protyle-wysiwyg [data-node-id]");
  if (activeBlock && (!preferredPart || preferredPart.contains(activeBlock))) return activeBlock;

  const containers = [
    preferredPart,
    document.activeElement?.closest?.(".protyle"),
    document.activeElement?.closest?.(".layout__wnd"),
    document.querySelector(`.${ACTIVE_WND_CLASS}`),
  ].filter((container, index, list) => container && list.indexOf(container) === index);

  for (const container of containers) {
    const selected = container.querySelector?.(".protyle-wysiwyg--select[data-node-id]");
    if (selected) return selected;
  }
  return null;
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

async function inspectDocMarkers(docId) {
  if (!isBlockId(docId)) {
    return { docId, children: [], domChildren: [], domMarkers: [], sqlMarkers: [] };
  }
  const { children } = await getDocChildren(docId);
  const domChildren = children.map((child) => markerDebugRowFromChild(child, docId));
  return {
    docId,
    children,
    domChildren,
    domMarkers: domChildren.filter((row) => row.marker),
    sqlMarkers: await queryMarkerRows(docId),
  };
}

function findOrderedSourceMarkers(domMarkers, preferredStartId = "", preferredEndId = "") {
  const findById = (marker, id) => domMarkers.find((row) => row.marker === marker && row.id === id) || null;
  if (isBlockId(preferredStartId) && isBlockId(preferredEndId)) {
    const start = findById(MARK_START, preferredStartId);
    const end = findById(MARK_END, preferredEndId);
    const startIndex = start ? domMarkers.findIndex((row) => row.id === start.id) : -1;
    const endIndex = end ? domMarkers.findIndex((row) => row.id === end.id) : -1;
    return { start, end, hasOrderedPair: startIndex >= 0 && endIndex > startIndex };
  }
  if (isBlockId(preferredStartId)) {
    const start = findById(MARK_START, preferredStartId);
    const startIndex = start ? domMarkers.findIndex((row) => row.id === start.id) : -1;
    const end = startIndex >= 0 ? domMarkers.slice(startIndex + 1).find((row) => row.marker === MARK_END) || null : null;
    return { start, end, hasOrderedPair: Boolean(start && end) };
  }
  if (isBlockId(preferredEndId)) {
    const end = findById(MARK_END, preferredEndId);
    const endIndex = end ? domMarkers.findIndex((row) => row.id === end.id) : -1;
    const starts = endIndex >= 0 ? domMarkers.slice(0, endIndex).filter((row) => row.marker === MARK_START) : [];
    const start = starts[starts.length - 1] || null;
    return { start, end, hasOrderedPair: Boolean(start && end) };
  }
  const starts = domMarkers.filter((row) => row.marker === MARK_START);
  for (const start of starts) {
    const startIndex = domMarkers.findIndex((row) => row.id === start.id);
    const end = domMarkers.slice(startIndex + 1).find((row) => row.marker === MARK_END);
    if (end) return { start, end, hasOrderedPair: true };
  }
  return { start: starts[0] || null, end: null, hasOrderedPair: false };
}

function markerDebugRowFromChild(child, rootId) {
  const text = String(child?.element?.textContent || "");
  return {
    id: child?.id || "",
    root_id: rootId,
    type: child?.element?.getAttribute?.("data-type") || child?.element?.dataset?.type || "",
    content: text,
    markdown: text,
    marker: normalizeMarker(text),
  };
}

function markerDebugRows(rows) {
  return rows.map((row) => ({
    id: row.id,
    root_id: row.root_id,
    type: row.type,
    content: row.content,
    markdown: row.markdown,
    marker: row.marker,
  }));
}

function logMarkerDebug(scope, payload) {
  debugLog(scope, payload);
}

async function findMarkers(needsTarget, activeDocId, options = {}) {
  const preferredRefs = await resolveMarkerRefs(options.markerRefs, options.markerBlockIds);
  logMarkerDebug("findMarkers:input", { activeDocId, needsTarget, preferredRefs: markerDebugRows(Object.values(preferredRefs).filter(Boolean)) });

  const preferredStart = preferredRefs[MARK_START];
  const preferredEnd = preferredRefs[MARK_END];
  const preferredTarget = preferredRefs[MARK_TARGET];

  let sourceDocId = "";
  if (preferredStart?.root_id && preferredEnd?.root_id) {
    if (preferredStart.root_id !== preferredEnd.root_id) {
      return {
        error: "批量开始和批量结束必须在同一源文档",
        preferredRefs,
        sourceInspection: { docId: preferredStart.root_id, children: [], domChildren: [], domMarkers: [], sqlMarkers: [] },
        targetInspection: { docId: preferredTarget?.root_id || "", children: [], domChildren: [], domMarkers: [], sqlMarkers: [] },
      };
    }
    sourceDocId = preferredStart.root_id;
  } else if (preferredStart?.root_id || preferredEnd?.root_id) {
    sourceDocId = preferredStart?.root_id || preferredEnd?.root_id || "";
  } else if (isBlockId(activeDocId)) {
    sourceDocId = activeDocId;
  } else if (!needsTarget || !preferredTarget?.root_id) {
    logMarkerDebug("findMarkers:invalid-active-doc", { activeDocId, sqlMarkers: [], domMarkers: [], preferredRefs: markerDebugRows(Object.values(preferredRefs).filter(Boolean)) });
    return {
      error: "未能识别当前文档，请先点击正文后再操作",
      preferredRefs,
      sourceInspection: { docId: activeDocId, children: [], domChildren: [], domMarkers: [], sqlMarkers: [] },
      targetInspection: { docId: "", children: [], domChildren: [], domMarkers: [], sqlMarkers: [] },
    };
  }
  if (!isBlockId(sourceDocId)) {
    return {
      error: "未能识别当前文档，请先点击正文后再操作",
      preferredRefs,
      sourceInspection: { docId: sourceDocId, children: [], domChildren: [], domMarkers: [], sqlMarkers: [] },
      targetInspection: { docId: preferredTarget?.root_id || "", children: [], domChildren: [], domMarkers: [], sqlMarkers: [] },
    };
  }

  const sourceInspection = await inspectDocMarkers(sourceDocId);
  let targetInspection = { docId: "", children: [], domChildren: [], domMarkers: [], sqlMarkers: [] };
  const sourceResult = findOrderedSourceMarkers(sourceInspection.domMarkers, preferredStart?.id || "", preferredEnd?.id || "");

  if (needsTarget) {
    const targetDocId = preferredTarget?.root_id || (isBlockId(activeDocId) ? activeDocId : sourceDocId);
    targetInspection = targetDocId === sourceDocId ? sourceInspection : await inspectDocMarkers(targetDocId);
  }

  let target = null;
  if (needsTarget) {
    if (preferredTarget?.id) {
      target = targetInspection.domMarkers.find((row) => row.marker === MARK_TARGET && row.id === preferredTarget.id) || null;
    }
    if (!target && !preferredTarget?.id && targetInspection.docId) {
      target = targetInspection.domMarkers.find((row) => row.marker === MARK_TARGET) || null;
    }
    if (!target && isBlockId(activeDocId) && activeDocId !== targetInspection.docId) {
      const fallbackTargetInspection = activeDocId === sourceDocId ? sourceInspection : await inspectDocMarkers(activeDocId);
      target = fallbackTargetInspection.domMarkers.find((row) => row.marker === MARK_TARGET) || null;
      if (target) targetInspection = fallbackTargetInspection;
    }
  }

  logMarkerDebug("findMarkers:candidates", {
    activeDocId,
    sourceDocId,
    targetDocId: targetInspection.docId,
    preferredRefs: markerDebugRows(Object.values(preferredRefs).filter(Boolean)),
    sourceSqlMarkers: markerDebugRows(sourceInspection.sqlMarkers),
    sourceDomChildren: markerDebugRows(sourceInspection.domChildren),
    sourceDomMarkers: markerDebugRows(sourceInspection.domMarkers),
    targetSqlMarkers: markerDebugRows(targetInspection.sqlMarkers),
    targetDomChildren: markerDebugRows(targetInspection.domChildren),
    targetDomMarkers: markerDebugRows(targetInspection.domMarkers),
  });

  const result = {
    start: sourceResult.start || null,
    end: sourceResult.end || null,
    target: needsTarget ? target : null,
    hasOrderedPair: sourceResult.hasOrderedPair,
    preferredRefs,
    sourceInspection,
    targetInspection,
  };
  logMarkerDebug("findMarkers:result", {
    activeDocId,
    start: result.start,
    end: result.end,
    target: result.target,
    ordered: result.hasOrderedPair,
    sourceDocId,
    targetDocId: targetInspection.docId,
  });
  return result;
}

async function buildMarkerPlan(needsTarget, activeDocId, options = {}) {
  const {
    start,
    end,
    target,
    preferredRefs,
    sourceInspection,
    targetInspection,
    hasOrderedPair,
    error,
  } = await findMarkers(needsTarget, activeDocId, options);
  logMarkerDebug("buildMarkerPlan:input", {
    activeDocId,
    needsTarget,
    start: start || null,
    end: end || null,
    target: target || null,
    preferredRefs: markerDebugRows(Object.values(preferredRefs || {}).filter(Boolean)),
    sourceSqlMarkers: markerDebugRows(sourceInspection?.sqlMarkers || []),
    sourceDomMarkers: markerDebugRows(sourceInspection?.domMarkers || []),
    targetSqlMarkers: markerDebugRows(targetInspection?.sqlMarkers || []),
    targetDomMarkers: markerDebugRows(targetInspection?.domMarkers || []),
  });
  if (error) return { error };
  const sourceChildren = sourceInspection?.children || [];
  const targetChildren = targetInspection?.children || [];
  const sourceSqlMarkers = sourceInspection?.sqlMarkers || [];
  const sourceDomMarkers = sourceInspection?.domMarkers || [];
  const targetSqlMarkers = targetInspection?.sqlMarkers || [];
  const targetDomMarkers = targetInspection?.domMarkers || [];
  const sqlStarts = sourceSqlMarkers.filter((row) => row.marker === MARK_START);
  const sqlEnds = sourceSqlMarkers.filter((row) => row.marker === MARK_END);
  const sqlTargets = targetSqlMarkers.filter((row) => row.marker === MARK_TARGET);
  const domStarts = sourceDomMarkers.filter((row) => row.marker === MARK_START);
  const domEnds = sourceDomMarkers.filter((row) => row.marker === MARK_END);

  if (!domStarts.length) {
    return { error: sqlStarts.length ? "标记必须放在当前文档顶层独立段落中" : "未找到源文档中的完整开始/结束标记" };
  }
  if (!domEnds.length) {
    return { error: sqlEnds.length ? "标记必须放在当前文档顶层独立段落中" : "未找到源文档中的完整开始/结束标记" };
  }
  if (!hasOrderedPair || !start?.id || !end?.id) {
    return { error: `${markerLabel(MARK_START)}/${markerLabel(MARK_END)} 顺序错误，开始标记必须在结束标记之前` };
  }
  if (start.root_id !== end.root_id) return { error: "批量开始和批量结束必须在同一源文档" };
  if (needsTarget && !target?.id) {
    return { error: sqlTargets.length ? "标记必须放在当前文档顶层独立段落中" : "未找到目标标记，请在目标位置空行插入批量目标" };
  }
  const startIndex = sourceChildren.findIndex((child) => child.id === start.id);
  const endIndex = sourceChildren.findIndex((child) => child.id === end.id);
  if (startIndex < 0 || endIndex < 0 || startIndex >= endIndex) {
    return {
      error: sourceSqlMarkers.some((row) => row.id === start?.id || row.id === end?.id)
        ? "标记必须放在当前文档顶层独立段落中"
        : `${markerLabel(MARK_START)}/${markerLabel(MARK_END)} 顺序错误，开始标记必须在结束标记之前`,
    };
  }

  const content = sourceChildren.slice(startIndex + 1, endIndex);
  if (content.length === 0) return { error: `${markerLabel(MARK_START)} 到 ${markerLabel(MARK_END)} 之间没有可处理内容块` };

  const sourceDeletedIds = new Set([start.id, end.id, ...content.map((item) => item.id)]);
  const sourceAnchorExcludedIds = target?.root_id === start.root_id ? new Set([...sourceDeletedIds, target?.id].filter(Boolean)) : sourceDeletedIds;
  let targetBlock = null;
  let targetAnchor = null;
  if (needsTarget && target?.id) {
    const targetIndex = targetChildren.findIndex((child) => child.id === target.id);
    if (targetIndex < 0) return { error: targetSqlMarkers.some((row) => row.id === target.id) ? "标记必须放在当前文档顶层独立段落中" : "未找到目标标记，请在目标位置空行插入批量目标" };
    targetBlock = targetChildren[targetIndex];
    const targetExcludedIds = target.root_id === start.root_id ? new Set([...sourceDeletedIds, target.id]) : new Set([target.id]);
    targetAnchor = anchorAt(targetChildren, targetIndex, target.root_id, targetExcludedIds);
  }

  return {
    startId: start.id,
    endId: end.id,
    targetId: needsTarget ? target.id : "",
    sourceRootId: start.root_id,
    targetRootId: target?.root_id || "",
    startBlock: sourceChildren[startIndex],
    endBlock: sourceChildren[endIndex],
    sourceRangeAnchor: anchorAt(sourceChildren, startIndex, start.root_id, sourceAnchorExcludedIds),
    startAnchor: anchorAt(sourceChildren, startIndex, start.root_id, sourceAnchorExcludedIds),
    endAnchor: anchorAt(sourceChildren, endIndex, start.root_id, sourceAnchorExcludedIds),
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
    this.lastMarkerRootId = "";
    this.lastMarkerBlockIds = {};
    this.lastMarkerRefs = {};
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

  async resolveCurrentDocId() {
    this.rememberActiveBlock();
    const activeDocId = getActiveDocId(this.lastActivePart);
    if (isBlockId(activeDocId)) {
      debugLog("resolveCurrentDocId", {
        source: "activeDocId",
        activeDocId,
        lastActiveBlockId: this.lastActiveBlockId,
        lastMarkerRootId: this.lastMarkerRootId,
      });
      return activeDocId;
    }

    const activeBlockId = getActiveBlockId(this.lastActivePart, this.lastActiveBlockId);
    const activeBlock = await getBlockRow(activeBlockId);
    if (isBlockId(activeBlock?.root_id)) {
      debugLog("resolveCurrentDocId", {
        source: "activeBlock.root_id",
        activeDocId: activeBlock.root_id,
        activeBlockId,
        lastActiveBlockId: this.lastActiveBlockId,
        lastMarkerRootId: this.lastMarkerRootId,
      });
      return activeBlock.root_id;
    }

    const markerRefRootId = markerStateList().map((marker) => this.lastMarkerRefs?.[marker]?.rootId).find(isBlockId) || "";
    if (isBlockId(markerRefRootId)) {
      debugLog("resolveCurrentDocId", {
        source: "lastMarkerRefs.rootId",
        activeDocId: markerRefRootId,
        activeBlockId,
        lastActiveBlockId: this.lastActiveBlockId,
      });
      return markerRefRootId;
    }

    if (isBlockId(this.lastMarkerRootId)) {
      debugLog("resolveCurrentDocId", {
        source: "lastMarkerRootId",
        activeDocId: this.lastMarkerRootId,
        activeBlockId,
        lastActiveBlockId: this.lastActiveBlockId,
      });
      return this.lastMarkerRootId;
    }

    for (const markerBlockId of Object.values(this.lastMarkerBlockIds)) {
      const markerBlock = await getBlockRow(markerBlockId);
      if (isBlockId(markerBlock?.root_id)) {
        debugLog("resolveCurrentDocId", {
          source: "markerBlock.root_id",
          activeDocId: markerBlock.root_id,
          markerBlockId,
          lastActiveBlockId: this.lastActiveBlockId,
        });
        return markerBlock.root_id;
      }
    }

    debugLog("resolveCurrentDocId", {
      source: "empty",
      activeDocId,
      activeBlockId,
      lastActiveBlockId: this.lastActiveBlockId,
      lastMarkerRootId: this.lastMarkerRootId,
    });
    return activeDocId || "";
  }

  clearMarkerRefs(ids = []) {
    const deletedIds = new Set(ids.filter(isBlockId));
    if (!deletedIds.size) return;
    for (const marker of markerStateList()) {
      if (deletedIds.has(this.lastMarkerBlockIds?.[marker])) delete this.lastMarkerBlockIds[marker];
      if (deletedIds.has(this.lastMarkerRefs?.[marker]?.id)) delete this.lastMarkerRefs[marker];
    }
    const remainingRootId = markerStateList().map((marker) => this.lastMarkerRefs?.[marker]?.rootId).find(isBlockId) || "";
    if (!remainingRootId && !markerStateList().some((marker) => isBlockId(this.lastMarkerBlockIds?.[marker]))) this.lastMarkerRootId = "";
    else if (remainingRootId) this.lastMarkerRootId = remainingRootId;
  }

  async logOperationContext(operation, activeDocId) {
    debugLog("operation", {
      operation,
      activeDocId,
      lastActiveBlockId: this.lastActiveBlockId,
      hasLastActivePart: Boolean(this.lastActivePart),
      activeElement: describeActiveElement(),
    });
  }

  onKeyDown(event) {
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
      click: () => this.undoLastBatchOperation(),
    });
    menu.addSeparator?.();
    menu.addItem({
      icon: "iconAdd",
      label: "插入开始标记",
      click: () => this.insertMarkerBlock(MARK_START),
    });
    menu.addItem({
      icon: "iconAdd",
      label: "插入结束标记",
      click: () => this.insertMarkerBlock(MARK_END),
    });
    menu.addItem({
      icon: "iconAdd",
      label: "插入目标标记",
      click: () => this.insertMarkerBlock(MARK_TARGET),
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

  async insertMarkerBlock(marker) {
    const text = MARK_ALIASES[marker]?.[1] || marker;
    try {
      this.rememberActiveBlock();
      let blockId = "";
      let block = null;
      let currentBlock = null;
      let isDomEmpty = false;
      for (let attempt = 0; attempt < 5; attempt += 1) {
        currentBlock = getCurrentBlockElement(this.lastActivePart);
        blockId = currentBlock?.getAttribute?.("data-node-id") || getActiveBlockId(this.lastActivePart, attempt >= 2 ? this.lastActiveBlockId : "");
        if (!isBlockId(blockId)) {
          if (attempt < 4) await wait(60);
          continue;
        }
        block = await getBlockRow(blockId);
        isDomEmpty = cleanMarkerText(currentBlock?.textContent) === "";
        const isParagraph = !block || block.type === "p";
        const isSqlEmpty = cleanMarkerText(block?.markdown || block?.content) === "";
        if (isParagraph && (isSqlEmpty || isDomEmpty)) break;
        if (attempt < 4) await wait(60);
      }
      if (!isBlockId(blockId)) {
        notify("未找到当前光标所在块", true, 3500);
        return;
      }
      if ((!block || block.type !== "p") && !isDomEmpty) {
        notify("请先在目标位置新建空行，再插入标记", true, 3500);
        return;
      }
      if (block && block.type === "p" && cleanMarkerText(block.markdown || block.content) !== "" && !isDomEmpty) {
        notify("请先在目标位置新建空行，再插入标记", true, 3500);
        return;
      }

      const oldDomData = await api("/api/block/getBlockDOM", { id: blockId });
      const oldDom = oldDomData?.dom || "";
      if (!oldDom) {
        notify("读取当前空行失败，无法插入标记", true, 3500);
        return;
      }

      await api("/api/block/updateBlock", {
        id: blockId,
        dataType: "markdown",
        data: text,
      });
      const insertedBlock = (await getBlockRow(blockId)) || block;
      this.lastActiveBlockId = blockId;
      this.lastMarkerRootId = insertedBlock?.root_id || block?.root_id || "";
      this.lastMarkerBlockIds[marker] = blockId;
      this.lastMarkerRefs[marker] = {
        id: blockId,
        rootId: insertedBlock?.root_id || block?.root_id || "",
      };
      const undoOperations = [{ action: "update", id: blockId, data: oldDom }];
      this.pushBatchUndo("插入标记", undoOperations);
      api("/api/sqlite/flushTransaction", {}).catch(() => null);
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

  async runPluginUndoableTransaction(label, doOperations, undoOperations = []) {
    await transactions(doOperations, undoOperations);
    this.pushBatchUndo(label, undoOperations);
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
        const activeDocId = await this.resolveCurrentDocId();
        await this.logOperationContext("delete", activeDocId);
        const plan = await buildMarkerPlan(false, activeDocId, { markerRefs: this.lastMarkerRefs, markerBlockIds: this.lastMarkerBlockIds });
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
        await this.runPluginUndoableTransaction("批量删除", transDeleteBlocks(deletedIds), undoOperations);
        this.clearMarkerRefs([plan.startId, plan.endId]);
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
        const activeDocId = await this.resolveCurrentDocId();
        await this.logOperationContext("move", activeDocId);
        const plan = await buildMarkerPlan(true, activeDocId, { markerRefs: this.lastMarkerRefs, markerBlockIds: this.lastMarkerBlockIds });
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
        await this.runPluginUndoableTransaction("批量移动", operations, undoOperations);
        this.clearMarkerRefs([plan.startId, plan.endId, plan.targetId]);
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
        const activeDocId = await this.resolveCurrentDocId();
        await this.logOperationContext("copy", activeDocId);
        const plan = await buildMarkerPlan(true, activeDocId, { markerRefs: this.lastMarkerRefs, markerBlockIds: this.lastMarkerBlockIds });
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
        await this.runPluginUndoableTransaction("批量复制", operations, undoOperations);
        this.clearMarkerRefs([plan.startId, plan.endId, plan.targetId]);
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

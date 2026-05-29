# Xunzhang

A lightweight SiYuan plugin for document locating and marker-based batch organization.

Xunzhang focuses on a small set of actions: locate the current document, delete a marked range, move a marked range, and copy a marked range.

The idea comes from [IAliceBobI/sy-tomato-plugin](https://github.com/IAliceBobI/sy-tomato-plugin). Thanks to IAliceBobI.

## Features

- `Alt+Enter`: locate the current open document in the document tree
- `Alt+Shift+;`: delete continuous blocks between the start and end markers
- `Alt+Shift+'`: move continuous blocks between the start and end markers to the target marker
- `Alt+Shift+Q`: copy continuous blocks between the start and end markers to the target marker
- Right-click the top bar icon to open the locate, marker insertion, undo fallback, and batch operation menu

## Markers

Recommended markers:

- `批量开始`
- `批量结束`
- `批量目标`

Legacy markers are still supported:

- `aacc1`
- `aacc2`
- `aacc3`

## Usage

Delete a continuous range:

1. Create an empty paragraph before the first block of the range, put the cursor in it, right-click the Xunzhang top bar icon, and choose "Insert start marker".
2. Create an empty paragraph after the last block of the range, put the cursor in it, and choose "Insert end marker".
3. Run delete from the menu, or press `Alt+Shift+;`.

Move or copy a continuous range:

1. Insert the start and end markers as above.
2. Create an empty paragraph at the target position, put the cursor in it, and choose "Insert target marker".
3. Run move from the menu, or press `Alt+Shift+'`.
4. Run copy from the menu, or press `Alt+Shift+Q`.

Marker lines are removed after each operation.

## Undo

Xunzhang keeps a plugin-level undo stack for the latest 5 plugin operations. After inserting markers or running batch delete, move, or copy, use the top bar context menu item "Undo latest batch operation" to undo it.

Xunzhang does not intercept `Ctrl+Z` / `Cmd+Z`. Native editor undo remains handled by SiYuan.

The undo stack only records new operations performed while the plugin is loaded. Operations performed before a reload or restart cannot be restored automatically.

## Changelog

### v0.3.3

- Keep `Ctrl+Z` / `Cmd+Z` fully handled by SiYuan. Xunzhang no longer globally intercepts editor undo shortcuts.
- Keep a plugin-level undo stack for marker insertion, batch delete, batch move, and batch copy. The top bar context menu undo item is the only Xunzhang undo entry.
- Limit batch operations to markers in the current open document to avoid registering undo history on the wrong document.
- Change marker insertion to update the current empty paragraph only. It no longer creates a new paragraph before or after the current block.
- Reject marker insertion in non-empty paragraphs with a prompt to create an empty line first.
- Fix marker insertion so it uses SiYuan's block update API and valid DOM undo data, avoiding abnormal block structure and broken context menus.
- Remove the "marker help" menu item while keeping legacy marker compatibility for `aacc1`, `aacc2`, and `aacc3`.

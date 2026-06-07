# Xunzhang

A lightweight SiYuan plugin for document locating and marker-based batch organization.

Xunzhang focuses on a small set of actions: locate the current document, delete a marked range, move a marked range, and copy a marked range.

The idea comes from [IAliceBobI/sy-tomato-plugin](https://github.com/IAliceBobI/sy-tomato-plugin). Thanks to IAliceBobI.

## Features

- `Alt+Enter`: locate the current open document in the document tree
- `Alt+Shift+;`: delete continuous blocks between the start and end markers
- `Alt+Shift+'`: move continuous blocks between the start and end markers to the target marker
- `Alt+Shift+Q`: copy continuous blocks between the start and end markers to the target marker
- `Alt+Shift+C`: copy continuous blocks between the start and end markers to the system clipboard
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

Copy a continuous range to the clipboard:

1. Insert the start and end markers as above.
2. Run "Copy: start-end to clipboard" from the menu, or press `Alt+Shift+C`.

Delete, move, and copy-to-target remove marker lines after each operation. Copy-to-clipboard does not need `批量目标`, does not remove markers, and does not modify the document.

## Undo

Xunzhang keeps a plugin-level undo stack for the latest 5 plugin operations. After inserting markers or running batch delete, move, or copy, use the top bar context menu item "Undo latest batch operation" to undo it.

Xunzhang does not intercept `Ctrl+Z` / `Cmd+Z`. Native editor undo remains handled by SiYuan.

The undo stack only records new operations performed while the plugin is loaded. Operations performed before a reload or restart cannot be restored automatically.

## Changelog

### v0.3.7

- Add `Alt+Shift+C` to copy continuous blocks between `批量开始` and `批量结束` to the system clipboard.
- Copy Markdown text to the clipboard, with `text/plain` fallback when `text/markdown` is unavailable.
- Preserve paragraph breaks, ordered lists, unordered lists, task lists, tables, images, heading levels, blockquotes, code blocks, and math blocks as Markdown where possible.
- Clipboard copy does not need `批量目标`, does not remove markers, and does not modify the document.

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

Batch delete, move, copy, and marker insertion are added to SiYuan's native document undo stack when the active editor can be found.

- Press `Ctrl+Z` in the same document to follow SiYuan's native undo order
- If no active editor is available, Xunzhang keeps a fallback plugin-level undo stack for the last 5 batch operations
- Right-click the top bar icon and choose the undo menu item to use the fallback stack

The fallback stack only records new operations performed while the plugin is loaded. Operations performed before a reload or restart cannot be restored automatically.

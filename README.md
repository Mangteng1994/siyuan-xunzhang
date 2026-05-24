# Xunzhang

A lightweight SiYuan plugin for document locating and marker-based batch organization.

Xunzhang focuses on a small set of actions: locate the current document, delete a marked range, move a marked range, and copy a marked range.

The idea comes from [IAliceBobI/sy-tomato-plugin](https://github.com/IAliceBobI/sy-tomato-plugin). Thanks to IAliceBobI.

## Features

- `Alt+Enter`: locate the current open document in the document tree
- `Alt+Shift+;`: delete continuous blocks between the start and end markers
- `Alt+Shift+'`: move continuous blocks between the start and end markers to the target marker
- `Alt+Shift+Q`: copy continuous blocks between the start and end markers to the target marker
- Right-click the top bar icon to open the locate, marker insertion, undo, and batch operation menu

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

1. Put the cursor in the first block of the range, right-click the Xunzhang top bar icon, and choose "Insert start marker before current block".
2. Put the cursor in the last block of the range and choose "Insert end marker after current block".
3. Run delete from the menu, or press `Alt+Shift+;`.

Move or copy a continuous range:

1. Insert the start and end markers as above.
2. Put the cursor at the target position and choose "Insert target marker after current block".
3. Run move from the menu, or press `Alt+Shift+'`.
4. Run copy from the menu, or press `Alt+Shift+Q`.

Marker lines are removed after each operation.

## Undo

Xunzhang keeps a plugin-level undo stack for the last 5 batch operations.

- Press `Ctrl+Z` to undo the latest batch delete, move, or copy
- Or right-click the top bar icon and choose the undo menu item

The undo stack only records new operations performed while the plugin is loaded. Operations performed before a reload or restart cannot be restored automatically.

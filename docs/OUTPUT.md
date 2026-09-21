# Shell Output Colours

The `spec` editor highlights Markdown in the left output pane for both shell
commands (`Ctrl-E`) and saved-spec builds (`Ctrl-R`). Headings are cyan,
emphasis is magenta, inline and fenced code are yellow, links are blue, and
list markers and block quotes are green. Markdown source markers remain visible.
This is lightweight highlighting, not a full Markdown preview or code-language
syntax highlighter.

Highlighting updates as output arrives, including incomplete lines. Code fences
remain active when their opening line scrolls off screen or leaves the bounded
scrollback. Colour resets before the pane separator, so it cannot affect the
editable document. Unicode text is clipped at whole grapheme boundaries.

Set `NO_COLOR=1` to disable highlighting. Raw terminal escape sequences from
commands remain filtered from the pane; only editor-generated colours are
displayed. Highlighting does not alter command output or saved logs.

After a release build, run `python3 tests/markdown-pty.py` to check colours,
`NO_COLOR`, and terminal-control filtering through a real shell command.

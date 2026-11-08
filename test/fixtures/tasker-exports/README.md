# Tasker exports

Real XML exported from Tasker 6.7.8 on a device, kept as reference for the
XML generated into `tasker-effect.prj.xml`.

- `clipboard-history.prf.xml`: the Clipboard History profile; reference for
  the user profile wiring inside the project XML.
  - Event **Clipboard Changed** is code `2097`; `arg1` (Int) is
    "Ignore Set By Tasker".
  - An **App** context with `<flags>2</flags>` is inverted ("Not Bitwarden").
  - The exported `TE Dispatch` task has no `<rty>`, i.e. collision handling
    is "Abort New Task": a second trigger while it runs is dropped.
- `show-clipboard-history.tsk.xml`: a hand-written task (imported fine)
  that runs `TE Dispatch` with `%par1` = `Show Clipboard History` via
  Perform Task (action code `130`); reference for the Perform Task argument
  layout (used by `TE Menu`).

# Tasker exports

Real XML exported from Tasker 6.7.8 on a device, kept as reference for the
XML generated into `tasker-effect.prj.xml`.

- `clipboard-history.prf.xml`: the Clipboard History profile; reference for
  the user profile wiring inside the project XML.
  - Event **Clipboard Changed** is code `2097`; `arg1` (Int) is
    "Ignore Set By Tasker".
  - An **App** context with `<flags>2</flags>` is inverted ("Not Bitwarden").
  - The exported `TE Dispatch` task has no `<rty>`, i.e. collision handling
    is "Abort New Task": a second trigger while it runs is dropped. The
    generated profile tasks therefore set `<rty>2</rty>` (Run Both Together).
- `show-clipboard-history.tsk.xml`: a hand-written task (imported fine)
  that runs `TE Dispatch` with `%par1` = `Show Clipboard History` via
  Perform Task (action code `130`); reference for the Perform Task argument
  layout (used by `TE Menu`).
- `http-download-unzip.tsk.xml`: excerpt (actions only, wrapped in a task)
  of a third-party Tasker 6.7.6 project export,
  [`x-mrrobot-x/routine-flow` `tasker/ROUTINE_FLOW.prj.xml`](https://github.com/x-mrrobot-x/routine-flow/blob/1f8703e97de73e19425f21e6d876ceb8aa34d362/tasker/ROUTINE_FLOW.prj.xml)
  (task "RF 11 - DOWNLOAD WEBVIEW DEPENDENCIES"'s act4-act6 plus
  "RF 06 - HANDLE ACTIONS"'s act0, renumbered act7). Reference for
  `TE Sync`'s download + unzip actions.
  - **HTTP Request** is code `339`; args in lexical order (arg0 the
    RELEVANT_VARIABLES bundle, arg1 method 0 = GET, arg10 follow redirects,
    arg11 use cookies, arg12 structure output, arg2 URL, arg3 headers, arg4
    query, arg5 body, arg6 file to send, arg7 file to save with output, arg8
    timeout, arg9 trust any certificate). `<se>false</se>` = continue the
    task after an error.
  - **UnZip** is code `422`: arg0 the zip path, arg1 Delete Zip. It
    extracts into the zip's own directory.
  - The `If` (37) checks `%http_response_code` with `<op>8</op>` (maths
    "="), rhs `200`.
  - The renumbered act7 (Stop, code 137) shows an **action-level
    condition**: the same `<ConditionList sr="if">` placed after the
    action's arguments.

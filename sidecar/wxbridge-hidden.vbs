' Launch start-wxbridge.cmd without a visible console window.
' Intended for a logon scheduled task, so the bridge comes back after a reboot.
' It must run in the interactive desktop session: the sidecar drives the WeChat client through
' UI Automation, which only sees windows in the session it runs in.
Set shell = CreateObject("WScript.Shell")
shell.Run "cmd /c """ & CreateObject("Scripting.FileSystemObject").GetParentFolderName(WScript.ScriptFullName) & "\start-wxbridge.cmd""", 0, False

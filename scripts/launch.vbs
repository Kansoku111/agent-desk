' Agent Desk launcher for the Start menu / taskbar shortcut.
' Runs scripts\launch.mjs without a console window.
' Argument 1 (optional): full path of node.exe; otherwise node from PATH.
Option Explicit
Dim shell, fso, root, node, code
Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
root = fso.GetParentFolderName(fso.GetParentFolderName(WScript.ScriptFullName))
node = "node"
If WScript.Arguments.Count > 0 Then
  If fso.FileExists(WScript.Arguments(0)) Then node = WScript.Arguments(0)
End If
shell.CurrentDirectory = root
code = shell.Run("""" & node & """ """ & root & "\scripts\launch.mjs""", 0, True)
If code <> 0 Then
  MsgBox "Agent Desk could not start." & vbCrLf & vbCrLf & _
    "Details: %APPDATA%\AgentDesk\launcher.log", vbExclamation, "Agent Desk"
End If

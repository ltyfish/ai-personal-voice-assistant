' bridge-autostart.vbs — launch the JARVIS local bridge hidden at login.
' Resolves the project root from this script's own location so it keeps working
' even though the Startup-folder entry is only a shortcut pointing here.
Set fso = CreateObject("Scripting.FileSystemObject")
scriptDir  = fso.GetParentFolderName(WScript.ScriptFullName)            ' ...\scripts\bridge
projectDir = fso.GetParentFolderName(fso.GetParentFolderName(scriptDir)) ' project root
Set shell = CreateObject("WScript.Shell")
shell.CurrentDirectory = projectDir
' window style 0 = hidden, False = don't wait. Runs in the interactive desktop
' session (so Start-Process can still launch GUI apps); only the console is hidden.
' dev.mjs starts BOTH the Next web server (localhost:3000, which the pipeline's
' /api/pipeline/prep lives on) AND the bridge. Without the web server the pipeline
' fails with "Couldn't reach the server to prepare the phase (fetch failed)".
' A duplicate bridge instance exits cleanly if the port is already owned.
shell.Run "cmd /c node scripts\dev.mjs", 0, False

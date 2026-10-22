' Starts the autopilot without a black console window on screen.
Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
here = fso.GetParentFolderName(WScript.ScriptFullName)
shell.CurrentDirectory = here
shell.Run "python -I """ & here & "\amitek_autopilot.py""", 0, False

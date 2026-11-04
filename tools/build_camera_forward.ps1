# Compiles camera_forward.cs into camera_forward.exe with the C# compiler that ships with Windows.
$csc = "$env:WINDIR\Microsoft.NET\Framework64\v4.0.30319\csc.exe"
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
& $csc /nologo /target:exe /out:"$here\camera_forward.exe" "$here\camera_forward.cs"

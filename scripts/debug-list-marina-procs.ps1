foreach ($p in Get-CimInstance Win32_Process -Filter "Name='Marina.exe' or Name='Marina-Portable-0.3.3-dev.11.exe' or Name like 'Marina-Portable%'") {
  $cmd = $p.CommandLine; if ($cmd -and $cmd.Length -gt 150) { $cmd = $cmd.Substring(0,150) }
  "PID=$($p.ProcessId) PPID=$($p.ParentProcessId) NAME=$($p.Name) CMD=$cmd"
}

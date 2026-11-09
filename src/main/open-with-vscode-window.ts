import { execFile } from 'node:child_process'
import path from 'node:path'

/** Earlier Aether versions started Code with SW_HIDE. Code forwards a repeated
 * folder request to that hidden window without showing it, even through its
 * official CLI. Recover only an identifiable window from that exact launch. */
const recoveryScript = String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
function Result([string]$status) { [pscustomobject]@{status=$status} | ConvertTo-Json -Compress }
$observedHidden = $false
try {
  Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Security.Principal;
public static class AetherCodeWindow {
  public delegate bool Callback(IntPtr handle, IntPtr state);
  [DllImport("user32.dll")] static extern bool EnumWindows(Callback callback, IntPtr state);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr handle, out uint processId);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr handle);
  [DllImport("user32.dll")] static extern IntPtr GetWindow(IntPtr handle, uint command);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetWindowText(IntPtr handle, StringBuilder text, int count);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetClassName(IntPtr handle, StringBuilder text, int count);
  [DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr handle, int command);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr handle);
  [DllImport("shell32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern IntPtr CommandLineToArgvW(string commandLine, out int count);
  [DllImport("kernel32.dll")] static extern IntPtr LocalFree(IntPtr pointer);
  [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr OpenProcess(uint access, bool inherit, uint processId);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode)] static extern bool QueryFullProcessImageName(IntPtr process, uint flags, StringBuilder name, ref int count);
  [DllImport("advapi32.dll")] static extern bool OpenProcessToken(IntPtr process, uint access, out IntPtr token);
  [DllImport("advapi32.dll")] static extern bool GetTokenInformation(IntPtr token, int type, IntPtr info, int size, out int needed);
  [DllImport("ntdll.dll")] static extern int NtQueryInformationProcess(IntPtr process, int type, IntPtr info, int size, out int needed);
  [StructLayout(LayoutKind.Sequential)] struct UnicodeString { public ushort Length; public ushort MaximumLength; public IntPtr Buffer; }
  public class ProcessInfo { public string Executable; public string CommandLine; public string OwnerSid; }
  public static ProcessInfo ReadProcess(uint processId) {
    var process = OpenProcess(0x1000, false, processId);
    if (process == IntPtr.Zero) return null;
    IntPtr token=IntPtr.Zero, tokenInfo=IntPtr.Zero, commandInfo=IntPtr.Zero;
    try {
      var executable=new StringBuilder(32768); int count=executable.Capacity;
      if (!QueryFullProcessImageName(process, 0, executable, ref count) || !OpenProcessToken(process, 8, out token)) return null;
      int needed; GetTokenInformation(token, 1, IntPtr.Zero, 0, out needed);
      if (needed <= 0 || needed > 65536) return null;
      tokenInfo=Marshal.AllocHGlobal(needed);
      if (!GetTokenInformation(token, 1, tokenInfo, needed, out needed)) return null;
      var owner=new SecurityIdentifier(Marshal.ReadIntPtr(tokenInfo)).Value;
      string commandLine=null; NtQueryInformationProcess(process, 60, IntPtr.Zero, 0, out needed);
      if (needed > 0 && needed <= 131072) {
        commandInfo=Marshal.AllocHGlobal(needed);
        if (NtQueryInformationProcess(process, 60, commandInfo, needed, out needed) == 0) {
          var value=(UnicodeString)Marshal.PtrToStructure(commandInfo, typeof(UnicodeString));
          if (value.Buffer != IntPtr.Zero) commandLine=Marshal.PtrToStringUni(value.Buffer, value.Length/2);
        }
      }
      return new ProcessInfo {Executable=executable.ToString(), CommandLine=commandLine, OwnerSid=owner};
    } finally {
      if (commandInfo != IntPtr.Zero) Marshal.FreeHGlobal(commandInfo);
      if (tokenInfo != IntPtr.Zero) Marshal.FreeHGlobal(tokenInfo);
      if (token != IntPtr.Zero) CloseHandle(token);
      CloseHandle(process);
    }
  }
  public class Window { public IntPtr Handle; public uint ProcessId; public string Title; public bool Visible; }
  public static Window[] Read() {
    var windows = new List<Window>();
    EnumWindows((handle, state) => {
      if (GetWindow(handle, 4) != IntPtr.Zero) return true;
      var type = new StringBuilder(256); GetClassName(handle, type, type.Capacity);
      if (type.ToString() != "Chrome_WidgetWin_1") return true;
      var title = new StringBuilder(2048); GetWindowText(handle, title, title.Capacity);
      if (title.Length == 0) return true;
      uint processId; GetWindowThreadProcessId(handle, out processId);
      windows.Add(new Window { Handle=handle, ProcessId=processId, Title=title.ToString(), Visible=IsWindowVisible(handle) });
      return true;
    }, IntPtr.Zero);
    return windows.ToArray();
  }
  public static string[] Arguments(string commandLine) {
    int count; var pointer = CommandLineToArgvW(commandLine, out count);
    if (pointer == IntPtr.Zero) return new string[0];
    try { var args = new string[count]; for (int i=0; i<count; i++) args[i]=Marshal.PtrToStringUni(Marshal.ReadIntPtr(pointer, i*IntPtr.Size)); return args; }
    finally { LocalFree(pointer); }
  }
}
'@
  function Normalize([string]$value) {
    if ([string]::IsNullOrWhiteSpace($value)) { return $null }
    if ($value.StartsWith('file:', [StringComparison]::OrdinalIgnoreCase)) {
      $uri = $null
      if (![Uri]::TryCreate($value, [UriKind]::Absolute, [ref]$uri) -or !$uri.IsFile) { return $null }
      $value = $uri.LocalPath
    }
    if (![IO.Path]::IsPathRooted($value)) { return $null }
    try { return [IO.Path]::GetFullPath($value).TrimEnd([char[]]@('\','/')) } catch { return $null }
  }
  function HasProjectArgument([string]$commandLine, [string]$target) {
    if (!$commandLine) { return $false }
    $arguments = [AetherCodeWindow]::Arguments($commandLine)
    $valueOptions = @('--user-data-dir','--extensions-dir','--locale','--profile','--log','--logsPath','--remote','--file-uri','--inspect','--inspect-brk','--inspect-extensions','--inspect-brk-extensions')
    for ($index=1; $index -lt $arguments.Length; $index++) {
      $argument = $arguments[$index]
      if ($valueOptions -contains $argument) { $index++; continue }
      if ($argument.StartsWith('--folder-uri=')) { $argument = $argument.Substring(13) }
      elseif ($argument -eq '--folder-uri') { $index++; if ($index -ge $arguments.Length) { break }; $argument=$arguments[$index] }
      elseif ($argument.StartsWith('-')) { continue }
      $candidate = Normalize $argument
      if ($candidate -and [string]::Equals($candidate, $target, [StringComparison]::OrdinalIgnoreCase)) { return $true }
    }
    return $false
  }
  $expectedExe = Normalize $env:AETHER_OPEN_WITH_EXECUTABLE
  $target = Normalize $env:AETHER_OPEN_WITH_DIRECTORY
  $projectName = [IO.Path]::GetFileName($target)
  if (!$expectedExe -or !$target -or !$projectName) { Result 'unchanged'; exit }
  $currentSid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
  $titlePattern = '(?:^| - )' + [regex]::Escape($projectName) + ' - Visual Studio Code(?: \[[^\]]+\])?$'
  $candidates = @()
  foreach ($window in [AetherCodeWindow]::Read()) {
    if ($window.Title -notmatch $titlePattern) { continue }
    $process = [AetherCodeWindow]::ReadProcess($window.ProcessId)
    if (!$process -or ![string]::Equals((Normalize $process.Executable), $expectedExe, [StringComparison]::OrdinalIgnoreCase) -or $process.OwnerSid -ne $currentSid) { continue }
    if (!$window.Visible) { $observedHidden = $true }
    $candidates += [pscustomobject]@{window=$window;verified=(HasProjectArgument $process.CommandLine $target)}
  }
  $hidden = @($candidates | Where-Object { !$_.window.Visible })
  if ($hidden.Count -eq 0) { Result 'unchanged'; exit }
  if ($candidates.Count -ne 1) { Result 'ambiguous'; exit }
  if (!$hidden[0].verified) { Result 'unverified'; exit }
  $selected = $hidden[0].window
  # Re-read the handle and process just before changing visibility; HWNDs and
  # process ids may be recycled while the helper yields to a terminating editor.
  $fresh = @([AetherCodeWindow]::Read() | Where-Object { $_.Handle -eq $selected.Handle -and $_.ProcessId -eq $selected.ProcessId -and $_.Title -eq $selected.Title })
  $process = [AetherCodeWindow]::ReadProcess($selected.ProcessId)
  if ($fresh.Count -ne 1 -or !$process -or ![string]::Equals((Normalize $process.Executable), $expectedExe, [StringComparison]::OrdinalIgnoreCase) -or $process.OwnerSid -ne $currentSid -or !(HasProjectArgument $process.CommandLine $target)) { Result 'unverified'; exit }
  if ([AetherCodeWindow]::IsWindowVisible($selected.Handle)) { Result 'unchanged'; exit }
  [void][AetherCodeWindow]::ShowWindowAsync($selected.Handle, 9)
  $until = [DateTime]::UtcNow.AddMilliseconds(600)
  while (![AetherCodeWindow]::IsWindowVisible($selected.Handle) -and [DateTime]::UtcNow -lt $until) { Start-Sleep -Milliseconds 30 }
  if (![AetherCodeWindow]::IsWindowVisible($selected.Handle)) { Result 'failed'; exit }
  [void][AetherCodeWindow]::SetForegroundWindow($selected.Handle)
  Result 'recovered'
} catch { if ($observedHidden) { Result 'unverified' } else { Result 'unchanged' } }
`

export function recoverHiddenVSCodeWindow(executable: string, directory: string): Promise<void> {
  const windows = process.env.SystemRoot ?? process.env.WINDIR
  if (!windows || !path.win32.isAbsolute(windows)) return Promise.resolve()
  return new Promise((resolve, reject) => {
    execFile(path.win32.join(windows, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'), [
      '-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(recoveryScript, 'utf16le').toString('base64')
    ], {
      windowsHide: true, timeout: 6000, maxBuffer: 16 * 1024, encoding: 'utf8',
      env: { ...process.env, AETHER_OPEN_WITH_EXECUTABLE: executable, AETHER_OPEN_WITH_DIRECTORY: directory }
    }, (error, stdout) => {
      let status: unknown
      try { status = (JSON.parse(stdout.replace(/^\uFEFF/, '').trim()) as { status?: unknown }).status } catch { /* Never treat a broken helper as proof of visible UI. */ }
      // The launch already succeeded. Optional inspection cannot turn an
      // otherwise normal editor launch into a failure without a hidden match.
      if (error || !['ambiguous', 'unverified', 'failed'].includes(String(status))) { resolve(); return }
      if (status === 'ambiguous') { reject(new Error('VS Code 中存在多个同名项目窗口，无法安全确认要恢复哪一个。请在 VS Code 中选择目标窗口。')); return }
      reject(new Error('VS Code 已接收打开请求，但无法安全恢复目标项目的隐藏窗口。请先在 VS Code 中恢复该窗口后重试。'))
    })
  })
}

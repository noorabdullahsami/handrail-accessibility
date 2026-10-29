# Presses the extension's keyboard shortcut (Alt+Shift+K) in the test Chrome
# window, the way a real user would. Used by the end-to-end test because
# automation tools cannot click the toolbar icon.
# Safety: keys are only sent if the test window is confirmed to be in front,
# so they can never land in another app.
param([Parameter(Mandatory = $true)][string]$TitlePart)

Add-Type @"
using System;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public static class Win {
  public delegate bool EnumProc(IntPtr h, IntPtr p);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr p);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, int flags, int extra);
  public static List<KeyValuePair<IntPtr, string>> Visible() {
    var list = new List<KeyValuePair<IntPtr, string>>();
    EnumWindows((h, p) => {
      if (IsWindowVisible(h)) {
        var sb = new StringBuilder(512);
        GetWindowText(h, sb, 512);
        uint pid; GetWindowThreadProcessId(h, out pid);
        list.Add(new KeyValuePair<IntPtr, string>(h, pid + "|" + sb.ToString()));
      }
      return true;
    }, IntPtr.Zero);
    return list;
  }
}
"@

# Only Chrome for Testing processes started by Puppeteer count.
$testPids = @(Get-Process chrome -ErrorAction SilentlyContinue |
  Where-Object { $_.Path -like '*puppeteer*' } | ForEach-Object { [string]$_.Id })

# The window title can lag behind the page, so retry for a few seconds.
$h = [IntPtr]::Zero
for ($i = 0; $i -lt 20 -and $h -eq [IntPtr]::Zero; $i++) {
  foreach ($w in [Win]::Visible()) {
    $parts = $w.Value.Split('|', 2)
    if ($testPids -contains $parts[0] -and $parts[1] -like "*$TitlePart*") { $h = $w.Key; break }
  }
  if ($h -eq [IntPtr]::Zero) { Start-Sleep -Milliseconds 250 }
}
if ($h -eq [IntPtr]::Zero) { Write-Output "NO_WINDOW for title '$TitlePart'. Test pids: $($testPids -join ',')"; [Win]::Visible() | ForEach-Object { Write-Output $_.Value }; exit 2 }

# Tapping Alt lets this process move another window to the front.
# Windows sometimes refuses, so try a few times.
for ($try = 0; $try -lt 5 -and [Win]::GetForegroundWindow() -ne $h; $try++) {
  [Win]::keybd_event(0x12, 0, 0, 0); [Win]::keybd_event(0x12, 0, 2, 0)
  [Win]::ShowWindow($h, 9) | Out-Null
  [Win]::SetForegroundWindow($h) | Out-Null
  Start-Sleep -Milliseconds 400
}
if ([Win]::GetForegroundWindow() -ne $h) { Write-Output 'NOT_FOREGROUND'; exit 3 }

Add-Type -AssemblyName System.Windows.Forms
[System.Windows.Forms.SendKeys]::SendWait('%+k')
Write-Output 'SENT'

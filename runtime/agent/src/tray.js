import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import koffi from "koffi";

const here = path.dirname(fileURLToPath(import.meta.url));
const agentRoot = path.resolve(here, "..");

const user32 = koffi.load("user32.dll");
const kernel32 = koffi.load("kernel32.dll");
const GetConsoleWindow = kernel32.func("void * __stdcall GetConsoleWindow()");
const ShowWindow = user32.func("bool __stdcall ShowWindow(void *hWnd, int32 nCmdShow)");

export function hideConsole() {
  const hwnd = GetConsoleWindow();
  if (hwnd) ShowWindow(hwnd, 0);
}

export function claimSingleInstance() {
  if (process.platform !== "win32") return true;
  try {
    const CreateMutexW = kernel32.func("void * __stdcall CreateMutexW(void *lpMutexAttributes, int32 bInitialOwner, const char16 *lpName)");
    const GetLastError = kernel32.func("uint32 __stdcall GetLastError()");
    CreateMutexW(null, 1, "Local\\PCRemote.Agent");
    return GetLastError() !== 183;
  } catch {
    return true;
  }
}

export function startTray({ dashboard, onExit }) {
  const icon = path.join(agentRoot, "icon.ico");
  const script = path.join(agentRoot, "tray.ps1");
  if (!existsSync(script)) return null;

  try {
    spawn(
      "powershell.exe",
      [
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-Command",
        `Unblock-File -LiteralPath '${script.replace(/'/g, "''")}'`,
      ],
      { windowsHide: true, stdio: "ignore" },
    );
  } catch {
    // still try to start the tray
  }

  const child = spawn(
    "powershell.exe",
    [
      "-NoProfile",
      "-STA",
      "-ExecutionPolicy",
      "Bypass",
      "-WindowStyle",
      "Hidden",
      "-File",
      script,
      "-ParentPid",
      String(process.pid),
      "-Icon",
      icon,
      "-Dashboard",
      dashboard,
    ],
    { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] },
  );
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk) => {
    const text = String(chunk).trim();
    if (text) console.warn("tray:", text);
  });
  child.on("exit", (code) => {
    if (code) console.warn("tray exited", code);
  });

  let buffer = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() || "";
    for (const line of lines) {
      if (line.trim() === "EXIT") onExit?.();
    }
  });

  const stop = () => {
    try {
      child.kill();
    } catch {
      // already gone
    }
  };
  process.on("exit", stop);
  process.on("SIGINT", () => {
    stop();
    process.exit(0);
  });
  return child;
}

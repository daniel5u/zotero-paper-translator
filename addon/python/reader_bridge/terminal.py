"""Launch a client argv in a native terminal without a shell on Linux."""

import os
import shlex
import shutil
import subprocess
import sys
from pathlib import Path


def launch_terminal(command, folder, terminal_path=""):
    if sys.platform == "win32":
        quoted = ['"' + value.replace('%', '%%') + '"' for value in command]
        script = folder / "resume.cmd"
        script.write_bytes(('@echo off\r\nchcp 65001 >nul\r\n' + ' '.join(quoted) + '\r\n').encode("utf-8"))
        os.startfile(str(script))
    elif sys.platform == "darwin":
        shell_command = "exec " + shlex.join(command)
        literal = shell_command.replace("\\", "\\\\").replace('"', '\\"')
        subprocess.run(["osascript", "-e", f'tell application "Terminal" to do script "{literal}"',
                        "-e", 'tell application "Terminal" to activate'], check=True, capture_output=True)
    else:
        candidates = [terminal_path] if terminal_path else [
            "x-terminal-emulator", "konsole", "gnome-terminal", "kgx", "xfce4-terminal",
            "kitty", "alacritty", "wezterm", "xterm"]
        terminal = next((path for name in candidates if (path := shutil.which(name))), None)
        if not terminal:
            raise ValueError("No supported terminal was found. Set a terminal executable in Paper Translator settings.")
        name = Path(terminal).name
        if name in {"gnome-terminal", "kgx", "kitty"}:
            args = [terminal, "--", *command]
        elif name == "wezterm":
            args = [terminal, "start", "--", *command]
        elif name == "xfce4-terminal":
            args = [terminal, "--command", shlex.join(command)]
        else:
            args = [terminal, "-e", *command]
        subprocess.Popen(args, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                         cwd=folder, start_new_session=True)


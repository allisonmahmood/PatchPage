#!/usr/bin/env python3
"""Run a command in a PTY and report its output and terminal restoration."""

import errno
import json
import os
import pty
import select
import signal
import subprocess
import sys
import termios
import time


interaction = sys.argv[1]
command = sys.argv[2:]
payload = sys.stdin.buffer.read()
master_fd, slave_fd = pty.openpty()
initial_terminal = termios.tcgetattr(slave_fd)

child_env = os.environ.copy()
process = subprocess.Popen(
    command,
    stdin=slave_fd,
    stdout=slave_fd,
    stderr=slave_fd,
    env=child_env,
    close_fds=True,
)

output = bytearray()
prompt = b"PatchPage API token:"
deadline = time.monotonic() + (3 if interaction == "none" else 5)
raw_during_interaction = None


def read_pty():
    try:
        return os.read(master_fd, 4096)
    except OSError as error:
        # Linux returns EIO after the PTY slave closes; that is its EOF signal.
        if error.errno == errno.EIO:
            return b""
        raise

while (
    interaction != "none"
    and prompt not in output
    and process.poll() is None
    and time.monotonic() < deadline
):
    readable, _, _ = select.select([master_fd], [], [], 0.05)
    if readable:
        output.extend(read_pty())

if prompt in output:
    current_terminal = termios.tcgetattr(slave_fd)
    raw_during_interaction = not current_terminal[3] & (termios.ICANON | termios.ECHO)
    if interaction == "line":
        os.write(master_fd, payload + b"\r")
    elif interaction == "eof":
        os.write(master_fd, b"\x04")
    elif interaction == "interrupt":
        os.write(master_fd, b"\x03")
    elif interaction.startswith("signal:"):
        signal_name = interaction[len("signal:") :]
        os.kill(process.pid, getattr(signal, signal_name))
    else:
        raise ValueError(f"Unknown interaction: {interaction}")
    deadline = time.monotonic() + 5

while process.poll() is None and time.monotonic() < deadline:
    readable, _, _ = select.select([master_fd], [], [], 0.05)
    if readable:
        output.extend(read_pty())

if process.poll() is None:
    process.kill(signal.SIGKILL)
    process.wait()

for _ in range(5):
    readable, _, _ = select.select([master_fd], [], [], 0.02)
    if not readable:
        break
    output.extend(read_pty())

terminal_restored = termios.tcgetattr(slave_fd) == initial_terminal
os.close(master_fd)
os.close(slave_fd)

print(
    json.dumps(
        {
            "output": output.decode("utf-8", errors="replace"),
            "status": process.returncode,
            "rawDuringInteraction": raw_during_interaction,
            "terminalRestored": terminal_restored,
        }
    )
)

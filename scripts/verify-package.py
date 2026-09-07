#!/usr/bin/env python3
"""Verify the actual tarball and Bun executable without model credentials.

Artifacts and logs are retained on both success and failure. Requires Python 3.9+,
Bun and tar; dependency installation may require network/native build tools.
"""

import argparse
import hashlib
import json
import os
from pathlib import Path
import select
import subprocess
import tempfile
import time


def run(command, cwd, log, timeout):
    with log.open("wb") as output:
        try:
            subprocess.run(command, cwd=cwd, stdout=output, stderr=subprocess.STDOUT,
                           check=True, timeout=timeout)
        except (subprocess.CalledProcessError, subprocess.TimeoutExpired) as error:
            raise RuntimeError(f"{command[0:2]} failed: {error}; see {log}") from error


def smoke(package, manifest, preset, output):
    workspace = output / preset
    workspace.mkdir()
    env = {key: value for key, value in os.environ.items() if not key.startswith("ALWITH_DSH_")}
    env.pop("DEEPSEEK_API_KEY", None)
    env.update({
        "ALWITH_DSH_PRESET": preset,
        "ALWITH_DSH_PROVIDER": "deepseek-official",
        "ALWITH_DSH_WORKSPACE_ROOT": str(workspace),
        "ALWITH_DSH_SESSIONS_ROOT": str(workspace / "sessions"),
        "ALWITH_DSH_PLUGINS_FILE": str(workspace / "plugins.json"),
    })
    executable = package / manifest["bin"]["dsh-agent"]
    updates = []
    buffer = b""
    sequence = 0
    with (workspace / "stderr.txt").open("wb") as stderr, (workspace / "wire.jsonl").open("w") as wire:
        # Invoke the declared executable directly, exercising its Bun shebang.
        process = subprocess.Popen([str(executable)], cwd=package, env=env,
                                   stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=stderr)

        def request(method, params):
            nonlocal buffer, sequence
            sequence += 1
            frame = {"jsonrpc": "2.0", "id": sequence, "method": method, "params": params}
            process.stdin.write((json.dumps(frame) + "\n").encode())
            process.stdin.flush()
            deadline = time.monotonic() + 15
            while True:
                while b"\n" in buffer:
                    line, buffer = buffer.split(b"\n", 1)
                    wire.write(line.decode() + "\n")
                    wire.flush()
                    message = json.loads(line)
                    if message.get("method") == "session/update":
                        updates.append(message["params"]["update"])
                    if message.get("id") == sequence and ("result" in message or "error" in message):
                        return message
                remaining = deadline - time.monotonic()
                if remaining <= 0 or not select.select([process.stdout], [], [], remaining)[0]:
                    raise RuntimeError(f"{preset}: timed out waiting for {method}")
                chunk = os.read(process.stdout.fileno(), 65536)
                if not chunk:
                    raise RuntimeError(f"{preset}: unexpected EOF during {method}; see {workspace / 'stderr.txt'}")
                buffer += chunk

        try:
            initialized = request("initialize", {
                "protocolVersion": 2, "capabilities": {},
                "info": {"name": "package-verifier", "version": "1"},
            })["result"]
            assert initialized["protocolVersion"] == 2, initialized
            assert initialized["info"]["version"] == manifest["version"], initialized
            session = request("session/new", {"cwd": str(workspace)})["result"]["sessionId"]
            empty = request("session/prompt", {"sessionId": session, "prompt": []})
            assert "result" in empty, empty
            unsupported = request("session/prompt", {
                "sessionId": session, "prompt": [{"type": "image", "mimeType": "image/png", "data": "AA=="}],
            })
            assert unsupported["error"]["code"] == -32602, unsupported
            assert any(item.get("sessionUpdate") == "state_update" and item.get("state") == "idle"
                       and item.get("stopReason") == "end_turn" for item in updates), updates
            assert "result" in request("session/close", {"sessionId": session})
            process.stdin.close()
            process.stdin = None
            tail, _ = process.communicate(timeout=10)
            if tail:
                wire.write(tail.decode())
            assert process.returncode == 0, f"{preset}: exit {process.returncode}"
        finally:
            if process.poll() is None:
                process.kill()
                process.wait()
    return {"preset": preset, "initialize_version": manifest["version"], "empty_prompt": "accepted no-op",
            "unsupported_content": "invalid params", "close_and_eof": "passed"}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output-dir", type=Path, help="parent directory for retained verification artifacts")
    parser.add_argument("--install-timeout", type=int, default=180, help="installation watchdog in seconds")
    args = parser.parse_args()
    if args.install_timeout <= 0:
        parser.error("--install-timeout must be positive")
    if args.output_dir:
        args.output_dir.mkdir(parents=True, exist_ok=True)
    output = Path(tempfile.mkdtemp(prefix="dsh-agent-package-", dir=args.output_dir)).resolve()
    print(f"Artifacts: {output}", flush=True)
    repository = Path(__file__).resolve().parents[1]
    run(["npm", "pack", "--ignore-scripts", "--pack-destination", str(output)], repository, output / "pack.txt", 30)
    archives = list(output.glob("*.tgz"))
    assert len(archives) == 1, archives
    run(["tar", "-xzf", str(archives[0]), "-C", str(output)], output, output / "extract.txt", 30)
    package = output / "package"
    manifest = json.loads((package / "package.json").read_text())
    assert not (package / "node_modules").exists(), "artifact must install its own dependencies"
    # Match Desktop: the published artifact must carry its own lock because
    # --frozen-lockfile alone does not fail when the lock is absent.
    source_lock = repository / "bun.lock"
    lock_bytes = source_lock.read_bytes()
    lock_sha256 = hashlib.sha256(lock_bytes).hexdigest()
    assert (package / "bun.lock").read_bytes() == lock_bytes, "artifact lock differs from repository"
    run(["bun", "install", "--production", "--frozen-lockfile"], package, output / "install.txt", args.install_timeout)
    if (package / "bun.lock").read_bytes() != lock_bytes or source_lock.read_bytes() != lock_bytes:
        raise RuntimeError("lockfile bytes changed during frozen installation")
    run(["bun", "pm", "untrusted"], package, output / "untrusted.txt", 30)
    results = [smoke(package, manifest, preset, output)
               for preset in ("standard", "minimal", "anchored", "code", "cordis")]
    report = {"verification": "published artifact with bundled lock", "lock_sha256": lock_sha256,
              "lock_unchanged": True, "presets": results}
    (output / "results.json").write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps(report, indent=2))


if __name__ == "__main__":
    main()

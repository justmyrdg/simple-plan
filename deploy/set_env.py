#!/usr/bin/env python3
"""
Set or update KEY=VALUE lines in backend/.env without touching the other lines.

    python deploy/set_env.py KEY=VALUE [KEY=VALUE ...] [--file path/to/.env]

Existing keys are replaced in place, missing ones are appended. A commented-out
`# KEY=...` line is left alone. Values are masked in the output when the key
looks like a secret. Keep real credentials out of this file and out of git:
pass them on the command line instead.
"""

import sys
from pathlib import Path

DEFAULT_ENV = Path(__file__).resolve().parent.parent / "backend" / ".env"
SECRET_WORDS = ("PASSWORD", "SECRET", "KEY", "TOKEN")


def shown(key: str, value: str) -> str:
    if any(w in key.upper() for w in SECRET_WORDS) and value:
        return value[:2] + "*" * 6
    return value


def main(argv: list[str]) -> int:
    env_path = DEFAULT_ENV
    if "--file" in argv:
        i = argv.index("--file")
        try:
            env_path = Path(argv[i + 1])
        except IndexError:
            print("--file needs a path")
            return 2
        argv = argv[:i] + argv[i + 2:]

    updates: dict[str, str] = {}
    for arg in argv:
        key, sep, value = arg.partition("=")
        if not sep or not key.strip():
            print(f"Expected KEY=VALUE, got: {arg!r}")
            return 2
        updates[key.strip()] = value

    if not updates:
        print(__doc__)
        return 2

    lines = env_path.read_text(encoding="utf-8").splitlines() if env_path.exists() else []
    done: set[str] = set()
    for n, line in enumerate(lines):
        stripped = line.strip()
        if not stripped or stripped.startswith("#") or "=" not in stripped:
            continue
        key = stripped.split("=", 1)[0].strip()
        if key in updates and key not in done:
            lines[n] = f"{key}={updates[key]}"
            done.add(key)
            print(f"updated  {key}={shown(key, updates[key])}")

    for key, value in updates.items():
        if key not in done:
            lines.append(f"{key}={value}")
            print(f"added    {key}={shown(key, value)}")

    env_path.parent.mkdir(parents=True, exist_ok=True)
    env_path.write_text("\n".join(lines) + "\n", encoding="utf-8")
    print(f"\nSaved {env_path}. Restart the backend to apply.")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))

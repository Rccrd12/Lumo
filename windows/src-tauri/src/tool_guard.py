# Lumo's guard for a tool written in Python (tools.rs writes this file and
# runs the tool through it): `python lumo_guard.py <the tool's script> <args>`.
#
# The tool said in its tool.json what it needs (LUMO_TOOL_ALLOW: network,
# read, write, system). An audit hook (PEP 578), which nothing can take off
# once it is on, refuses what it did not say: connecting anywhere, reading
# files outside its own folder and Python's, writing anywhere but its work
# folder (LUMO_TOOL_WORK), starting programs, the registry, loading DLLs.
# It is a guard rail for honest tools that overreach, read together with the
# supervisor's review: not a sandbox against code written to escape it.

import os
import sys


def _install():
    allow = {p for p in os.environ.get("LUMO_TOOL_ALLOW", "").split(",") if p}

    def norm(path):
        return os.path.normcase(os.path.abspath(path))

    own = [norm(os.environ.get("LUMO_TOOL_DIR") or os.getcwd())]
    work = os.environ.get("LUMO_TOOL_WORK")
    if work:
        own.append(norm(work))
    script = os.environ.get("LUMO_TOOL_SCRIPT")
    if script:
        own.append(norm(os.path.dirname(script)))
    # Python itself and its packages: what an import reads.
    python = {norm(p) for p in (sys.prefix, sys.base_prefix, sys.exec_prefix, sys.base_exec_prefix) if p}
    python.update(norm(p) for p in sys.path if p and os.path.isabs(p))
    readable = own + sorted(python)
    writable = [norm(work)] if work else []

    def inside(path, roots):
        try:
            p = norm(os.fsdecode(path))
        except Exception:
            return False
        return any(p == r or p.startswith(r.rstrip("\\/") + os.sep) for r in roots)

    def refuse(need):
        raise PermissionError(
            "Lumo: this tool didn't say it needs " + need + ", so it can't. "
            "Change the tool with Lumo to add it."
        )

    def may_read(path):
        if "read" not in allow and isinstance(path, (str, bytes, os.PathLike)) and not inside(path, readable):
            refuse("to read files outside its folder")

    def may_write(path):
        if "write" not in allow and not inside(path, writable):
            refuse("to change files")

    network = {
        "socket.connect", "socket.bind", "socket.getaddrinfo", "socket.gethostbyname",
        "socket.gethostbyname_ex", "socket.gethostbyaddr", "socket.sendto", "socket.sendmsg",
        "urllib.Request", "http.client.connect", "ftplib.connect", "smtplib.connect",
        "imaplib.open", "poplib.connect", "nntplib.connect", "telnetlib.Telnet.open",
        "webbrowser.open",
    }
    system = {
        "subprocess.Popen", "os.system", "os.exec", "os.posix_spawn", "os.spawn", "os.startfile",
        "os.kill", "_winapi.CreateProcess", "ctypes.dlopen", "ctypes.dlsym", "ctypes.cdata",
        "ctypes.call_function", "winreg.CreateKey", "winreg.DeleteKey", "winreg.DeleteValue",
        "winreg.SetValue", "winreg.ConnectRegistry", "winreg.LoadKey", "winreg.SaveKey",
        "winreg.DisableReflectionKey", "winreg.EnableReflectionKey",
    }
    writes = {
        "os.remove", "os.rename", "os.rmdir", "os.mkdir", "os.chmod", "os.link", "os.symlink",
        "os.truncate", "os.utime", "shutil.rmtree", "shutil.move", "shutil.copytree",
        "shutil.copyfile", "shutil.unpack_archive", "shutil.make_archive",
    }
    reads = {"os.listdir", "os.scandir", "glob.glob", "glob.glob/2"}
    write_flags = os.O_WRONLY | os.O_RDWR | os.O_APPEND | os.O_CREAT | os.O_TRUNC

    def hook(event, args):
        if event == "open":
            path, mode, flags = (tuple(args) + (None, None, None))[:3]
            if not isinstance(path, (str, bytes, os.PathLike)):
                return
            writing = any(c in mode for c in "wax+") if isinstance(mode, str) else bool((flags or 0) & write_flags)
            if writing:
                may_write(path)
            else:
                may_read(path)
        elif event in network:
            if "network" not in allow:
                refuse("the internet")
        elif event in system:
            if "system" not in allow:
                refuse("to run programs or change system settings")
        elif event in writes:
            for path in args:
                if isinstance(path, (str, bytes, os.PathLike)):
                    may_write(path)
        elif event in reads:
            if args and isinstance(args[0], (str, bytes, os.PathLike)):
                may_read(args[0])
        elif event == "sqlite3.connect":
            if args and isinstance(args[0], (str, bytes, os.PathLike)) and os.fsdecode(args[0]) != ":memory:":
                may_write(args[0])

    sys.addaudithook(hook)


def _main():
    if len(sys.argv) < 2:
        sys.exit("lumo_guard: no script")
    script = os.path.abspath(sys.argv[1])
    os.environ["LUMO_TOOL_SCRIPT"] = script
    import runpy
    sys.argv = sys.argv[1:]
    sys.path[0] = os.path.dirname(script)
    _install()
    runpy.run_path(script, run_name="__main__")


if __name__ == "__main__":
    _main()

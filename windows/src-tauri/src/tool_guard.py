# Lumo's guard for a tool written in Python (tools.rs writes this file and
# runs the tool through it): `python lumo_guard.py <the tool's script> <args>`.
#
# The tool said in its tool.json what it needs (LUMO_TOOL_ALLOW: network,
# read, write, system). An audit hook (PEP 578), which nothing can take off
# once it is on, refuses what it did not say: connecting anywhere, reading
# files outside its own folder and Python's, writing anywhere but its work
# folder (LUMO_TOOL_WORK), starting programs, the registry, loading DLLs.
#
# The hook holds what it needs where the tool can't change it: everything is
# read once into its default arguments (immutable values and the C functions
# themselves), none of it in a closure or a module the tool could reach and
# change (a frame's locals from a traceback, os.path.abspath replaced, the gc).
# The paths it is given are read as plain strings, without running anything
# of the tool's (pathlib's paths only while its classes are as Python made
# them). Setting its defaults or code, looking through the gc, and writing a
# library (DLL, .pyd) to load are refused too.
#
# It is a guard rail for honest tools that overreach, read together with the
# supervisor's review and, where it can, the Windows sandbox (sandbox.rs): not
# a sandbox against code written to escape it.

import os
import sys


def _install():
    windows = os.name == "nt"
    sep = "\\" if windows else "/"
    if windows:
        # The C function behind os.path.abspath: nothing the tool can replace.
        from nt import _getfullpathname as full
    else:
        from posix import getcwd

        def full(p, _getcwd=getcwd, _norm=os.path.normpath, _startswith=str.startswith):
            return _norm(p if _startswith(p, "/") else _getcwd() + "/" + p)

    def plain(p, _replace=str.replace, _lower=str.lower, _rstrip=str.rstrip, _windows=windows, _sep=sep):
        # A plain str, read through str's own methods: compared as Windows does.
        p = _replace(p, "/", _sep)
        return _rstrip(_lower(p) if _windows else p, _sep) or _sep

    def norm(path):
        return plain(full(path))

    allow = frozenset(p for p in os.environ.get("LUMO_TOOL_ALLOW", "").split(",") if p)
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
    readable = tuple(own + sorted(python))
    writable = (norm(work),) if work else ()

    network = frozenset({
        "socket.connect", "socket.bind", "socket.getaddrinfo", "socket.gethostbyname",
        "socket.gethostbyname_ex", "socket.gethostbyaddr", "socket.sendto", "socket.sendmsg",
        "urllib.Request", "http.client.connect", "ftplib.connect", "smtplib.connect",
        "imaplib.open", "poplib.connect", "nntplib.connect", "telnetlib.Telnet.open",
        "webbrowser.open",
    })
    system = frozenset({
        "subprocess.Popen", "os.system", "os.exec", "os.posix_spawn", "os.spawn", "os.startfile",
        "os.kill", "_winapi.CreateProcess", "_winapi.CreateJunction", "_winapi.TerminateProcess",
        "ctypes.dlopen", "ctypes.dlsym", "ctypes.cdata", "ctypes.call_function", "ctypes.addressof",
        "ctypes.string_at", "ctypes.wstring_at", "ctypes.PyObj_FromPtr", "winreg.CreateKey",
        "winreg.DeleteKey", "winreg.DeleteValue", "winreg.SetValue", "winreg.ConnectRegistry",
        "winreg.LoadKey", "winreg.SaveKey", "winreg.DisableReflectionKey", "winreg.EnableReflectionKey",
        "msvcrt.open_osfhandle",
    })
    writes = frozenset({
        "os.remove", "os.rename", "os.rmdir", "os.mkdir", "os.chmod", "os.link", "os.symlink",
        "os.truncate", "os.utime", "shutil.rmtree", "shutil.move", "shutil.copytree",
        "shutil.copyfile", "shutil.unpack_archive", "shutil.make_archive",
    })
    reads = frozenset({"os.listdir", "os.scandir", "glob.glob", "glob.glob/2"})
    # What these take from their first path is read: a copy or a move of a
    # file outside the tool's folders into its work folder reads that file.
    takes_from = frozenset({"os.rename", "shutil.move", "shutil.copyfile", "shutil.copytree", "os.link", "os.symlink"})
    # Looking through every object (the hook, its values) is not for a tool.
    introspection = frozenset({"gc.get_objects", "gc.get_referrers", "gc.get_referents"})
    handled = network | system | writes | reads | introspection | {"open", "sqlite3.connect", "object.__setattr__"}
    # A file Windows or Python would load as code: written, it could be imported.
    libraries = (".pyd", ".dll", ".so", ".exe", ".dylib")
    write_flags = os.O_WRONLY | os.O_RDWR | os.O_APPEND | os.O_CREAT | os.O_TRUNC
    # The paths read without running the tool's code: plain strings and bytes,
    # and pathlib's own paths (whose classes the tool may not change).
    import pathlib
    path_types = tuple(t for t in vars(pathlib).values() if isinstance(t, type) and issubclass(t, pathlib.PurePath))
    # A class's attributes change without an audit event: what pathlib's
    # classes hold now is kept, and a path whose class changed is not read
    # (a changed __fspath__ could name one file to the hook and another to open).
    class_dict = type.__dict__["__dict__"].__get__
    classes = []
    for t in path_types:
        for c in t.__mro__:
            if c is not object and all(c is not seen for seen, _ in classes):
                classes.append((c, tuple(class_dict(c).items())))
    path_classes = tuple(classes)

    def hook(
        event, args,
        _handled=handled, _allow=allow, _readable=readable, _writable=writable, _network=network,
        _system=system, _writes=writes, _reads=reads, _takes_from=takes_from, _introspection=introspection,
        _libraries=libraries, _write_flags=write_flags, _path_types=path_types, _ours=None,
        _full=full, _plain=plain, _sep=sep, _str=str, _bytes=bytes, _int=int, _bool=bool, _type=type,
        _isinstance=isinstance, _tuple=tuple, _decode=bytes.decode, _startswith=str.startswith,
        _endswith=str.endswith, _fspath=os.fspath, _Error=PermissionError, _O_WRONLY=os.O_WRONLY,
        _path_classes=path_classes, _class_dict=class_dict, _len=len, _get=type(vars(object)).get,
    ):
        if event not in _handled:
            return

        def refuse(need):
            raise _Error(
                "Lumo: this tool didn't say it needs " + need + ", so it can't. "
                "Change the tool with Lumo to add it."
            )

        def is_path_type(kind):
            for t in _path_types:
                if kind is t:
                    return True
            return False

        def unchanged():
            missing = _Error
            for c, items in _path_classes:
                now = _class_dict(c)
                if _len(now) != _len(items):
                    return False
                for name, value in items:
                    if _get(now, name, missing) is not value:
                        return False
            return True

        def text(path):
            # The path as a plain string, read without running the tool's code;
            # None for what isn't a path (a file descriptor).
            kind = _type(path)
            if kind is _str:
                return path
            if _isinstance(path, _str):
                return _plain(path)
            if _isinstance(path, _bytes):
                return _decode(path, "utf-8", "surrogateescape")
            if is_path_type(kind):
                if not unchanged():
                    refuse("to change how Python reads paths")
                p = _fspath(path)
                return p if _type(p) is _str else _plain(p)
            if _isinstance(path, _int):
                return None
            # Anything else that says it is a path (its own __fspath__) is not read.
            refuse("to open files by a path of its own kind")

        def where(path):
            p = text(path)
            return None if p is None else _plain(_full(p))

        def inside(p, roots):
            for r in roots:
                if p == r or _startswith(p, r if _endswith(r, _sep) else r + _sep):
                    return True
            return False

        def may_read(path):
            if "read" in _allow:
                return
            p = where(path)
            if p is not None and not inside(p, _readable):
                refuse("to read files outside its folder")

        def may_write(path):
            p = where(path)
            if p is None:
                return
            if "write" not in _allow and not inside(p, _writable):
                refuse("to change files")
            if "system" not in _allow:
                for ending in _libraries:
                    if _endswith(p, ending):
                        refuse("to write programs or libraries")

        if event == "open":
            path, mode, flags = (_tuple(args) + (None, None, None))[:3]
            if _type(mode) is _str:
                writing = "w" in mode or "a" in mode or "x" in mode or "+" in mode
                reading = "r" in mode or "+" in mode
            else:
                f = flags if _type(flags) is _int else 0
                writing = _bool(f & _write_flags)
                reading = not (f & _O_WRONLY)
            # "r+" and O_RDWR read as well as write: both are checked.
            if writing:
                may_write(path)
            if reading or not writing:
                may_read(path)
        elif event in _network:
            if "network" not in _allow:
                refuse("the internet")
        elif event in _system:
            if "system" not in _allow:
                refuse("to run programs or change system settings")
        elif event in _writes:
            if event in _takes_from and args:
                may_read(args[0])
            for path in args:
                if _isinstance(path, (_str, _bytes)) or is_path_type(_type(path)):
                    may_write(path)
        elif event in _reads:
            if args and args[0] is not None and not _isinstance(args[0], _int):
                may_read(args[0])
        elif event == "sqlite3.connect":
            if args and _isinstance(args[0], (_str, _bytes)) and text(args[0]) != ":memory:":
                may_write(args[0])
        elif event in _introspection:
            if "system" not in _allow:
                refuse("to look through Python's memory")
        elif event == "object.__setattr__":
            # The hook's own values and code (pathlib's classes are checked above).
            target = args[0] if args else None
            if target is _ours:
                refuse("to change Lumo's guard")

    # The hook knows itself, to refuse a change to its values or its code.
    names = hook.__code__.co_varnames[: hook.__code__.co_argcount]
    first = len(names) - len(hook.__defaults__)
    at = names.index("_ours") - first
    hook.__defaults__ = hook.__defaults__[:at] + (hook,) + hook.__defaults__[at + 1:]
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

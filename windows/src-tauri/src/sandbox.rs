// The Windows sandbox: "Sandbox: High" in the local chat's permissions. The
// user's tools (tools.rs) run as before, under Lumo's own guards (tool_guard.py
// for Python, Node's permission flags, a proxy pointed nowhere), and in
// addition inside an AppContainer, the box Windows keeps Store apps in.
//
// A process in Lumo's AppContainer ("com.rccrd12.lumo.tools") can't:
//   * reach the internet, unless the tool declared it (the internetClient
//     capability); the computer's own network and its loopback stay closed;
//   * open any file or folder that wasn't granted to it here: the tool's own
//     folder and the program that runs it to read, its work folder to write.
//     What Windows opens to every app (System32, Program Files) stays readable;
//   * touch other programs' windows, the clipboard, global atoms, system
//     settings or the display, or sign the user out: its job's UI limits;
//   * outlive what started it: the job ends it, and everything it started,
//     when Lumo closes the job's handle, a crash of Lumo included.
//
// A tool that declared read, write or system needs the user's files or the
// system itself, so it can't run in here: those keep asking (local_chat.rs).
//
// The profile is made once and kept. A folder isn't opened to the AppContainer
// itself but to a capability named after the folder (and whether it's read or
// write), and a run holds only the capabilities of what it was given: what one
// tool was let into stays closed to the next one. The grants stay in the
// folders' access lists, so the next start doesn't walk a large Python folder
// again; a folder made anew gets its grant again on the next run.

use std::path::{Path, PathBuf};

/// Starting a tool in the sandbox: what it runs and what it may reach.
pub struct Launch<'a> {
    pub exe: &'a Path,
    pub args: &'a [String],
    pub cwd: &'a Path,
    /// Variables set on top of Lumo's own environment (later ones win).
    pub env: &'a [(String, String)],
    /// Folders or files the tool may read and run (granted read + execute to
    /// the container, inherited by a folder's contents).
    pub read: &'a [PathBuf],
    /// Folders it may write in (read, write, delete, inherited).
    pub write: &'a [PathBuf],
    /// The internet: the internetClient capability (S-1-15-3-1), else none.
    pub network: bool,
}

/// A tool running in the sandbox. Dropping it ends it and whatever it started.
///
/// The child's pipe ends are inheritable for the moment it takes to start it,
/// and a `std::process::Command` started by another thread in that moment
/// inherits them too (std hands a new process every inheritable handle). Then
/// stdout or stderr may not reach its end when the tool ends: whoever reads
/// them must not wait for that without a time limit once `try_wait` has said
/// the tool ended, or after `kill`.
pub struct Contained {
    pub stdin: Option<std::fs::File>,
    pub stdout: Option<std::fs::File>,
    pub stderr: Option<std::fs::File>,
    #[cfg(windows)]
    process: win::Owned,
    #[cfg(windows)]
    job: win::Owned,
    #[cfg(not(windows))]
    never: Never,
}

#[cfg(not(windows))]
enum Never {}

/// Whether Windows lets Lumo make its AppContainer (cached after the first
/// answer). Always false off Windows.
pub fn available() -> bool {
    #[cfg(windows)]
    {
        win::profile_sid().is_ok()
    }
    #[cfg(not(windows))]
    {
        false
    }
}

/// Starts `exe` in Lumo's AppContainer with what `launch` grants. Off Windows: Err.
pub fn spawn(launch: &Launch) -> Result<Contained, String> {
    #[cfg(windows)]
    {
        win::spawn(launch)
    }
    #[cfg(not(windows))]
    {
        let _ = launch;
        Err("The Windows sandbox is only on Windows.".into())
    }
}

#[cfg(not(windows))]
impl Contained {
    /// Some(exit code) once it ended, None while it runs.
    pub fn try_wait(&mut self) -> std::io::Result<Option<i32>> {
        match self.never {}
    }

    /// Ends it and everything it started, then waits for it.
    pub fn kill(&mut self) {
        match self.never {}
    }
}

// ── The command line and the environment, as Windows wants them ──────────────

/// `program` and `args` as one command line, quoted the way the Microsoft C
/// runtime (and so Python, Node and most programs) splits it again: an
/// argument with a space, a tab or a quote goes in quotes, a quote inside is
/// escaped, and the backslashes before a quote or the closing quote are doubled.
/// The program is always quoted: its name is split by simpler rules.
#[cfg_attr(not(windows), allow(dead_code))]
fn command_line(program: &str, args: &[String]) -> String {
    let mut line = format!("\"{program}\"");
    for arg in args {
        line.push(' ');
        push_arg(&mut line, arg);
    }
    line
}

#[cfg_attr(not(windows), allow(dead_code))]
fn push_arg(line: &mut String, arg: &str) {
    let quote = arg.is_empty() || arg.contains([' ', '\t', '"']);
    if !quote {
        line.push_str(arg);
        return;
    }
    line.push('"');
    let mut backslashes = 0;
    for c in arg.chars() {
        if c == '\\' {
            backslashes += 1;
        } else {
            if c == '"' {
                // The backslashes before it, doubled, and one for the quote.
                line.extend(std::iter::repeat_n('\\', backslashes + 1));
            }
            backslashes = 0;
        }
        line.push(c);
    }
    line.extend(std::iter::repeat_n('\\', backslashes));
    line.push('"');
}

/// The environment block for CREATE_UNICODE_ENVIRONMENT: `base` (Lumo's own,
/// in UTF-16) with `extra` on top, names compared without regard to case, a
/// later one replacing an earlier one. Sorted by name the same way, each
/// NAME=value ended by a NUL and the whole block by one more.
#[cfg_attr(not(windows), allow(dead_code))]
fn env_block(base: Vec<(Vec<u16>, Vec<u16>)>, extra: &[(String, String)]) -> Vec<u16> {
    use std::collections::BTreeMap;
    let mut vars: BTreeMap<Vec<u16>, (Vec<u16>, Vec<u16>)> = BTreeMap::new();
    let extra = extra
        .iter()
        .filter(|(name, value)| !name.is_empty() && !name.contains(['=', '\0']) && !value.contains('\0'))
        .map(|(name, value)| (name.encode_utf16().collect::<Vec<u16>>(), value.encode_utf16().collect::<Vec<u16>>()));
    for (name, value) in base.into_iter().chain(extra) {
        if name.is_empty() {
            continue;
        }
        vars.insert(upper(&name), (name, value));
    }
    let mut block = Vec::new();
    for (name, value) in vars.into_values() {
        block.extend(name);
        block.push(b'=' as u16);
        block.extend(value);
        block.push(0);
    }
    // An empty block still needs its two NULs.
    if block.is_empty() {
        block.push(0);
    }
    block.push(0);
    block
}

/// A name in capitals, the key Windows compares and sorts names by. A lone
/// surrogate stays as it is.
#[cfg_attr(not(windows), allow(dead_code))]
fn upper(name: &[u16]) -> Vec<u16> {
    let mut out = Vec::with_capacity(name.len());
    for unit in char::decode_utf16(name.iter().copied()) {
        match unit {
            Ok(c) => {
                let mut up = c.to_uppercase();
                let c = match (up.next(), up.next()) {
                    (Some(u), None) => u,
                    _ => c,
                };
                let mut buf = [0u16; 2];
                out.extend_from_slice(c.encode_utf16(&mut buf));
            }
            Err(e) => out.push(e.unpaired_surrogate()),
        }
    }
    out
}

/// A batch file runs through cmd.exe, which splits its command line by rules
/// of its own: the quoting above doesn't hold there, so it isn't started here.
#[cfg_attr(not(windows), allow(dead_code))]
fn is_batch(exe: &Path) -> bool {
    exe.extension()
        .and_then(|e| e.to_str())
        .is_some_and(|e| e.eq_ignore_ascii_case("bat") || e.eq_ignore_ascii_case("cmd"))
}

#[cfg(windows)]
mod win {
    use std::ffi::c_void;
    use std::os::windows::ffi::OsStrExt;
    use std::os::windows::io::FromRawHandle;
    use std::path::Path;
    use std::sync::OnceLock;

    use ::windows::core::{w, PCWSTR, PWSTR};
    use ::windows::Win32::Foundation::{
        CloseHandle, LocalFree, SetHandleInformation, ERROR_ALREADY_EXISTS, HANDLE, HANDLE_FLAG_INHERIT,
        HLOCAL, WAIT_OBJECT_0, WAIT_TIMEOUT,
    };
    use ::windows::Win32::Security::Authorization::{
        ConvertSidToStringSidW, ConvertStringSidToSidW, GetNamedSecurityInfoW, SetEntriesInAclW, SetNamedSecurityInfoW,
        EXPLICIT_ACCESS_W, GRANT_ACCESS, SE_FILE_OBJECT, TRUSTEE_IS_SID, TRUSTEE_IS_UNKNOWN, TRUSTEE_W,
    };
    use ::windows::Win32::Security::Isolation::{CreateAppContainerProfile, DeriveAppContainerSidFromAppContainerName};
    use ::windows::Win32::Security::{
        DeriveCapabilitySidsFromName, EqualSid, FreeSid, GetAce, GetAclInformation, AclSizeInformation, ACCESS_ALLOWED_ACE, ACE_FLAGS, ACL,
        ACL_SIZE_INFORMATION, DACL_SECURITY_INFORMATION, INHERIT_ONLY_ACE, NO_INHERITANCE, PSECURITY_DESCRIPTOR, PSID,
        SECURITY_CAPABILITIES, SID_AND_ATTRIBUTES, SUB_CONTAINERS_AND_OBJECTS_INHERIT,
    };
    use ::windows::Win32::Storage::FileSystem::{DELETE, FILE_GENERIC_EXECUTE, FILE_GENERIC_READ, FILE_GENERIC_WRITE};
    use ::windows::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JobObjectBasicUIRestrictions, JobObjectExtendedLimitInformation,
        SetInformationJobObject, TerminateJobObject, JOBOBJECT_BASIC_UI_RESTRICTIONS, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
        JOB_OBJECT_LIMIT_DIE_ON_UNHANDLED_EXCEPTION, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE, JOB_OBJECT_UILIMIT_DESKTOP,
        JOB_OBJECT_UILIMIT_DISPLAYSETTINGS, JOB_OBJECT_UILIMIT_EXITWINDOWS, JOB_OBJECT_UILIMIT_GLOBALATOMS,
        JOB_OBJECT_UILIMIT_HANDLES, JOB_OBJECT_UILIMIT_READCLIPBOARD, JOB_OBJECT_UILIMIT_SYSTEMPARAMETERS,
        JOB_OBJECT_UILIMIT_WRITECLIPBOARD,
    };
    use ::windows::Win32::System::Pipes::CreatePipe;
    use ::windows::Win32::System::Threading::{
        CreateProcessW, DeleteProcThreadAttributeList, GetExitCodeProcess, InitializeProcThreadAttributeList,
        ResumeThread, TerminateProcess, UpdateProcThreadAttribute, WaitForSingleObject, CREATE_NO_WINDOW,
        CREATE_SUSPENDED, CREATE_UNICODE_ENVIRONMENT, EXTENDED_STARTUPINFO_PRESENT, INFINITE,
        LPPROC_THREAD_ATTRIBUTE_LIST, PROCESS_INFORMATION, PROC_THREAD_ATTRIBUTE_HANDLE_LIST,
        PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES, STARTF_USESTDHANDLES, STARTUPINFOEXW,
    };

    use super::{Contained, Launch};

    const PROFILE: &str = "com.rccrd12.lumo.tools";
    /// The internetClient capability: the internet, not the local network.
    const INTERNET_CLIENT: &str = "S-1-15-3-1";
    // From winnt.h (System_SystemServices, not otherwise needed here).
    const SE_GROUP_ENABLED: u32 = 0x4;
    const ACCESS_ALLOWED_ACE_TYPE: u8 = 0;
    const INHERITED_ACE: u8 = 0x10;

    const READ: u32 = FILE_GENERIC_READ.0 | FILE_GENERIC_EXECUTE.0;
    const WRITE: u32 = FILE_GENERIC_READ.0 | FILE_GENERIC_WRITE.0 | FILE_GENERIC_EXECUTE.0 | DELETE.0;

    /// A handle closed when dropped. Kept as a number so a `Contained` can
    /// move between threads.
    pub(super) struct Owned(usize);

    impl Owned {
        fn new(handle: HANDLE) -> Self {
            Owned(handle.0 as usize)
        }
        fn handle(&self) -> HANDLE {
            HANDLE(self.0 as *mut c_void)
        }
        /// Gives the handle up to a `File`, which closes it from now on.
        fn into_file(self) -> std::fs::File {
            let raw = self.0 as *mut c_void;
            std::mem::forget(self);
            unsafe { std::fs::File::from_raw_handle(raw) }
        }
    }

    impl Drop for Owned {
        fn drop(&mut self) {
            if self.0 != 0 {
                unsafe {
                    let _ = CloseHandle(self.handle());
                }
            }
        }
    }

    /// A SID Windows allocated with LocalAlloc, freed when dropped.
    struct LocalSid(PSID);

    impl LocalSid {
        fn parse(text: &str) -> Result<Self, String> {
            let wide = wide_str(text);
            let mut sid = PSID::default();
            unsafe { ConvertStringSidToSidW(PCWSTR(wide.as_ptr()), &mut sid) }
                .map_err(|e| format!("Windows couldn't read the SID {text}: {e}"))?;
            Ok(LocalSid(sid))
        }
    }

    impl Drop for LocalSid {
        fn drop(&mut self) {
            unsafe {
                let _ = LocalFree(Some(HLOCAL(self.0 .0)));
            }
        }
    }

    fn wide_str(text: &str) -> Vec<u16> {
        text.encode_utf16().chain([0]).collect()
    }

    fn wide_path(path: &Path) -> Vec<u16> {
        path.as_os_str().encode_wide().chain([0]).collect()
    }

    /// The AppContainer's SID, as `S-1-15-2-…`: the profile is made the first
    /// time, found again after. The answer, or why not, is kept for the run.
    pub(super) fn profile_sid() -> Result<String, String> {
        static SID: OnceLock<Result<String, String>> = OnceLock::new();
        SID.get_or_init(|| unsafe { make_profile() }).clone()
    }

    unsafe fn make_profile() -> Result<String, String> {
        unsafe {
            let name = wide_str(PROFILE);
            let sid = match CreateAppContainerProfile(
                PCWSTR(name.as_ptr()),
                w!("Lumo tools"),
                w!("Where Lumo runs the tools you made"),
                None,
            ) {
                Ok(sid) => sid,
                Err(e) if e.code() == ERROR_ALREADY_EXISTS.to_hresult() => DeriveAppContainerSidFromAppContainerName(
                    PCWSTR(name.as_ptr()),
                )
                .map_err(|e| format!("Windows couldn't find Lumo's sandbox: {e}"))?,
                Err(e) => return Err(format!("Windows couldn't make Lumo's sandbox: {e}")),
            };
            let mut text = PWSTR::null();
            let converted = ConvertSidToStringSidW(sid, &mut text);
            // Both functions above hand back a SID to free with FreeSid.
            FreeSid(sid);
            converted.map_err(|e| format!("Windows couldn't read the sandbox's SID: {e}"))?;
            let out = text.to_string();
            let _ = LocalFree(Some(HLOCAL(text.0 as *mut c_void)));
            out.map_err(|e| format!("Windows couldn't read the sandbox's SID: {e}"))
        }
    }

    /// The capability that opens `path` with `mask` to a run holding it: a SID
    /// Windows derives from a name, so the same path always gets the same one.
    fn capability(path: &Path, mask: u32) -> Result<LocalSid, String> {
        let kind: &str = if mask == WRITE { "write" } else { "read" };
        // Paths are compared without regard to case, so the name is in capitals.
        let path: Vec<u16> = path.as_os_str().encode_wide().collect();
        let name: Vec<u16> =
            format!("{PROFILE}.{kind}:").encode_utf16().chain(super::upper(&path)).chain([0]).collect();
        let mut groups: *mut PSID = std::ptr::null_mut();
        let mut group_count = 0u32;
        let mut sids: *mut PSID = std::ptr::null_mut();
        let mut count = 0u32;
        unsafe {
            DeriveCapabilitySidsFromName(PCWSTR(name.as_ptr()), &mut groups, &mut group_count, &mut sids, &mut count)
                .map_err(|e| format!("Windows couldn't name a folder for the sandbox: {e}"))?;
            // Every SID and both arrays were allocated with LocalAlloc: the
            // first capability SID is kept, the rest is freed.
            for i in 0..group_count as usize {
                let _ = LocalFree(Some(HLOCAL((*groups.add(i)).0)));
            }
            let _ = LocalFree(Some(HLOCAL(groups.cast())));
            for i in 1..count as usize {
                let _ = LocalFree(Some(HLOCAL((*sids.add(i)).0)));
            }
            let first = if count > 0 { Some(LocalSid(*sids)) } else { None };
            let _ = LocalFree(Some(HLOCAL(sids.cast())));
            first.ok_or_else(|| "Windows couldn't name a folder for the sandbox.".to_string())
        }
    }

    /// Gives a run holding the capability it returns `mask` on `path` (and, for
    /// a folder, on all it holds, now and later). The access list is only
    /// changed when it doesn't already hold that grant.
    fn grant(path: &Path, mask: u32) -> Result<LocalSid, String> {
        let cap = capability(path, mask)?;
        let sid = &cap;
        let folder = path.is_dir();
        let inherit = if folder { SUB_CONTAINERS_AND_OBJECTS_INHERIT } else { NO_INHERITANCE };
        let name = wide_path(path);
        let shown = path.display();
        unsafe {
            let mut dacl: *mut ACL = std::ptr::null_mut();
            let mut descriptor = PSECURITY_DESCRIPTOR::default();
            GetNamedSecurityInfoW(
                PCWSTR(name.as_ptr()),
                SE_FILE_OBJECT,
                DACL_SECURITY_INFORMATION,
                None,
                None,
                Some(&mut dacl),
                None,
                &mut descriptor,
            )
            .ok()
            .map_err(|e| format!("Windows couldn't read who may open {shown}: {e}"))?;
            let result = if has_grant(dacl, sid.0, mask, inherit) {
                Ok(())
            } else {
                let access = EXPLICIT_ACCESS_W {
                    grfAccessPermissions: mask,
                    grfAccessMode: GRANT_ACCESS,
                    grfInheritance: inherit,
                    Trustee: TRUSTEE_W {
                        TrusteeForm: TRUSTEE_IS_SID,
                        TrusteeType: TRUSTEE_IS_UNKNOWN,
                        ptstrName: PWSTR(sid.0 .0.cast()),
                        ..Default::default()
                    },
                };
                let mut new_dacl: *mut ACL = std::ptr::null_mut();
                let set = SetEntriesInAclW(Some(&[access]), Some(dacl), &mut new_dacl).ok();
                let set = set.and_then(|_| {
                    let written = SetNamedSecurityInfoW(
                        PCWSTR(name.as_ptr()),
                        SE_FILE_OBJECT,
                        DACL_SECURITY_INFORMATION,
                        None,
                        None,
                        Some(new_dacl),
                        None,
                    )
                    .ok();
                    let _ = LocalFree(Some(HLOCAL(new_dacl.cast())));
                    written
                });
                set.map_err(|e| format!("Windows couldn't open {shown} to the sandbox: {e}"))
            };
            // `dacl` points into the descriptor: freeing it frees both.
            let _ = LocalFree(Some(HLOCAL(descriptor.0)));
            result?;
        }
        Ok(cap)
    }

    /// Whether `dacl` already holds an entry of its own (not inherited) that
    /// lets `sid` do all of `mask` on the object, and on what it holds when
    /// `inherit` asks for that.
    unsafe fn has_grant(dacl: *const ACL, sid: PSID, mask: u32, inherit: ACE_FLAGS) -> bool {
        unsafe {
            if dacl.is_null() {
                return false;
            }
            let mut size = ACL_SIZE_INFORMATION::default();
            if GetAclInformation(
                dacl,
                (&mut size as *mut ACL_SIZE_INFORMATION).cast(),
                std::mem::size_of::<ACL_SIZE_INFORMATION>() as u32,
                AclSizeInformation,
            )
            .is_err()
            {
                return false;
            }
            (0..size.AceCount).any(|i| {
                let mut ace: *mut c_void = std::ptr::null_mut();
                if GetAce(dacl, i, &mut ace).is_err() || ace.is_null() {
                    return false;
                }
                let ace = &*(ace as *const ACCESS_ALLOWED_ACE);
                let flags = ace.Header.AceFlags as u32;
                ace.Header.AceType == ACCESS_ALLOWED_ACE_TYPE
                    && ace.Header.AceFlags & INHERITED_ACE == 0
                    && flags & INHERIT_ONLY_ACE.0 == 0
                    && flags & inherit.0 == inherit.0
                    && ace.Mask & mask == mask
                    && EqualSid(PSID((&ace.SidStart as *const u32).cast_mut().cast()), sid).is_ok()
            })
        }
    }

    /// A pipe: the end Lumo keeps (not inherited) and the child's end, which
    /// is made inheritable only right before the child is started.
    fn pipe(child_reads: bool) -> Result<(Owned, Owned), String> {
        let mut read = HANDLE::default();
        let mut write = HANDLE::default();
        unsafe { CreatePipe(&mut read, &mut write, None, 0) }
            .map_err(|e| format!("Windows couldn't make a pipe for the tool: {e}"))?;
        let (read, write) = (Owned::new(read), Owned::new(write));
        Ok(if child_reads { (write, read) } else { (read, write) })
    }

    pub(super) fn spawn(launch: &Launch) -> Result<Contained, String> {
        if super::is_batch(launch.exe) {
            return Err("A batch file can't run in the Windows sandbox.".into());
        }
        let sid = LocalSid::parse(&profile_sid()?)?;
        let mut held = Vec::new();
        // Reading may already be open to every app (Program Files, System32),
        // where Lumo may not change the access list: then it goes on.
        for path in launch.read {
            if let Ok(cap) = grant(path, READ) {
                held.push(cap);
            }
        }
        for path in launch.write {
            held.push(grant(path, WRITE)?);
        }
        if launch.network {
            held.push(LocalSid::parse(INTERNET_CLIENT)?);
        }
        let mut capabilities: Vec<SID_AND_ATTRIBUTES> = held
            .iter()
            .map(|cap| SID_AND_ATTRIBUTES { Sid: cap.0, Attributes: SE_GROUP_ENABLED })
            .collect();
        let security = SECURITY_CAPABILITIES {
            AppContainerSid: sid.0,
            Capabilities: if capabilities.is_empty() { std::ptr::null_mut() } else { capabilities.as_mut_ptr() },
            CapabilityCount: capabilities.len() as u32,
            Reserved: 0,
        };

        let program = launch
            .exe
            .to_str()
            .ok_or_else(|| format!("The path {} can't be passed to Windows.", launch.exe.display()))?;
        let mut command: Vec<u16> = super::command_line(program, launch.args).encode_utf16().chain([0]).collect();
        let base = std::env::vars_os()
            .map(|(k, v)| (k.encode_wide().collect(), v.encode_wide().collect()))
            .collect();
        let env = super::env_block(base, launch.env);
        let app = wide_path(launch.exe);
        let cwd = wide_path(launch.cwd);

        let job = job()?;
        let (stdin, child_stdin) = pipe(true)?;
        let (stdout, child_stdout) = pipe(false)?;
        let (stderr, child_stderr) = pipe(false)?;
        let inherited = [child_stdin.handle(), child_stdout.handle(), child_stderr.handle()];

        let attributes = Attributes::new(2)?;
        unsafe {
            UpdateProcThreadAttribute(
                attributes.list(),
                0,
                PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES as usize,
                Some((&security as *const SECURITY_CAPABILITIES).cast()),
                std::mem::size_of::<SECURITY_CAPABILITIES>(),
                None,
                None,
            )
            .map_err(|e| format!("Windows couldn't set up the sandbox: {e}"))?;
            // Only the three pipe ends reach the tool, whatever else Lumo has open.
            UpdateProcThreadAttribute(
                attributes.list(),
                0,
                PROC_THREAD_ATTRIBUTE_HANDLE_LIST as usize,
                Some(inherited.as_ptr().cast()),
                std::mem::size_of_val(&inherited),
                None,
                None,
            )
            .map_err(|e| format!("Windows couldn't set up the sandbox: {e}"))?;
            for handle in inherited {
                SetHandleInformation(handle, HANDLE_FLAG_INHERIT.0, HANDLE_FLAG_INHERIT)
                    .map_err(|e| format!("Windows couldn't hand the pipes to the tool: {e}"))?;
            }
        }

        let mut info = STARTUPINFOEXW::default();
        info.StartupInfo.cb = std::mem::size_of::<STARTUPINFOEXW>() as u32;
        info.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
        info.StartupInfo.hStdInput = child_stdin.handle();
        info.StartupInfo.hStdOutput = child_stdout.handle();
        info.StartupInfo.hStdError = child_stderr.handle();
        info.lpAttributeList = attributes.list();
        let mut process = PROCESS_INFORMATION::default();
        let created = unsafe {
            CreateProcessW(
                PCWSTR(app.as_ptr()),
                Some(PWSTR(command.as_mut_ptr())),
                None,
                None,
                true,
                EXTENDED_STARTUPINFO_PRESENT | CREATE_UNICODE_ENVIRONMENT | CREATE_NO_WINDOW | CREATE_SUSPENDED,
                Some(env.as_ptr().cast()),
                PCWSTR(cwd.as_ptr()),
                &info.StartupInfo,
                &mut process,
            )
        };
        // The child has its own copies now (or never got them).
        drop((child_stdin, child_stdout, child_stderr, attributes));
        created.map_err(|e| format!("Windows couldn't start {} in the sandbox: {e}", launch.exe.display()))?;
        let thread = Owned::new(process.hThread);
        let child = Owned::new(process.hProcess);

        unsafe {
            if let Err(e) = AssignProcessToJobObject(job.handle(), child.handle()) {
                let _ = TerminateProcess(child.handle(), 1);
                return Err(format!("Windows couldn't put the tool in its job: {e}"));
            }
            if ResumeThread(thread.handle()) == u32::MAX {
                let e = ::windows::core::Error::from_win32();
                let _ = TerminateJobObject(job.handle(), 1);
                return Err(format!("Windows couldn't start the tool: {e}"));
            }
        }
        Ok(Contained {
            stdin: Some(stdin.into_file()),
            stdout: Some(stdout.into_file()),
            stderr: Some(stderr.into_file()),
            process: child,
            job,
        })
    }

    /// A job of its own for the tool: everything in it ends when its handle
    /// closes or the tool crashes, and it can't reach the desktop around it.
    fn job() -> Result<Owned, String> {
        let job = unsafe { CreateJobObjectW(None, PCWSTR::null()) }
            .map_err(|e| format!("Windows couldn't make a job for the tool: {e}"))?;
        let job = Owned::new(job);
        let mut limits = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
        limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE | JOB_OBJECT_LIMIT_DIE_ON_UNHANDLED_EXCEPTION;
        let ui = JOBOBJECT_BASIC_UI_RESTRICTIONS {
            UIRestrictionsClass: JOB_OBJECT_UILIMIT_READCLIPBOARD
                | JOB_OBJECT_UILIMIT_WRITECLIPBOARD
                | JOB_OBJECT_UILIMIT_GLOBALATOMS
                | JOB_OBJECT_UILIMIT_HANDLES
                | JOB_OBJECT_UILIMIT_SYSTEMPARAMETERS
                | JOB_OBJECT_UILIMIT_DISPLAYSETTINGS
                | JOB_OBJECT_UILIMIT_DESKTOP
                | JOB_OBJECT_UILIMIT_EXITWINDOWS,
        };
        unsafe {
            SetInformationJobObject(
                job.handle(),
                JobObjectExtendedLimitInformation,
                (&limits as *const JOBOBJECT_EXTENDED_LIMIT_INFORMATION).cast(),
                std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            )
            .and_then(|_| {
                SetInformationJobObject(
                    job.handle(),
                    JobObjectBasicUIRestrictions,
                    (&ui as *const JOBOBJECT_BASIC_UI_RESTRICTIONS).cast(),
                    std::mem::size_of::<JOBOBJECT_BASIC_UI_RESTRICTIONS>() as u32,
                )
            })
            .map_err(|e| format!("Windows couldn't set the tool's job limits: {e}"))?;
        }
        Ok(job)
    }

    /// A process attribute list, deleted when dropped. Its memory is u64s:
    /// the list holds pointers and must be aligned for them. Windows writes in
    /// it, so the pointer is taken once, from `as_mut_ptr`, and the memory
    /// isn't touched again.
    struct Attributes {
        list: LPPROC_THREAD_ATTRIBUTE_LIST,
        _memory: Vec<u64>,
    }

    impl Attributes {
        fn new(count: u32) -> Result<Self, String> {
            let mut size = 0usize;
            // The first call only says how much room the list needs.
            let _ = unsafe { InitializeProcThreadAttributeList(None, count, None, &mut size) };
            let mut memory = vec![0u64; size.div_ceil(8).max(1)];
            let list = LPPROC_THREAD_ATTRIBUTE_LIST(memory.as_mut_ptr().cast());
            // Not initialised on an error: nothing to delete, the memory just goes.
            unsafe { InitializeProcThreadAttributeList(Some(list), count, None, &mut size) }
                .map_err(|e| format!("Windows couldn't set up the sandbox: {e}"))?;
            Ok(Attributes { list, _memory: memory })
        }

        fn list(&self) -> LPPROC_THREAD_ATTRIBUTE_LIST {
            self.list
        }
    }

    impl Drop for Attributes {
        fn drop(&mut self) {
            unsafe { DeleteProcThreadAttributeList(self.list) };
        }
    }

    impl Contained {
        /// Some(exit code) once it ended, None while it runs.
        pub fn try_wait(&mut self) -> std::io::Result<Option<i32>> {
            unsafe {
                let wait = WaitForSingleObject(self.process.handle(), 0);
                if wait == WAIT_TIMEOUT {
                    return Ok(None);
                }
                if wait != WAIT_OBJECT_0 {
                    return Err(std::io::Error::last_os_error());
                }
                let mut code = 0u32;
                GetExitCodeProcess(self.process.handle(), &mut code).map_err(std::io::Error::other)?;
                Ok(Some(code as i32))
            }
        }

        /// Ends it and everything it started (TerminateJobObject), then waits for it.
        pub fn kill(&mut self) {
            unsafe {
                let _ = TerminateJobObject(self.job.handle(), 1);
                let _ = WaitForSingleObject(self.process.handle(), INFINITE);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn line(args: &[&str]) -> String {
        command_line("C:\\Program Files\\Python\\python.exe", &args.iter().map(|a| a.to_string()).collect::<Vec<_>>())
    }

    #[test]
    fn quotes_like_the_c_runtime() {
        assert_eq!(line(&[]), "\"C:\\Program Files\\Python\\python.exe\"");
        assert_eq!(line(&["plain", ""]), "\"C:\\Program Files\\Python\\python.exe\" plain \"\"");
        assert_eq!(line(&["a b", "tab\there"]), "\"C:\\Program Files\\Python\\python.exe\" \"a b\" \"tab\there\"");
        // Backslashes alone stay as they are.
        assert_eq!(line(&["C:\\work\\"]), "\"C:\\Program Files\\Python\\python.exe\" C:\\work\\");
        // Before the closing quote they are doubled.
        assert_eq!(line(&["C:\\my work\\"]), "\"C:\\Program Files\\Python\\python.exe\" \"C:\\my work\\\\\"");
        // A quote is escaped, with the backslashes before it doubled.
        assert_eq!(line(&["say \"hi\""]), "\"C:\\Program Files\\Python\\python.exe\" \"say \\\"hi\\\"\"");
        assert_eq!(line(&["a\\\"b"]), "\"C:\\Program Files\\Python\\python.exe\" \"a\\\\\\\"b\"");
        assert_eq!(line(&["{\"n\":1}"]), "\"C:\\Program Files\\Python\\python.exe\" \"{\\\"n\\\":1}\"");
    }

    fn utf16(s: &str) -> Vec<u16> {
        s.encode_utf16().collect()
    }

    fn vars(block: &[u16]) -> Vec<String> {
        assert!(block.ends_with(&[0, 0]), "a block ends with two NULs");
        let text = String::from_utf16(&block[..block.len() - 1]).unwrap();
        text.split('\0').filter(|s| !s.is_empty()).map(str::to_string).collect()
    }

    #[test]
    fn environment_merges_and_sorts_without_case() {
        let base = vec![
            (utf16("Path"), utf16("C:\\Windows")),
            (utf16("TEMP"), utf16("C:\\Temp")),
            (utf16("=C:"), utf16("C:\\")),
            (utf16("appdata"), utf16("C:\\Roaming")),
        ];
        let extra = [
            ("temp".to_string(), "C:\\work".to_string()),
            ("LUMO_TOOL_INPUT".to_string(), "{}".to_string()),
            ("LUMO_TOOL_INPUT".to_string(), "{\"a\":1}".to_string()),
            ("".to_string(), "dropped".to_string()),
            ("A=B".to_string(), "dropped".to_string()),
        ];
        assert_eq!(
            vars(&env_block(base, &extra)),
            ["=C:=C:\\", "appdata=C:\\Roaming", "LUMO_TOOL_INPUT={\"a\":1}", "Path=C:\\Windows", "temp=C:\\work"]
        );
    }

    #[test]
    fn empty_environment_is_two_nuls() {
        assert_eq!(env_block(Vec::new(), &[]), [0, 0]);
    }

    #[test]
    fn names_compare_in_capitals() {
        assert_eq!(upper(&utf16("lumo_ß_é")), utf16("LUMO_ß_É"));
        assert_eq!(upper(&[0xD800, b'a' as u16]), [0xD800, b'A' as u16]);
    }

    #[test]
    fn batch_files_are_told_apart() {
        assert!(is_batch(Path::new("C:\\t\\run.BAT")));
        assert!(is_batch(Path::new("C:\\t\\run.cmd")));
        assert!(!is_batch(Path::new("C:\\t\\run.exe")));
    }

    #[test]
    fn off_windows_there_is_no_sandbox() {
        if cfg!(windows) {
            return;
        }
        assert!(!available());
        let launch = Launch {
            exe: Path::new("/bin/true"),
            args: &[],
            cwd: Path::new("/"),
            env: &[],
            read: &[],
            write: &[],
            network: false,
        };
        assert_eq!(spawn(&launch).err().as_deref(), Some("The Windows sandbox is only on Windows."));
    }
}

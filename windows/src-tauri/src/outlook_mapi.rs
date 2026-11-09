// What Outlook guards of an email (its sender, its text, its headers), read
// through MAPI, the mail library of Outlook itself, in place of Outlook's
// automation (outlook.rs).
//
// Outlook's automation guards those fields: when another program reads them
// and Windows doesn't tell Outlook that an antivirus is on and up to date,
// Outlook asks the user each time ("A program is trying to access e-mail
// address information stored in Outlook"). MAPI has no such prompt: it is
// what Outlook stands on, and what Microsoft's own MFCMAPI reads with.
// Nothing of Outlook's security settings is touched.
//
// Lumo loads Outlook's own MAPI (olmapi32.dll), logs on to the session
// Outlook already has open (its profile, no password, no window), opens the
// email by the ids the automation gave (its store's and its own) and reads.
// It only reads: nothing is written through MAPI.
//
// An Outlook of other bits than Lumo's (a 32-bit Office) can't be loaded:
// then this answers None and outlook.rs reads what it can without a prompt.

use std::collections::HashMap;
use std::ffi::c_void;
use std::sync::OnceLock;

use ::windows::core::{w, Interface, GUID, HRESULT, HSTRING, IUnknown, PCWSTR};
use ::windows::Win32::Foundation::HMODULE;
use ::windows::Win32::System::AddressBook::{IMAPIProp, IMsgStore, ENTRYID, SPropTagArray, SPropValue};
use ::windows::Win32::System::Com::IStream;
use ::windows::Win32::System::LibraryLoader::{GetProcAddress, LoadLibraryExW, LOAD_WITH_ALTERED_SEARCH_PATH};
use ::windows::Win32::System::Registry::{RegGetValueW, HKEY_LOCAL_MACHINE, RRF_RT_REG_SZ};

use crate::log;

// MAPI's numbers (mapidefs.h, mapix.h, mapitags.h).
const MAPI_NO_COINIT: u32 = 0x8;
const MAPI_MULTITHREAD_NOTIFICATIONS: u32 = 0x1;
const MAPI_EXTENDED: u32 = 0x20;
const MAPI_USE_DEFAULT: u32 = 0x40;
const MAPI_NO_MAIL: u32 = 0x8000;
const MDB_NO_DIALOG: u32 = 0x1;
const MDB_NO_MAIL: u32 = 0x80;
const PT_ERROR: u32 = 0x000A;
const PT_UNICODE: u32 = 0x001F;
const MAPI_E_NOT_ENOUGH_MEMORY: i32 = 0x8007_000Eu32 as i32;
const PR_SENDER_NAME: u32 = 0x0C1A_001F;
const PR_SENDER_ADDRTYPE: u32 = 0x0C1E_001F;
const PR_SENDER_EMAIL_ADDRESS: u32 = 0x0C1F_001F;
const PR_SENDER_SMTP_ADDRESS: u32 = 0x5D01_001F;
const PR_BODY: u32 = 0x1000_001F;
const PR_TRANSPORT_MESSAGE_HEADERS: u32 = 0x007D_001F;

/// The headers are read only for List-Unsubscribe: their first part is enough.
const HEADER_CHARS: usize = 32_000;

/// What Outlook guards of one email.
#[derive(Default)]
pub struct Guarded {
    pub from: String,
    /// The sender's plain address, also for a colleague on Exchange.
    pub address: String,
    pub body: String,
    pub headers: String,
}

type Initialize = unsafe extern "system" fn(*mut c_void) -> HRESULT;
type LogonEx = unsafe extern "system" fn(usize, PCWSTR, PCWSTR, u32, *mut *mut c_void) -> HRESULT;
type FreeBuffer = unsafe extern "system" fn(*mut c_void) -> u32;
type Export = unsafe extern "system" fn() -> isize;

/// The functions of Outlook's MAPI that Lumo calls.
struct Api {
    logon: LogonEx,
    free: FreeBuffer,
}

// Outlook's MAPI is loaded and started once, on Outlook's thread (the only
// one that calls it), and stays for Lumo's life.
static API: OnceLock<Option<Api>> = OnceLock::new();

fn api() -> Option<&'static Api> {
    API.get_or_init(|| match load() {
        Ok(api) => {
            log::line("[outlook] reading through Outlook's MAPI: no security prompts");
            Some(api)
        }
        Err(e) => {
            log::line(format!("[outlook] MAPI unavailable ({e}): the sender and the text are left out of the island"));
            None
        }
    })
    .as_ref()
}

fn load() -> Result<Api, String> {
    let paths = candidates();
    let mut module = None;
    for path in &paths {
        if let Ok(m) = unsafe { LoadLibraryExW(&HSTRING::from(path.as_str()), None, LOAD_WITH_ALTERED_SEARCH_PATH) } {
            module = Some(m);
            break;
        }
    }
    let module: HMODULE = module.ok_or_else(|| {
        if paths.is_empty() {
            "Outlook's olmapi32.dll not found".to_string()
        } else {
            "Outlook's olmapi32.dll would not load: a 32-bit Office?".to_string()
        }
    })?;
    unsafe {
        let init = GetProcAddress(module, ::windows::core::s!("MAPIInitialize")).ok_or("no MAPIInitialize")?;
        let logon = GetProcAddress(module, ::windows::core::s!("MAPILogonEx")).ok_or("no MAPILogonEx")?;
        let free = GetProcAddress(module, ::windows::core::s!("MAPIFreeBuffer")).ok_or("no MAPIFreeBuffer")?;
        let init = std::mem::transmute::<Export, Initialize>(init);
        // MAPIINIT_0: this thread already joined COM's multithreaded apartment.
        let mut options: [u32; 2] = [0, MAPI_MULTITHREAD_NOTIFICATIONS | MAPI_NO_COINIT];
        init(options.as_mut_ptr().cast()).ok().map_err(|e| format!("MAPIInitialize: {}", e.message()))?;
        Ok(Api { logon: std::mem::transmute::<Export, LogonEx>(logon), free: std::mem::transmute::<Export, FreeBuffer>(free) })
    }
}

/// Where Outlook's MAPI is: what Outlook told Windows (an Office installed
/// with Click-to-Run, or from an .msi), then Office's usual folders.
fn candidates() -> Vec<String> {
    let mut out = Vec::new();
    for key in [
        w!("SOFTWARE\\Clients\\Mail\\Microsoft Outlook"),
        w!("SOFTWARE\\Microsoft\\Office\\ClickToRun\\REGISTRY\\MACHINE\\Software\\Clients\\Mail\\Microsoft Outlook"),
    ] {
        if let Some(path) = registry_text(key, w!("DLLPathEx")) {
            out.push(path);
        }
    }
    if let Ok(files) = std::env::var("ProgramFiles") {
        for folder in ["root\\Office16", "Office16", "root\\Office15", "Office15"] {
            out.push(format!("{files}\\Microsoft Office\\{folder}\\OLMAPI32.DLL"));
        }
    }
    out.retain(|p| p.to_ascii_lowercase().ends_with("olmapi32.dll") && std::path::Path::new(p).is_file());
    out.dedup_by(|a, b| a.eq_ignore_ascii_case(b));
    out
}

fn registry_text(key: PCWSTR, value: PCWSTR) -> Option<String> {
    let mut buffer = vec![0u16; 1024];
    let mut size = (buffer.len() * 2) as u32;
    let done = unsafe { RegGetValueW(HKEY_LOCAL_MACHINE, key, value, RRF_RT_REG_SZ, None, Some(buffer.as_mut_ptr().cast()), Some(&mut size)) };
    if done.is_err() {
        return None;
    }
    let len = (size as usize / 2).min(buffer.len());
    let text = String::from_utf16_lossy(&buffer[..len]);
    let text = text.trim_end_matches('\0').trim().to_string();
    (!text.is_empty()).then_some(text)
}

/// IMAPISession (mapix.h, not in Windows' metadata): only what Lumo calls,
/// the slots before them kept in their order.
#[repr(C)]
struct SessionVtbl {
    query_interface: usize,
    add_ref: usize,
    release: unsafe extern "system" fn(*mut c_void) -> u32,
    get_last_error: usize,
    get_msg_stores_table: usize,
    open_msg_store: unsafe extern "system" fn(*mut c_void, usize, u32, *const ENTRYID, *const GUID, u32, *mut *mut c_void) -> HRESULT,
    open_address_book: usize,
    open_profile_section: usize,
    get_status_table: usize,
    open_entry: usize,
    compare_entry_ids: usize,
    advise: usize,
    unadvise: usize,
    message_options: usize,
    query_default_message_opt: usize,
    enum_adr_types: usize,
    query_identity: usize,
    logoff: unsafe extern "system" fn(*mut c_void, usize, u32, u32) -> HRESULT,
}

/// A MAPI session on Outlook's profile, for one job of Outlook's thread.
pub struct Mapi {
    api: &'static Api,
    session: *mut c_void,
    /// The stores opened, by their StoreID.
    stores: HashMap<String, IMsgStore>,
}

impl Mapi {
    /// Logged on to the profile Outlook has open; None if MAPI can't be had.
    pub fn logon() -> Option<Mapi> {
        let api = api()?;
        let mut session: *mut c_void = std::ptr::null_mut();
        // Not a new session: the one Outlook shares, with its profile.
        let flags = MAPI_EXTENDED | MAPI_USE_DEFAULT | MAPI_NO_MAIL;
        let done = unsafe { (api.logon)(0, PCWSTR::null(), PCWSTR::null(), flags, &mut session) };
        if done.is_err() || session.is_null() {
            static TOLD: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
            if !TOLD.swap(true, std::sync::atomic::Ordering::Relaxed) {
                log::line(format!("[outlook] MAPI logon: {}", done.message()));
            }
            return None;
        }
        Some(Mapi { api, session, stores: HashMap::new() })
    }

    fn vtbl(&self) -> &SessionVtbl {
        unsafe { &**(self.session as *const *const SessionVtbl) }
    }

    fn store(&mut self, store_id: &str) -> Option<IMsgStore> {
        if let Some(s) = self.stores.get(store_id) {
            return Some(s.clone());
        }
        let id = hex(store_id)?;
        let mut raw: *mut c_void = std::ptr::null_mut();
        let open = self.vtbl().open_msg_store;
        let done = unsafe { open(self.session, 0, id.len() as u32, id.as_ptr().cast(), std::ptr::null(), MDB_NO_DIALOG | MDB_NO_MAIL, &mut raw) };
        if done.is_err() || raw.is_null() {
            return None;
        }
        let store = unsafe { IMsgStore::from_raw(raw) };
        self.stores.insert(store_id.to_string(), store.clone());
        Some(store)
    }

    /// The guarded fields of the email `entry_id` (hex, as Outlook's
    /// automation gives it) of the store `store_id`: the text up to `chars`
    /// characters, the headers only when asked.
    pub fn read(&mut self, store_id: &str, entry_id: &str, chars: usize, headers: bool) -> Option<Guarded> {
        let store = self.store(store_id)?;
        let entry = hex(entry_id)?;
        let mut kind = 0u32;
        let mut unknown: Option<IUnknown> = None;
        unsafe { store.OpenEntry(entry.len() as u32, entry.as_ptr().cast(), None, 0, &mut kind, &mut unknown) }.ok()?;
        // With no interface asked, MAPI gives the message's own (IMessage, an IMAPIProp).
        let message = unsafe { IMAPIProp::from_raw(unknown?.into_raw()) };
        let mut tags = vec![PR_SENDER_NAME, PR_SENDER_ADDRTYPE, PR_SENDER_EMAIL_ADDRESS, PR_SENDER_SMTP_ADDRESS];
        if chars > 0 {
            tags.push(PR_BODY);
        }
        if headers {
            tags.push(PR_TRANSPORT_MESSAGE_HEADERS);
        }
        let values = self.props(&message, &tags)?;
        let text = |tag: u32| values.get(&tag).and_then(|v| v.clone()).unwrap_or_default();
        let big = |tag: u32, limit: usize| match values.get(&tag) {
            Some(Some(t)) => t.clone(),
            Some(None) => stream_text(&message, tag, limit),
            None => String::new(),
        };
        let smtp = text(PR_SENDER_SMTP_ADDRESS);
        let plain = text(PR_SENDER_EMAIL_ADDRESS);
        let address = if !smtp.trim().is_empty() || text(PR_SENDER_ADDRTYPE).eq_ignore_ascii_case("EX") { smtp } else { plain };
        Some(Guarded {
            from: text(PR_SENDER_NAME).trim().to_string(),
            address: address.trim().to_string(),
            body: if chars > 0 { big(PR_BODY, chars) } else { String::new() },
            headers: if headers { big(PR_TRANSPORT_MESSAGE_HEADERS, HEADER_CHARS) } else { String::new() },
        })
    }

    /// The text properties `tags` asked at once: Some(text) when read, None
    /// when too long for that (read as a stream then), absent when missing.
    fn props(&self, message: &IMAPIProp, tags: &[u32]) -> Option<HashMap<u32, Option<String>>> {
        #[repr(C)]
        struct Tags {
            count: u32,
            tags: [u32; 8],
        }
        let mut asked = Tags { count: tags.len().min(8) as u32, tags: [0; 8] };
        asked.tags[..tags.len().min(8)].copy_from_slice(&tags[..tags.len().min(8)]);
        let mut count = 0u32;
        let mut array: *mut SPropValue = std::ptr::null_mut();
        let done = unsafe { message.GetProps((&mut asked as *mut Tags).cast::<SPropTagArray>(), 0, &mut count, &mut array) };
        if array.is_null() {
            return None;
        }
        let mut out = HashMap::new();
        if done.is_ok() {
            let values = unsafe { std::slice::from_raw_parts(array, count as usize) };
            for (asked, v) in tags.iter().zip(values) {
                let kind = v.ulPropTag & 0xFFFF;
                if kind == PT_UNICODE {
                    let text = unsafe { v.Value.lpszW.to_string() }.unwrap_or_default();
                    out.insert(*asked, Some(text));
                } else if kind == PT_ERROR && unsafe { v.Value.err } == MAPI_E_NOT_ENOUGH_MEMORY {
                    out.insert(*asked, None);
                }
            }
        }
        unsafe { (self.api.free)(array.cast()) };
        done.ok().map(|_| out)
    }
}

/// A text property too long for GetProps, read as a stream: at most `chars` characters.
fn stream_text(message: &IMAPIProp, tag: u32, chars: usize) -> String {
    let mut iid = IStream::IID;
    let mut unknown: Option<IUnknown> = None;
    // STGM_READ, no MAPI_MODIFY: only read.
    if unsafe { message.OpenProperty(tag, &mut iid, 0, 0, &mut unknown) }.is_err() {
        return String::new();
    }
    let Some(stream) = unknown.and_then(|u| u.cast::<IStream>().ok()) else { return String::new() };
    let mut units: Vec<u16> = Vec::new();
    let mut chunk = vec![0u16; 8192];
    while units.len() < chars {
        let mut read = 0u32;
        let asked = ((chars - units.len()).min(chunk.len()) * 2) as u32;
        let done = unsafe { stream.Read(chunk.as_mut_ptr().cast(), asked, Some(&mut read)) };
        if done.is_err() || read == 0 {
            break;
        }
        units.extend_from_slice(&chunk[..read as usize / 2]);
    }
    String::from_utf16_lossy(&units).trim_end_matches('\0').to_string()
}

impl Drop for Mapi {
    fn drop(&mut self) {
        self.stores.clear();
        let vtbl = self.vtbl();
        let (logoff, release) = (vtbl.logoff, vtbl.release);
        unsafe {
            let _ = logoff(self.session, 0, 0, 0);
            release(self.session);
        }
    }
}

/// Outlook's ids (EntryID, StoreID) are their bytes in hex.
fn hex(text: &str) -> Option<Vec<u8>> {
    let text = text.trim();
    if text.is_empty() || !text.len().is_multiple_of(2) {
        return None;
    }
    (0..text.len()).step_by(2).map(|i| u8::from_str_radix(text.get(i..i + 2)?, 16).ok()).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ids_from_hex() {
        assert_eq!(hex("00FF1a"), Some(vec![0, 255, 26]));
        assert_eq!(hex("0"), None);
        assert_eq!(hex(""), None);
        assert_eq!(hex("zz"), None);
    }
}

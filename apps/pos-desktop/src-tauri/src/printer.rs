//! The byte channel behind `escposPrinter` / `escposDrawer` (apps/pos-desktop/src/lib/devices.ts).
//! Two targets cover the common counter set-ups:
//! - `Network`: an Ethernet/Wi-Fi thermal printer on its raw port (usually 9100);
//! - `Windows`: a USB or serial printer installed in Windows, fed through the spooler as RAW data
//!   (the driver never re-renders the ESC/POS bytes).
//! Every call has a deadline; a printer that does not take the bytes is an error, never a hang.
//! Printing is never part of a sale (the sale is recorded first).

use serde::{Deserialize, Serialize};
use std::io::Write;
use std::net::{SocketAddr, TcpStream, ToSocketAddrs};
use std::time::Duration;

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum Target {
    Network { host: String, port: u16 },
    Windows { name: String },
}

/// Receipts are a few KB; anything far larger is a bug, not a receipt.
const MAX_BYTES: usize = 256 * 1024;

pub fn send(target: &Target, bytes: &[u8], timeout: Duration) -> Result<(), String> {
    if bytes.is_empty() || bytes.len() > MAX_BYTES {
        return Err(format!("Refusing to print {} bytes", bytes.len()));
    }
    match target {
        Target::Network { host, port } => send_tcp(host, *port, bytes, timeout),
        Target::Windows { name } => windows_raw::send(name, bytes),
    }
}

fn send_tcp(host: &str, port: u16, bytes: &[u8], timeout: Duration) -> Result<(), String> {
    let addrs: Vec<SocketAddr> = (host, port)
        .to_socket_addrs()
        .map_err(|e| format!("Printer address {host}:{port} not found: {e}"))?
        .collect();
    let mut last = format!("Printer {host}:{port} not reachable");
    for addr in addrs {
        match TcpStream::connect_timeout(&addr, timeout) {
            Ok(mut s) => {
                s.set_write_timeout(Some(timeout)).map_err(|e| e.to_string())?;
                s.write_all(bytes).map_err(|e| format!("The printer stopped taking data: {e}"))?;
                s.flush().map_err(|e| e.to_string())?;
                return Ok(());
            }
            Err(e) => last = format!("Printer {addr} not reachable: {e}"),
        }
    }
    Err(last)
}

/// Printers installed in Windows, for the set-up picker.
pub fn list_windows() -> Result<Vec<String>, String> {
    windows_raw::list()
}

#[cfg(windows)]
mod windows_raw {
    use std::ptr::{null, null_mut};
    use windows_sys::Win32::Foundation::{GetLastError, HANDLE};
    use windows_sys::Win32::Graphics::Printing::{
        ClosePrinter, EndDocPrinter, EndPagePrinter, EnumPrintersW, OpenPrinterW, StartDocPrinterW, StartPagePrinter,
        WritePrinter, DOC_INFO_1W, PRINTER_ENUM_CONNECTIONS, PRINTER_ENUM_LOCAL, PRINTER_INFO_4W,
    };

    fn wide(s: &str) -> Vec<u16> {
        s.encode_utf16().chain(std::iter::once(0)).collect()
    }

    fn last_error(what: &str) -> String {
        format!("{what} (Windows error {})", unsafe { GetLastError() })
    }

    struct Printer(HANDLE);
    impl Drop for Printer {
        fn drop(&mut self) {
            unsafe { ClosePrinter(self.0) };
        }
    }

    pub fn send(name: &str, bytes: &[u8]) -> Result<(), String> {
        let wname = wide(name);
        let mut h: HANDLE = null_mut();
        if unsafe { OpenPrinterW(wname.as_ptr(), &mut h, null()) } == 0 {
            return Err(last_error(&format!("Printer \"{name}\" not found")));
        }
        let printer = Printer(h);
        let doc_name = wide("Tilvara receipt");
        let datatype = wide("RAW");
        let doc = DOC_INFO_1W { pDocName: doc_name.as_ptr() as *mut u16, pOutputFile: null_mut(), pDatatype: datatype.as_ptr() as *mut u16 };
        if unsafe { StartDocPrinterW(printer.0, 1, &doc) } == 0 {
            return Err(last_error("The printer refused the job"));
        }
        let mut written: u32 = 0;
        let ok = unsafe {
            StartPagePrinter(printer.0) != 0
                && WritePrinter(printer.0, bytes.as_ptr().cast(), bytes.len() as u32, &mut written) != 0
        };
        let err = if !ok { Some(last_error("The printer stopped taking data")) } else { None };
        unsafe {
            EndPagePrinter(printer.0);
            EndDocPrinter(printer.0);
        }
        match err {
            Some(e) => Err(e),
            None if written as usize != bytes.len() => Err(format!("The printer took {written} of {} bytes", bytes.len())),
            None => Ok(()),
        }
    }

    pub fn list() -> Result<Vec<String>, String> {
        let flags = PRINTER_ENUM_LOCAL | PRINTER_ENUM_CONNECTIONS;
        let (mut needed, mut count) = (0u32, 0u32);
        unsafe { EnumPrintersW(flags, null(), 4, null_mut(), 0, &mut needed, &mut count) };
        if needed == 0 {
            return Ok(vec![]);
        }
        // u64 storage keeps PRINTER_INFO_4W suitably aligned.
        let mut buf = vec![0u64; (needed as usize).div_ceil(8)];
        if unsafe { EnumPrintersW(flags, null(), 4, buf.as_mut_ptr().cast(), needed, &mut needed, &mut count) } == 0 {
            return Err(last_error("Could not list printers"));
        }
        let infos = unsafe { std::slice::from_raw_parts(buf.as_ptr() as *const PRINTER_INFO_4W, count as usize) };
        Ok(infos
            .iter()
            .filter(|i| !i.pPrinterName.is_null())
            .map(|i| unsafe {
                let p = i.pPrinterName;
                let len = (0..).take_while(|&n| *p.add(n) != 0).count();
                String::from_utf16_lossy(std::slice::from_raw_parts(p, len))
            })
            .collect())
    }
}

#[cfg(not(windows))]
mod windows_raw {
    pub fn send(_name: &str, _bytes: &[u8]) -> Result<(), String> {
        Err("Windows printers are only available on Windows".into())
    }
    pub fn list() -> Result<Vec<String>, String> {
        Ok(vec![])
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Read;
    use std::net::TcpListener;

    #[test]
    fn sends_all_bytes_to_a_network_printer() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let reader = std::thread::spawn(move || {
            let (mut s, _) = listener.accept().unwrap();
            let mut got = Vec::new();
            s.read_to_end(&mut got).unwrap();
            got
        });
        let bytes: Vec<u8> = (0..5000u32).map(|i| (i % 251) as u8).collect();
        send(&Target::Network { host: "127.0.0.1".into(), port }, &bytes, Duration::from_secs(2)).unwrap();
        assert_eq!(reader.join().unwrap(), bytes);
    }

    #[test]
    fn a_dead_printer_is_an_error_not_a_hang() {
        // Bind then drop: nothing listens on this port.
        let port = TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port();
        let started = std::time::Instant::now();
        let e = send(&Target::Network { host: "127.0.0.1".into(), port }, b"\x1b@", Duration::from_millis(500)).unwrap_err();
        assert!(e.contains("not reachable"), "{e}");
        assert!(started.elapsed() < Duration::from_secs(3));
    }

    #[test]
    fn refuses_empty_and_oversized_jobs_and_unknown_windows_printers() {
        let t = Target::Network { host: "127.0.0.1".into(), port: 9 };
        assert!(send(&t, b"", Duration::from_millis(100)).is_err());
        assert!(send(&t, &vec![0u8; MAX_BYTES + 1], Duration::from_millis(100)).is_err());
        let e = send(&Target::Windows { name: "No Such Printer Tilvara".into() }, b"\x1b@", Duration::from_millis(100)).unwrap_err();
        assert!(e.contains("not found") || e.contains("only available"), "{e}");
    }

    #[test]
    fn targets_round_trip_as_tagged_json() {
        let t: Target = serde_json::from_str(r#"{"kind":"network","host":"10.0.0.9","port":9100}"#).unwrap();
        assert_eq!(t, Target::Network { host: "10.0.0.9".into(), port: 9100 });
        let w: Target = serde_json::from_str(r#"{"kind":"windows","name":"POS-80"}"#).unwrap();
        assert_eq!(w, Target::Windows { name: "POS-80".into() });
    }
}

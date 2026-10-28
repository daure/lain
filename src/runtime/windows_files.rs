use std::{
    ffi::c_void,
    fs::File,
    io,
    os::windows::{
        ffi::OsStrExt,
        io::{AsRawHandle, FromRawHandle},
    },
    path::Path,
    ptr,
};

use windows_sys::Win32::{
    Foundation::{GENERIC_READ, GENERIC_WRITE, INVALID_HANDLE_VALUE, LocalFree},
    Security::{
        Authorization::{
            ConvertSecurityDescriptorToStringSecurityDescriptorW,
            ConvertStringSecurityDescriptorToSecurityDescriptorW, GetSecurityInfo, SE_FILE_OBJECT,
        },
        DACL_SECURITY_INFORMATION, SECURITY_ATTRIBUTES,
    },
    Storage::FileSystem::{
        BY_HANDLE_FILE_INFORMATION, CREATE_NEW, CreateDirectoryW, CreateFileW,
        FILE_FLAG_BACKUP_SEMANTICS, FILE_FLAG_OPEN_REPARSE_POINT, FILE_SHARE_DELETE,
        FILE_SHARE_READ, FILE_SHARE_WRITE, GetFileInformationByHandle, MOVEFILE_REPLACE_EXISTING,
        MOVEFILE_WRITE_THROUGH, MoveFileExW, OPEN_EXISTING,
    },
};

fn wide(path: &Path) -> io::Result<Vec<u16>> {
    let value: Vec<u16> = path.as_os_str().encode_wide().collect();
    if value.contains(&0) {
        return Err(io::Error::other("path contains a null character"));
    }
    Ok(value.into_iter().chain([0]).collect())
}

struct LocalAllocation(*mut c_void);

impl Drop for LocalAllocation {
    fn drop(&mut self) {
        // Windows allocates security descriptors and SDDL strings with LocalAlloc.
        unsafe {
            LocalFree(self.0);
        }
    }
}

fn security(directory: bool) -> io::Result<LocalAllocation> {
    let sddl = if directory {
        "D:P(A;OICI;FA;;;SY)(A;OICI;FA;;;OW)"
    } else {
        "D:P(A;;FA;;;SY)(A;;FA;;;OW)"
    };
    let sddl: Vec<u16> = sddl.encode_utf16().chain([0]).collect();
    let mut descriptor = ptr::null_mut();
    // The descriptor grants full access only to SYSTEM and the object's owner.
    if unsafe {
        ConvertStringSecurityDescriptorToSecurityDescriptorW(
            sddl.as_ptr(),
            1,
            &mut descriptor,
            ptr::null_mut(),
        )
    } == 0
    {
        return Err(io::Error::last_os_error());
    }
    Ok(LocalAllocation(descriptor))
}

pub(super) fn create_directory(path: &Path) -> io::Result<()> {
    if path.try_exists()? {
        return Ok(());
    }
    if let Some(parent) = path.parent()
        && !parent.exists()
    {
        create_directory(parent)?;
    }
    let descriptor = security(true)?;
    let attributes = SECURITY_ATTRIBUTES {
        nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32,
        lpSecurityDescriptor: descriptor.0,
        bInheritHandle: 0,
    };
    let path = wide(path)?;
    // The directory starts private; there is no create-then-tighten ACL window.
    if unsafe { CreateDirectoryW(path.as_ptr(), &attributes) } == 0 {
        let error = io::Error::last_os_error();
        if error.kind() != io::ErrorKind::AlreadyExists {
            return Err(error);
        }
    }
    Ok(())
}

pub(super) fn open_private(path: &Path, writable: bool, create_new: bool) -> io::Result<File> {
    let descriptor = security(false)?;
    let attributes = SECURITY_ATTRIBUTES {
        nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32,
        lpSecurityDescriptor: descriptor.0,
        bInheritHandle: 0,
    };
    let path = wide(path)?;
    // OPEN_REPARSE_POINT opens the link itself so validation never follows it.
    let handle = unsafe {
        CreateFileW(
            path.as_ptr(),
            GENERIC_READ | if writable { GENERIC_WRITE } else { 0 },
            FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
            &attributes,
            if create_new {
                CREATE_NEW
            } else {
                OPEN_EXISTING
            },
            FILE_FLAG_OPEN_REPARSE_POINT,
            ptr::null_mut(),
        )
    };
    if handle == INVALID_HANDLE_VALUE {
        return Err(io::Error::last_os_error());
    }
    // CreateFileW transfers this handle to the File, which closes it on drop.
    Ok(unsafe { File::from_raw_handle(handle) })
}

pub(super) fn check_directory(path: &Path) -> io::Result<()> {
    let path = wide(path)?;
    let handle = unsafe {
        CreateFileW(
            path.as_ptr(),
            GENERIC_READ,
            FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
            ptr::null(),
            OPEN_EXISTING,
            FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT,
            ptr::null_mut(),
        )
    };
    if handle == INVALID_HANDLE_VALUE {
        return Err(io::Error::last_os_error());
    }
    let file = unsafe { File::from_raw_handle(handle) };
    check_file(&file)
}

pub(super) fn check_file(file: &File) -> io::Result<()> {
    let mut descriptor = ptr::null_mut();
    let status = unsafe {
        GetSecurityInfo(
            file.as_raw_handle(),
            SE_FILE_OBJECT,
            DACL_SECURITY_INFORMATION,
            ptr::null_mut(),
            ptr::null_mut(),
            ptr::null_mut(),
            ptr::null_mut(),
            &mut descriptor,
        )
    };
    if status != 0 {
        return Err(io::Error::from_raw_os_error(status as i32));
    }
    let descriptor = LocalAllocation(descriptor);
    let mut text = ptr::null_mut();
    let mut length = 0;
    if unsafe {
        ConvertSecurityDescriptorToStringSecurityDescriptorW(
            descriptor.0,
            1,
            DACL_SECURITY_INFORMATION,
            &mut text,
            &mut length,
        )
    } == 0
    {
        return Err(io::Error::last_os_error());
    }
    let allocation = LocalAllocation(text.cast());
    let sddl = String::from_utf16_lossy(unsafe {
        std::slice::from_raw_parts(text, length.saturating_sub(1) as usize)
    });
    drop(allocation);
    let entries: Vec<_> = sddl
        .split('(')
        .skip(1)
        .map(|entry| entry.trim_end_matches(')'))
        .collect();
    let mut principals = Vec::new();
    for entry in &entries {
        let fields: Vec<_> = entry.split(';').collect();
        if fields.len() != 6
            || fields[0] != "A"
            || fields[2] != "FA"
            || !matches!(fields[5], "SY" | "OW")
        {
            return Err(io::Error::other(
                "state must have an owner-only Windows ACL",
            ));
        }
        principals.push(fields[5]);
    }
    principals.sort_unstable();
    if principals != ["OW", "SY"] {
        return Err(io::Error::other(
            "state must have an owner-only Windows ACL",
        ));
    }
    Ok(())
}

fn information(file: &File) -> io::Result<BY_HANDLE_FILE_INFORMATION> {
    let mut info = std::mem::MaybeUninit::uninit();
    if unsafe { GetFileInformationByHandle(file.as_raw_handle(), info.as_mut_ptr()) } == 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(unsafe { info.assume_init() })
}

pub(super) fn link_count(file: &File) -> io::Result<u64> {
    Ok(information(file)?.nNumberOfLinks.into())
}

pub(super) fn identity(file: &File) -> io::Result<(u64, u64)> {
    let info = information(file)?;
    Ok((
        info.dwVolumeSerialNumber.into(),
        (u64::from(info.nFileIndexHigh) << 32) | u64::from(info.nFileIndexLow),
    ))
}

pub(super) fn replace_file(source: &Path, destination: &Path) -> io::Result<()> {
    if unsafe {
        MoveFileExW(
            wide(source)?.as_ptr(),
            wide(destination)?.as_ptr(),
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
        )
    } == 0
    {
        return Err(io::Error::last_os_error());
    }
    Ok(())
}
